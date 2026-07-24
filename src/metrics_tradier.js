'use strict';

// Bitacora Tradier — Etapa 4. Tradier no expone un ledger plano de
// transacciones como TastyTrade (tt.getAllTransactions) — lo mas cercano es
// getClosedPnl()/getOrders(), sin la granularidad de patas/ordenes que
// necesitaria buildMetrics() (src/metrics.js) para su FIFO. En vez de intentar
// reconstruir eso, esta funcion parte de datos YA normalizados que el propio
// sistema arma trade por trade en vivo (tradier_executions.json — SPX 0DTE/1DTE
// direccional/Iron Condor/Reversion — y wheel_trading_executions.json — ciclos
// de la Rueda): cada registro cerrado ya es una "estrategia" completa con P&L
// real, no hace falta FIFO. Se reimplementa solo la mitad de agregacion de
// buildMetrics() (metrics.js lineas 383-499, ya identificada como
// broker-agnostica) contra esta forma normalizada — no se toca metrics.js.
//
// Salida: MISMA forma que buildMetrics(), para que loadHistory/loadReports/
// loadCalendar (portados de index.html) se reusen sin reescribir su logica
// de presentacion.

function getDurationCat(openDate, closeDate) {
  const days = Math.round((new Date(closeDate) - new Date(openDate)) / 86400000);
  if (days === 0) return 'Intradía';
  if (days <= 7)  return '1-7 días';
  if (days <= 30) return '1-4 semanas';
  return '> 1 mes';
}

function getAmPm(isoStr) {
  if (!isoStr) return null;
  const h = new Date(isoStr).getUTCHours();
  return h < 13 ? 'AM (9-12h)' : 'PM (12-16h)';
}

function weekKey(dateStr) {
  if (!dateStr) return '';
  const d    = new Date(dateStr + 'T12:00:00Z');
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - jan1) / 86400000) + jan1.getUTCDay() + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// tradier_executions.json — SPX 0DTE/1DTE (direccional/Iron Condor/Reversion).
// Solo cerrados con pnl numerico ya asentado (pnlSource confirmado o
// reconciliado) — 'pendiente_verificar' se excluye a proposito, mismo
// criterio que ya usa el dashboard "Demo Tradier".
function mapSpxExecution(ex) {
  if (ex.status !== 'closed' || typeof ex.pnl !== 'number') return null;
  const contracts     = ex.contracts || 1;
  const entryPremium  = Math.abs(ex.entryFillPrice ?? ex.creditReceived ?? 0) * 100 * contracts;
  const openValue     = ex.isCredit === false ? -entryPremium : entryPremium;
  const closeValue    = +(ex.pnl - openValue).toFixed(2);
  const openDate      = (ex.filledAt || ex.timestamp || '').slice(0, 10);
  const closeDate     = (ex.closedAt || ex.timestamp || '').slice(0, 10);
  if (!openDate || !closeDate) return null;
  return {
    key:          ex.id,
    underlying:   'SPX',
    openDate,
    closeDate,
    closeExecAt:  ex.closedAt || null,
    desc:         ex.strategyFamily ? `${ex.strategyFamily} · ${ex.direction || ''}`.trim() : null,
    stratType:    ex.strategy || 'Otro',
    openValue:    +openValue.toFixed(2),
    closeValue,
    pnl:          +ex.pnl.toFixed(2),
    amPm:         getAmPm(ex.filledAt || ex.timestamp),
    durationDays: Math.round((new Date(closeDate) - new Date(openDate)) / 86400000),
    durationCat:  getDurationCat(openDate, closeDate),
    win:          ex.pnl > 0,
  };
}

