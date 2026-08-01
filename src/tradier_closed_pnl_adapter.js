'use strict';

// Bitacora Tradier — reconciliacion del historial REAL de Tradier
// (tradier.getClosedPnl(), P&L ya realizado por el broker) contra lo que
// tradier_executions.json/wheel_trading_executions.json ya trackean.
//
// Por que hace falta: getClosedPnl() da P&L por PATA individual, sin
// order-id — a diferencia de TastyTrade, Tradier no expone que patas
// pertenecen a la misma orden. Probado en vivo (2026-07-24, lectura de solo
// lectura): /orders y /history con rango de fechas vienen vacios en este
// sandbox, asi que getClosedPnl es la UNICA fuente real disponible para
// reconstruir el historial completo.
//
// Heuristico de agrupacion (sin order-id, mejor esfuerzo — documentado, no
// se inventa certeza que no existe): dentro de un mismo (subyacente, fecha
// de cierre, tipo de opcion), se empareja cada pata corta con la pata larga
// de strike MAS CERCANO todavia sin usar. Funciona bien en la practica
// porque los anchos de spread de este sistema son sistematicos (10/20pts) —
// dos spreads independientes el mismo dia rara vez intercalan sus strikes
// de forma que el emparejamiento por cercania se equivoque. Una pata corta
// sin pareja se registra como venta naked (CSP/Short Call); un long sin
// pareja, como compra suelta.
//
// Funcion pura, sin I/O.

const { parseOccSymbol } = require('./bp_tradier_adapter');
const { SPX_FEE_PER_CONTRACT_PER_LEG, EQUITY_FEE_PER_CONTRACT_PER_LEG } = require('./broker_fees');

// Claves "symbol|closeDate" ya cubiertas por ejecuciones trackeadas — para
// no duplicar su P&L al reconciliar. Mismo criterio de conteo (no de
// identidad exacta) que ya usa checkTradierExecutionsImpl para el mismo
// tipo de problema (Tradier no ata cada fila de gainloss a una operacion
// especifica).
function trackedLegKeys(spxExecutions = [], wheelExecutions = []) {
  const keys = [];
  for (const ex of spxExecutions) {
    if (!ex.closedAt || !ex.legs) continue;
    const closeDate = ex.closedAt.slice(0, 10);
    for (const sym of Object.values(ex.legs)) {
      if (sym) keys.push(`${sym}|${closeDate}`);
    }
  }
  for (const ex of wheelExecutions) {
    if (ex.phase !== 'CERRADO' || !ex.leg || !ex.leg.optionSymbol) continue;
    // Sin closedAt limpio en wheel_trading_executions.json (misma limitacion
    // documentada en src/metrics_tradier.js) — se aproxima con el vencimiento.
    keys.push(`${ex.leg.optionSymbol}|${ex.leg.expiry}`);
  }
  return keys;
}

function classifySpread(optType, shortStrike, longStrike) {
  if (optType === 'P') return shortStrike > longStrike ? 'Bull Put Spread' : 'Bear Put Spread';
  return shortStrike < longStrike ? 'Bear Call Spread' : 'Bull Call Spread';
}

// Direccion inferida del tipo de estrategia (2026-08-01, a pedido del usuario
// — "hay datos vacios, traelos todos") — a diferencia del strategyFamily real
// (TENDENCIA/NEUTRAL/REVERSION, indistinguible sin el signalId original, ver
// comentario en reconcileClosedPnl), la direccion SI se puede inferir del
// tipo de spread/leg sin ambiguedad: vender un put o comprar un call es
// alcista, vender un call o comprar un put es bajista.
const DIRECCION_POR_TIPO = {
  'Bull Call Spread': 'BULLISH', 'Bull Put Spread': 'BULLISH',
  'Bear Call Spread': 'BEARISH', 'Bear Put Spread': 'BEARISH',
  'Long Call': 'BULLISH', 'Short Put': 'BULLISH',
  'Long Put': 'BEARISH', 'Short Call': 'BEARISH',
};

