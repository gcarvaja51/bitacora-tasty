'use strict';

// Bitacora Tradier — Etapa 5 (Posiciones). Mismo concepto de agrupacion que
// groupPositions() (index.html) — por (subyacente, vencimiento) para que un
// Iron Condor con puts+calls quede en una sola fila — pero contra el
// esquema crudo de Tradier (parseOccSymbol, quantity con signo) en vez del
// de TastyTrade. Funcion pura, sin I/O — server.js resuelve
// posiciones/cotizaciones y se las pasa ya armadas.
//
// Simplificacion deliberada: sin Greeks (delta/theta) — Tradier no expone
// un endpoint de Greeks como el fallback Black-Scholes que ya tiene
// TastyTradeClient, y agregarlo es trabajo nuevo no scopeado en esta etapa.
// Se documenta como limitacion, no se inventa un valor.

const { parseOccSymbol } = require('./bp_tradier_adapter');

// entradaRealMap (2026-08-20): { [option_symbol]: precio de entrada por accion
// segun la CADENA REAL de opciones }. Ver construirEntradaRealMap en server.js.
//
// Por que hace falta: `avgPrice` salia de `cost_basis`, o sea del fill del
// sandbox de Tradier, que llena contra un libro de ~15 min de atraso. Las
// cotizaciones de esta misma pantalla ya se piden en vivo a TastyTrade desde el
// 2026-08-17, asi que el P&L no realizado se calculaba con el valor de AHORA
// contra un costo de hace un cuarto de hora — mezclando las dos fuentes dentro
// del mismo numero.
//
// Consecuencia concreta: la pestana Posiciones y el KPI "P&L No Realizado" del
// Dashboard mostraban una cifra distinta de la que mostraba Historial para la
// MISMA posicion abierta (Historial ya usa baseDePrecio, la entrada de la cadena
// real). Dos pantallas, dos numeros, la misma posicion.
//
// Si un simbolo no esta en el mapa (posiciones de La Rueda, o adoptadas sin
// marca propia) se cae a cost_basis como antes — no se pierde ninguna fila.
function groupPositionsTradier(positions = [], quotesMap = {}, entradaRealMap = {}) {
  const map = new Map();
  for (const p of positions) {
    const parsed  = parseOccSymbol(p.symbol || '');
    const isStock = !parsed;
    const und     = isStock ? (p.symbol || '') : parsed.root;
    const exp     = isStock ? '' : parsed.expiry;
    const key     = isStock ? `${und}::stock` : `${und}::${exp}`;
    const openDate = p.date_acquired ? p.date_acquired.slice(0, 10) : '—';

    if (!map.has(key)) {
      map.set(key, { underlying: und, expiry: exp || null, isStock, legs: [], unrealizedPnL: 0, premiumNet: 0, openDate, totalQty: 0, netDelta: null, netTheta: null });
    }
    const g = map.get(key);

    const qtySigned = parseFloat(p.quantity || 0); // signo: negativo = short
    const mul = isStock ? 1 : 100;
    const costBasis = parseFloat(p.cost_basis || 0); // monto TOTAL de la posicion (no por accion)
    const avgTradier = Math.abs(qtySigned) > 0 ? Math.abs(costBasis) / (Math.abs(qtySigned) * mul) : 0;
    const entradaReal = entradaRealMap[p.symbol];
    const avgPrice = Number.isFinite(entradaReal) ? entradaReal : avgTradier;
    if (Number.isFinite(entradaReal)) g.entradaFuente = 'cadena_real';
    else if (g.entradaFuente !== 'cadena_real') g.entradaFuente = 'tradier_fill';
    const q = quotesMap[p.symbol] || {};
    const mark = q.mark != null ? q.mark : 0;

    g.legs.push({ ...p, ...(parsed || {}), avgPrice, avgTradier, mark, isShort: qtySigned < 0, delta: q.delta ?? null, theta: q.theta ?? null });
    g.currentPrice = mark;
    g.totalQty += qtySigned;

    // Delta/Theta NETOS de la posicion (2026-08-03) — se suma la griega de cada
    // pata multiplicada por su cantidad CON SIGNO: una pata corta invierte el
    // signo de su delta. Ej. Iron Condor: call corta (delta +) y put corta
    // (delta -) se cancelan, dando un neto cercano a 0 = posicion neutral, que
    // es justamente la tesis de la estructura.
    // Se deja en null (no en 0) si Tradier no devolvio griegas -- un 0 se leeria
    // como "posicion neutral" cuando en realidad es "sin dato".
    if (q.delta != null) g.netDelta = (g.netDelta || 0) + q.delta * qtySigned;
    if (q.theta != null) g.netTheta = (g.netTheta || 0) + q.theta * qtySigned;

    const posDir = qtySigned < 0 ? -1 : 1;
    g.unrealizedPnL += posDir * (mark - avgPrice) * Math.abs(qtySigned) * mul;
    if (qtySigned < 0) g.premiumNet += avgPrice * Math.abs(qtySigned) * mul;
    else                g.premiumNet -= avgPrice * Math.abs(qtySigned) * mul;
  }
  return [...map.values()]
    .flatMap(separarPosicionesIndependientes)
    .sort((a, b) => a.underlying.localeCompare(b.underlying));
}