// wheel_trading_executions.json — ciclos de la Rueda. Simplificacion conocida,
// sin validar contra un ciclo real todavia (vacio al momento de escribir esto):
// el pnl es SOLO la prima acumulada (totalCreditAccumulated) — no incluye la
// variacion del precio de las acciones mientras se mantuvieron entre CSP y CC,
// que el sistema hoy no trackea como P&L separado. Tampoco hay un campo
// closedAt explicito — se usa el vencimiento del ultimo leg conocido como
// mejor proxy disponible de fecha de cierre.
function mapWheelExecution(ex) {
  if (ex.phase !== 'CERRADO') return null;
  const pnl      = ex.totalCreditAccumulated ?? ex.creditReceived ?? 0;
  const openDate = (ex.timestamp || '').slice(0, 10);
  const closeDate = (ex.leg && ex.leg.expiry) || openDate;
  if (!openDate) return null;
  return {
    key:          ex.id,
    underlying:   ex.symbol,
    openDate,
    closeDate,
    closeExecAt:  null,
    desc:         'Ciclo de La Rueda (Tradier) — P&L de solo prima, ver limitación en el código',
    stratType:    'The Wheel',
    openValue:    0,
    closeValue:   0,
    pnl:          +(+pnl).toFixed(2),
    amPm:         null,
    durationDays: Math.round((new Date(closeDate) - new Date(openDate)) / 86400000),
    durationCat:  getDurationCat(openDate, closeDate),
    win:          pnl > 0,
  };
}