function buildStrategyEntry(underlying, closeDate, rows, stratType) {
  const pnl = +rows.reduce((s, r) => s + (r.gain_loss || 0), 0).toFixed(2);
  const openDates = rows.map(r => (r.open_date || '').slice(0, 10)).filter(Boolean).sort();
  const openDate = openDates[0] || closeDate;
  const openValue = +rows.reduce((s, r) => s + (r.quantity < 0 ? (r.proceeds || 0) : -(r.cost || 0)), 0).toFixed(2);
  const closeValue = +(pnl - openValue).toFixed(2);
  // Strikes reales (2026-08-01) — ya vienen parseados del symbol OCC (row.parsed,
  // armado en reconcileClosedPnl vía parseOccSymbol) para toda fila que no sea
  // "Acciones"; se arma {shortStrike, longStrike} igual forma que usa el resto
  // del sistema (findStrikesByDelta, etc.) para poder reusar el mismo render.
  const short = rows.find(r => r.quantity < 0);
  const long  = rows.find(r => r.quantity > 0);
  const strikes = (short?.parsed || long?.parsed)
    ? { shortStrike: short?.parsed?.strike ?? null, longStrike: long?.parsed?.strike ?? null }
    : null;
  // Comision estimada (2026-08-01, misma idea que estimateSpxCommission de
  // src/broker_fees.js, pero calculada directo sobre las patas REALES de esta
  // reconciliacion en vez de asumir "legsForStrategy() x contracts uniforme"
  // — mas preciso porque ya tenemos la cantidad real de cada pata (row.quantity)
  // y no hay forma de que estas estrategias reconciliadas tengan un ex.contracts
  // guardado en ningun lado. Se omite para acciones (Tradier no cobra comision
  // por acciones en este plan, a diferencia de opciones).
  const esSpx = underlying === 'SPXW' || underlying === 'SPX';
  const feePerContrato = esSpx ? SPX_FEE_PER_CONTRACT_PER_LEG : EQUITY_FEE_PER_CONTRACT_PER_LEG;
  const totalContratos = rows.reduce((s, r) => s + Math.abs(r.quantity || 0), 0);
  const commissionEstimate = strikes ? +(feePerContrato * totalContratos * 2).toFixed(2) : 0;
  // strategyFamily (2026-08-01, a pedido del usuario: "necesito que se defina
  // si es reversion, direccional, neutral, rueda... traelo de donde sea") —
  // solo se puede inferir con certeza en un caso: cualquier ticker que NO sea
  // SPX/SPXW SOLO lo opera el pipeline de la Rueda (los otros 3 — Direccional/
  // Neutral/Reversion — son exclusivos de SPX/SPXW, ver CLAUDE.md). Para
  // SPX/SPXW reconciliado sin registro local, Direccional/Reversion/Neutral
  // usan el MISMO literal de estrategia (BULL_PUT_SPREAD, etc. — documentado
  // explicitamente) y esta reconciliacion no agrupa las 4 patas de un Iron
  // Condor como una sola entidad (cada lado, P y C, cae en su propio bucket
  // de vertical) — no hay forma honesta de distinguir entre esas 3 sin la
  // senal original (spx_signals.json solo guarda las ultimas 50, no alcanza
  // para historial viejo). Se deja null en ese caso — no se inventa.
  const strategyFamily = esSpx ? null : 'RUEDA';
  return {
    // Bug real encontrado el 2026-08-01 (el usuario reporto un "trade de
    // -$5,550" que no existia): esta key solo incluia el/los symbol(s), sin
    // el gain_loss -- cuando el MISMO symbol se cierra varias veces el mismo
    // dia con resultados DISTINTOS (ej. 4 cierres reales de
    // SPXW260731C07460000 con -$2,560/-$2,710/-$60/-$220, comprado 4 veces al
    // mismo precio y cerrado en 4 momentos distintos), las 4 estrategias
    // generaban la MISMA key -- consolidateStrategies (frontend) las
    // deduplicaba por key y SUMABA sus pnl en una sola fila (-$5,550),
    // mostrando un "trade" que nunca existio. Se agrega gain_loss de cada
    // fila a la key para que cierres distintos del mismo symbol/dia nunca
    // colisionen.
    key: `broker-${underlying}-${closeDate}-${rows.map(r => `${r.symbol}:${r.gain_loss}`).join('_')}`,
    underlying,
    openDate,
    closeDate,
    closeExecAt: null,
    desc: 'Reconciliado del historial real de Tradier (sin order-id — agrupado por cercanía de strike, ver src/tradier_closed_pnl_adapter.js)',
    stratType,
    direction: DIRECCION_POR_TIPO[stratType] || null,
    strikes,
    strategyFamily,
    commissionEstimate,
    openValue,
    closeValue,
    pnl,
    amPm: null,
    durationDays: Math.round((new Date(closeDate) - new Date(openDate)) / 86400000),
    durationCat: openDate === closeDate ? 'Intradía' : '1-7 días',
    win: pnl > 0,
  };
}

