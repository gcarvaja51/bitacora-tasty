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

function groupPositionsTradier(positions = [], quotesMap = {}) {
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
    const avgPrice = Math.abs(qtySigned) > 0 ? Math.abs(costBasis) / (Math.abs(qtySigned) * mul) : 0;
    const q = quotesMap[p.symbol] || {};
    const mark = q.mark != null ? q.mark : 0;

    g.legs.push({ ...p, ...(parsed || {}), avgPrice, mark, isShort: qtySigned < 0, delta: q.delta ?? null, theta: q.theta ?? null });
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
  return [...map.values()].sort((a, b) => a.underlying.localeCompare(b.underlying));
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