function buildMetricsTradier(spxExecutions = [], wheelExecutions = []) {
  const strategies = [
    ...spxExecutions.map(mapSpxExecution).filter(Boolean),
    ...wheelExecutions.map(mapWheelExecution).filter(Boolean),
  ].sort((a, b) => (a.closeDate || '').localeCompare(b.closeDate || ''));

  // Cash flow por "orden" — aproximado con 2 eventos por estrategia (apertura
  // + cierre), ya que Tradier no expone un ledger de ordenes crudo como
  // TastyTrade (metrics.js seccion 3 usa `orders`, que acá no existe).
  const byDay = {}, byMonth = {}, byWeek = {};
  const openByDay = {};
  for (const s of strategies) {
    if (s.openDate) {
      const mo = s.openDate.slice(0, 7), wk = weekKey(s.openDate);
      byDay[s.openDate] = (byDay[s.openDate] || 0) + s.openValue;
      byMonth[mo]        = (byMonth[mo]        || 0) + s.openValue;
      byWeek[wk]          = (byWeek[wk]          || 0) + s.openValue;
      if (s.openValue > 0) openByDay[s.openDate] = (openByDay[s.openDate] || 0) + s.openValue;
    }
    if (s.closeDate) {
      const mo = s.closeDate.slice(0, 7), wk = weekKey(s.closeDate);
      byDay[s.closeDate] = (byDay[s.closeDate] || 0) + s.closeValue;
      byMonth[mo]          = (byMonth[mo]          || 0) + s.closeValue;
      byWeek[wk]            = (byWeek[wk]            || 0) + s.closeValue;
    }
  }

  const byUnderlying = {};
  for (const s of strategies) {
    const un = s.underlying || 'OTHER';
    if (!byUnderlying[un]) byUnderlying[un] = { pnl: 0, trades: 0, wins: 0 };
    byUnderlying[un].pnl += s.pnl;
    byUnderlying[un].trades += 1;
    if (s.pnl > 0) byUnderlying[un].wins += 1;
  }

  const byStrategy = {};
  for (const s of strategies) {
    const st = s.stratType || 'Otro';
    if (!byStrategy[st]) byStrategy[st] = { pnl: 0, trades: 0, wins: 0, avgWin: 0, avgLoss: 0, winRate: 0 };
    byStrategy[st].pnl += s.pnl;
    byStrategy[st].trades += 1;
    if (s.pnl > 0) byStrategy[st].wins += 1;
  }
  for (const [type, data] of Object.entries(byStrategy)) {
    const sw = strategies.filter(s => s.stratType === type && s.pnl > 0);
    const sl = strategies.filter(s => s.stratType === type && s.pnl <= 0);
    data.avgWin  = sw.length ? +(sw.reduce((a, b) => a + b.pnl, 0) / sw.length).toFixed(2) : 0;
    data.avgLoss = sl.length ? +(sl.reduce((a, b) => a + b.pnl, 0) / sl.length).toFixed(2) : 0;
    data.winRate = data.trades ? +((data.wins / data.trades) * 100).toFixed(1) : 0;
  }

  const byTimeSlot = {};
  for (const s of strategies) {
    const ap = s.amPm || 'Unknown';
    if (!byTimeSlot[ap]) byTimeSlot[ap] = { pnl: 0, trades: 0, wins: 0 };
    byTimeSlot[ap].pnl += s.pnl;
    byTimeSlot[ap].trades += 1;
    if (s.pnl > 0) byTimeSlot[ap].wins += 1;
  }

  const byDuration = {};
  for (const s of strategies) {
    const dc = s.durationCat || 'Unknown';
    if (!byDuration[dc]) byDuration[dc] = { pnl: 0, trades: 0, wins: 0 };
    byDuration[dc].pnl += s.pnl;
    byDuration[dc].trades += 1;
    if (s.pnl > 0) byDuration[dc].wins += 1;
  }

  // Tradier sandbox no trackea comisiones/fees por trade hoy — queda en 0,
  // no se inventa un numero.
  const brokerByMonth = {};

  const strategyByMonth = {}, strategyByWeek = {}, stratByDay = {};
  for (const s of strategies) {
    if (!s.closeDate) continue;
    const mo = s.closeDate.slice(0, 7), wk = weekKey(s.closeDate);
    strategyByMonth[mo] = (strategyByMonth[mo] || 0) + s.pnl;
    strategyByWeek[wk]  = (strategyByWeek[wk]  || 0) + s.pnl;
    stratByDay[s.closeDate] = (stratByDay[s.closeDate] || 0) + s.pnl;
  }

  const winners = strategies.filter(s => s.pnl > 0);
  const losers  = strategies.filter(s => s.pnl <= 0);
  const totalGain = winners.reduce((a, b) => a + b.pnl, 0);
  const totalLoss = Math.abs(losers.reduce((a, b) => a + b.pnl, 0));
  const sDayVals = Object.values(stratByDay);
  const posD = sDayVals.filter(v => v > 0), negD = sDayVals.filter(v => v < 0);

  return {
    totalStrategies: strategies.length,
    winRate:      strategies.length ? +((winners.length / strategies.length) * 100).toFixed(2) : 0,
    profitFactor: totalLoss > 0 ? +(totalGain / totalLoss).toFixed(2) : totalGain > 0 ? 999 : 0,
    avgWinner:    winners.length ? +(totalGain / winners.length).toFixed(2) : 0,
    avgLoser:     losers.length ? +(totalLoss / losers.length).toFixed(2) : 0,
    totalPnL:     +strategies.reduce((a, b) => a + b.pnl, 0).toFixed(2),
    totalComm:    0,
    positiveDays: posD.length,
    negativeDays: negD.length,
    avgWinDay:    posD.length ? +(posD.reduce((a, b) => a + b, 0) / posD.length).toFixed(2) : 0,
    avgLossDay:   negD.length ? +(negD.reduce((a, b) => a + b, 0) / negD.length).toFixed(2) : 0,
    bestDay:      sDayVals.length ? Math.max(...sDayVals) : 0,
    worstDay:     sDayVals.length ? Math.min(...sDayVals) : 0,
    strategies:   strategies.slice(-200),
    stratByDay,
    openByDay,
    strategyByMonth,
    strategyByWeek,
    byDay,
    byMonth,
    byWeek,
    byUnderlying,
    byStrategy,
    byTimeSlot,
    byDuration,
    brokerByMonth,
  };
}

module.exports = { buildMetricsTradier };
