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

function buildStrategyEntry(underlying, closeDate, rows, stratType) {
  const pnl = +rows.reduce((s, r) => s + (r.gain_loss || 0), 0).toFixed(2);
  const openDates = rows.map(r => (r.open_date || '').slice(0, 10)).filter(Boolean).sort();
  const openDate = openDates[0] || closeDate;
  const openValue = +rows.reduce((s, r) => s + (r.quantity < 0 ? (r.proceeds || 0) : -(r.cost || 0)), 0).toFixed(2);
  const closeValue = +(pnl - openValue).toFixed(2);
  return {
    key: `broker-${underlying}-${closeDate}-${rows.map(r => r.symbol).join('_')}`,
    underlying,
    openDate,
    closeDate,
    closeExecAt: null,
    desc: 'Reconciliado del historial real de Tradier (sin order-id — agrupado por cercanía de strike, ver src/tradier_closed_pnl_adapter.js)',
    stratType,
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
