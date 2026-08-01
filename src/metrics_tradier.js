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

// Bug real encontrado el 2026-08-01 (el usuario reporto que "Horario de
// Cierre" en Reportes mostraba TODOS los trades como PM): esta funcion
// comparaba directo la hora UTC del timestamp contra el umbral (h<13) sin
// convertir a hora de mercado (America/New_York) -- filledAt/timestamp se
// guardan en UTC real (ej. "...T17:34:57.656Z"), y durante EDT (verano) el
// mercado 9:30am-4pm ET cae en 13:30-20:00 UTC. Como ese rango entero es
// >=13, absolutamente ningun trade real podia clasificar como AM. Corregido
// convirtiendo a hora ET real (mismo patron que isWeekdayET(), server.js).
function getAmPm(isoStr) {
  if (!isoStr) return null;
  const h = +new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date(isoStr));
  return h < 12 ? 'AM (9-12h)' : 'PM (12-16h)';
}

function weekKey(dateStr) {
  if (!dateStr) return '';
  const d    = new Date(dateStr + 'T12:00:00Z');
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - jan1) / 86400000) + jan1.getUTCDay() + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const { estimateSpxCommission, estimateWheelCommission } = require('./broker_fees');

// tradier_executions.json — SPX 0DTE/1DTE (direccional/Iron Condor/Reversion).
// Solo cerrados con pnl numerico ya asentado (pnlSource confirmado o
// reconciliado) — 'pendiente_verificar' se excluye a proposito, mismo
// criterio que ya usa el dashboard "Demo Tradier".
//
// 2026-07-28 (a pedido del usuario): se agregan strategyFamily (antes solo
// vivia concatenado dentro de 'desc', sin poder agruparse/filtrarse por si
// solo), flaggedError/flaggedErrorNote (trades marcados a mano como bug/error
// de implementacion via POST /api/tradier/executions/:id/patch — permite
// filtrarlos en Reportes para comparar win rate con/sin ellos) y
// commissionEstimate (mismo calculo que ya usa Demo Tradier, ver
// src/broker_fees.js — antes Reportes mostraba $0 fijo de comision).
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
    key:              ex.id,
    underlying:       'SPX',
    openDate,
    closeDate,
    closeExecAt:      ex.closedAt || null,
    desc:             ex.strategyFamily ? `${ex.strategyFamily} · ${ex.direction || ''}`.trim() : null,
    strategyFamily:   ex.strategyFamily || null,
    stratType:        ex.strategy || 'Otro',
    openValue:        +openValue.toFixed(2),
    closeValue,
    pnl:              +ex.pnl.toFixed(2),
    commissionEstimate: estimateSpxCommission(ex),
    amPm:             getAmPm(ex.filledAt || ex.timestamp),
    durationDays:     Math.round((new Date(closeDate) - new Date(openDate)) / 86400000),
    durationCat:      getDurationCat(openDate, closeDate),
    win:              ex.pnl > 0,
    flaggedError:     !!ex.flaggedError,
    flaggedErrorNote: ex.flaggedErrorNote || null,
  };
}