// ── Separar posiciones independientes que comparten vencimiento (2026-08-04) ──
//
// La clave de agrupación es `subyacente::vencimiento`, que es lo correcto para
// detectar estructuras (una vertical, un cóndor y un strangle son justamente
// varias patas del mismo subyacente y vencimiento). Pero mete en la misma bolsa
// dos posiciones que NO tienen nada que ver entre sí.
//
// Caso real que lo destapó: dos Puts vendidos de ANET, strikes 160 y 165, ambos
// al 4-sep — dos ciclos independientes de La Rueda que la bitácora mostraba como
// un solo trade ("Put Spread"), con el P&L y el % capturado mezclados. Y peor: el
// botón de cierre manual opera sobre TODAS las patas del grupo, así que habría
// cerrado los dos de golpe cuando lo que se quería era cerrar uno.
//
// El discriminador es la dirección: una vertical real SIEMPRE tiene una pata
// vendida y otra comprada. Si todas las patas son del mismo tipo (todas puts o
// todas calls) Y todas van en la misma dirección, no son una estructura: son
// posiciones sueltas que coinciden en fecha. Se separan por strike.
//
// Lo que NO se toca (siguen siendo una posición sola, correctamente):
//   - verticales      -> una corta + una larga
//   - iron condors    -> mezcla de tipos y direcciones
//   - strangles       -> dos cortas pero de tipo DISTINTO (put + call)
//   - acciones        -> nunca entran acá
function separarPosicionesIndependientes(g) {
  if (g.isStock || g.legs.length < 2) return [g];
  const tipos = new Set(g.legs.map(l => l.optType));
  const dirs  = new Set(g.legs.map(l => !!l.isShort));
  if (tipos.size !== 1 || dirs.size !== 1) return [g];

  // Una fila por strike, recalculando los agregados desde sus propias patas.
  const porStrike = new Map();
  for (const l of g.legs) {
    if (!porStrike.has(l.strike)) porStrike.set(l.strike, []);
    porStrike.get(l.strike).push(l);
  }
  if (porStrike.size < 2) return [g];

  return [...porStrike.values()].map(legs => {
    const nuevo = { ...g, legs, unrealizedPnL: 0, premiumNet: 0, totalQty: 0, netDelta: null, netTheta: null };
    for (const l of legs) {
      const qty = parseFloat(l.quantity || 0);
      const mul = 100;
      nuevo.totalQty += qty;
      if (l.delta != null) nuevo.netDelta = (nuevo.netDelta || 0) + l.delta * qty;
      if (l.theta != null) nuevo.netTheta = (nuevo.netTheta || 0) + l.theta * qty;
      nuevo.unrealizedPnL += (qty < 0 ? -1 : 1) * (l.mark - l.avgPrice) * Math.abs(qty) * mul;
      nuevo.premiumNet    += (qty < 0 ? 1 : -1) * l.avgPrice * Math.abs(qty) * mul;
    }
    // La fecha de apertura del grupo era la de la primera pata que llegó; cada
    // posición suelta tiene la suya.
    nuevo.openDate = legs[0].date_acquired ? legs[0].date_acquired.slice(0, 10) : g.openDate;
    nuevo.currentPrice = legs[0].mark;
    return nuevo;
  });
}

function strategyTypeTradier(g) {
  if (g.isStock) return 'Acciones';
  const legs = g.legs;
  const puts  = legs.filter(l => l.optType === 'P');
  const calls = legs.filter(l => l.optType === 'C');
  if (legs.length === 1) return (puts.length ? 'Put' : 'Call') + (legs[0].isShort ? ' Vendida' : ' Comprada');
  if (legs.length === 2 && puts.length === 2)  return 'Put Spread';
  if (legs.length === 2 && calls.length === 2) return 'Call Spread';
  if (legs.length === 4 && puts.length === 2 && calls.length === 2) return 'Iron Condor';
  return `Spread (${legs.length}p)`;
}

module.exports = { groupPositionsTradier, strategyTypeTradier };