function reconcileClosedPnl(closedPnlRows = [], trackedKeys = []) {
  const trackedCount = {};
  trackedKeys.forEach(k => { trackedCount[k] = (trackedCount[k] || 0) + 1; });

  const remaining = [];
  for (const row of closedPnlRows) {
    const closeDate = (row.close_date || '').slice(0, 10);
    const key = `${row.symbol}|${closeDate}`;
    if (trackedCount[key] > 0) { trackedCount[key]--; continue; }
    remaining.push(row);
  }

  const buckets = {};
  for (const row of remaining) {
    const parsed = parseOccSymbol(row.symbol || '');
    const isStock = !parsed;
    const root = isStock ? row.symbol : parsed.root;
    const closeDate = (row.close_date || '').slice(0, 10);
    const optType = isStock ? 'STOCK' : parsed.optType;
    const key = `${root}|${closeDate}|${optType}`;
    (buckets[key] = buckets[key] || []).push({ ...row, parsed, isStock, root, closeDate });
  }

  const strategies = [];
  for (const rows of Object.values(buckets)) {
    const { root, closeDate, isStock } = rows[0];
    if (isStock) {
      for (const row of rows) strategies.push(buildStrategyEntry(root, closeDate, [row], 'Acciones'));
      continue;
    }
    const optType = rows[0].parsed.optType;
    const shorts = rows.filter(r => r.quantity < 0).sort((a, b) => a.parsed.strike - b.parsed.strike);
    const longs  = rows.filter(r => r.quantity > 0).sort((a, b) => a.parsed.strike - b.parsed.strike);
    const usedLongs = new Set();

    for (const s of shorts) {
      let bestIdx = -1, bestDist = Infinity;
      longs.forEach((l, i) => {
        if (usedLongs.has(i)) return;
        const dist = Math.abs(l.parsed.strike - s.parsed.strike);
        if (dist < bestDist) { bestDist = dist; bestIdx = i; }
      });
      if (bestIdx >= 0) {
        usedLongs.add(bestIdx);
        const l = longs[bestIdx];
        strategies.push(buildStrategyEntry(root, closeDate, [s, l], classifySpread(optType, s.parsed.strike, l.parsed.strike)));
      } else {
        strategies.push(buildStrategyEntry(root, closeDate, [s], optType === 'P' ? 'Short Put' : 'Short Call'));
      }
    }
    longs.forEach((l, i) => {
      if (!usedLongs.has(i)) strategies.push(buildStrategyEntry(root, closeDate, [l], optType === 'P' ? 'Long Put' : 'Long Call'));
    });
  }

  return strategies;
}

module.exports = { reconcileClosedPnl, trackedLegKeys };