// wheel_trading_executions.json — ciclos de la Rueda. Simplificacion conocida,
// sin validar contra un ciclo real todavia (vacio al momento de escribir esto):
// para un cierre NORMAL (expiro OTM o Call ejercida, via checkWheelExpiryImpl)
// no existe un P&L real separado del stock — ex.pnl nunca se setea en esos
// casos, asi que el pnl es SOLO la prima acumulada (totalCreditAccumulated),
// sin incluir la variacion del precio de las acciones mientras se mantuvieron
// entre CSP y CC. Tampoco hay un campo closedAt explicito para esos casos.
//
// Fix real 2026-07-28 (2 bugs encontrados al pedido del usuario de "revisar
// todos los ciclos y validar la fecha", validando los 12 ciclos reales uno
// por uno, no solo los 2 que ya se sabia que estaban mal):
//
// 1) PNL: cuando un ciclo se reconcilio a mano (closeReason:'ROLL_REAPERTURA_
//    FALLIDA', ver el bug de roll con reapertura fallida documentado en el
//    endpoint de gestion, server.js) SI existe un ex.pnl real (el cash flow
//    neto reconciliado, ej. HOOD -$50, BE -$225, NBIS -$95, RKLB -$15,
//    IBIT -$2) — pero este mapeo lo IGNORABA por completo y usaba
//    totalCreditAccumulated (la prima bruta cobrada, sin restar el costo de
//    cerrar la pata abandonada) como si fuera el resultado final. Los 5
//    ciclos aparecian en el calendario como pequenas GANANCIAS (+$2.95,
//    +$18.65, etc.) cuando en realidad 5 de esos 6 fueron PERDIDAS reales
//    (-$387 combinado). Ahora se prefiere ex.pnl cuando es un numero.
// 2) FECHA: el proxy de cierre usaba SIEMPRE el vencimiento nominal del
//    ultimo leg (ex.leg.expiry) — correcto para un ciclo que de verdad llego
//    al vencimiento, pero los 6 ciclos reconciliados a mano tenian
//    leg.expiry de semanas/meses en el futuro respecto a cuando realmente se
//    cerraron (HOOD/BE: 2026-07-31; NBIS/RKLB/IBIT: 2026-08-21 — ninguno de
//    los 3 tenia eventos registrados para usar como proxy, a diferencia de
//    HOOD/BE que si). Se agrega un fallback nuevo: si pnlSource sigue el
//    patron 'reconciliado_manual_YYYY-MM-DD', esa fecha (el dia real de la
//    reconciliacion) se usa antes de caer al vencimiento nominal.
function mapWheelExecution(ex) {
  if (ex.phase !== 'CERRADO') return null;
  const pnl      = typeof ex.pnl === 'number' ? ex.pnl : (ex.totalCreditAccumulated ?? ex.creditReceived ?? 0);
  const openDate = (ex.timestamp || '').slice(0, 10);
  const eventDates = (ex.events || []).map(e => (e.date || '').slice(0, 10)).filter(Boolean);
  const lastEventDate = eventDates.length ? eventDates.sort().slice(-1)[0] : null;
  const reconciledMatch = /^reconciliado_manual_(\d{4}-\d{2}-\d{2})$/.exec(ex.pnlSource || '');
  const closeDate = lastEventDate || (reconciledMatch && reconciledMatch[1]) || (ex.leg && ex.leg.expiry) || openDate;
  if (!openDate) return null;
  return {
    key:              ex.id,
    underlying:       ex.symbol,
    openDate,
    closeDate,
    closeExecAt:      null,
    desc:             'Ciclo de La Rueda (Tradier) — P&L de solo prima, ver limitación en el código',
    strategyFamily:   null, // La Rueda no es parte de las 3 familias SPX — se identifica por stratType==='The Wheel'
    stratType:        'The Wheel',
    openValue:        0,
    closeValue:       0,
    pnl:              +(+pnl).toFixed(2),
    commissionEstimate: estimateWheelCommission(ex),
    amPm:             null,
    durationDays: Math.round((new Date(closeDate) - new Date(openDate)) / 86400000),
    durationCat:  getDurationCat(openDate, closeDate),
    win:              pnl > 0,
    flaggedError:     !!ex.flaggedError,
    flaggedErrorNote: ex.flaggedErrorNote || null,
  };
}

// brokerOnlyStrategies (opcional): estrategias ya reconciliadas desde el
// historial REAL de Tradier (src/tradier_closed_pnl_adapter.js) que no
// estaban en spxExecutions/wheelExecutions — ya vienen en la misma forma
// que mapSpxExecution/mapWheelExecution producen, se agregan directo sin
// transformacion.
function buildMetricsTradier(spxExecutions = [], wheelExecutions = [], brokerOnlyStrategies = []) {
  const strategies = [
    ...spxExecutions.map(mapSpxExecution).filter(Boolean),
    ...wheelExecutions.map(mapWheelExecution).filter(Boolean),
    ...brokerOnlyStrategies,
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
