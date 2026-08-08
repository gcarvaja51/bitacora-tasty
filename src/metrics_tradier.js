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

// Hoy en hora del Este ('YYYY-MM-DD'). Un dia de trading es un dia de mercado,
// no un dia UTC: con la fecha UTC, entre las 8pm ET y la medianoche este
// modulo creeria que ya es manana.
function todayET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

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
  // Posiciones ABIERTAS (2026-08-03, a pedido del usuario): antes solo entraban
  // las cerradas, asi que un trade recien abierto no aparecia en ningun lado
  // hasta cerrar. Ahora se incluyen marcadas con isOpen + livePnl (el P&L no
  // realizado que ya calcula el servidor con cotizaciones reales de Tradier).
  // Se tratan como "pendientes" para los agregados: NO cuentan en win rate,
  // P&L total, curva ni calendario -- un trade sin cerrar no tiene resultado.
  const isOpen = ex.status === 'filled' || ex.status === 'submitted';
  if (ex.status !== 'closed' && !isOpen) return null;
  // pnl todavia no asentado (pnlSource 'pendiente_verificar'): ANTES se
  // descartaba el trade por completo y no aparecia en ninguna hoja hasta que
  // Tradier confirmara el gain_loss -- podia ser horas. A pedido del usuario
  // (2026-08-03) ahora SI se devuelve, marcado con pnlPending, para que
  // Historial lo muestre con la etiqueta "pendiente" en vez de ocultarlo.
  // OJO: pnl queda en 0 solo para no romper las ~12 sumas que asumen numero;
  // buildMetricsTradier EXCLUYE estos trades de todos los agregados (win rate,
  // P&L total, curva, calendario...) -- si contaran, un trade sin resultado
  // real se leeria como perdedora de $0 y ensuciaria las metricas.
  const pnlPending = isOpen || typeof ex.pnl !== 'number';
  const contracts     = ex.contracts || 1;
  const entryPremium  = Math.abs(ex.entryFillPrice ?? ex.creditReceived ?? 0) * 100 * contracts;
  const openValue     = ex.isCredit === false ? -entryPremium : entryPremium;
  const pnlNum        = pnlPending ? 0 : ex.pnl;
  const closeValue    = pnlPending ? 0 : +(pnlNum - openValue).toFixed(2);
  const openDate      = (ex.filledAt || ex.timestamp || '').slice(0, 10);
  // Una posicion abierta no tiene fecha de cierre real. Se usa la de apertura
  // como clave de orden (Historial ordena por closeDate) para que aparezca
  // arriba junto a lo mas reciente, pero closeExecAt/closeDate quedan marcados
  // como abiertos para que la UI no muestre una fecha de cierre inventada.
  const closeDate     = isOpen ? openDate : (ex.closedAt || ex.timestamp || '').slice(0, 10);
  if (!openDate || !closeDate) return null;
  return {
    key:              ex.id,
    underlying:       'SPX',
    openDate,
    closeDate,
    closeExecAt:      ex.closedAt || null,
    isOpen,                           // <- Historial: fila de posicion abierta
    livePnl:          isOpen ? (typeof ex.livePnl === 'number' ? ex.livePnl : null) : null,
    direction:        ex.direction || null,
    strikes:          ex.strikes || null,
    closeReason:      ex.closeReason || null,
    entryFillPrice:   ex.entryFillPrice ?? null,
    desc:             ex.strategyFamily ? `${ex.strategyFamily} · ${ex.direction || ''}`.trim() : null,
    strategyFamily:   ex.strategyFamily || null,
    // 0DTE / 1DTE. Los dos Iron Condor comparten strategyFamily 'NEUTRAL' pero
    // son estrategias distintas — el 1DTE aguanta el gap overnight, que no tiene
    // monitoreo posible. Sin este campo no se pueden separar en la curva.
    expType:          ex.expType || null,
    stratType:        ex.strategy || 'Otro',
    openValue:        +openValue.toFixed(2),
    closeValue,
    pnl:              +pnlNum.toFixed(2),
    pnlPending,                       // <- Historial lo usa para mostrar "pendiente"
    pnlSource:        ex.pnlSource || null,
    commissionEstimate: estimateSpxCommission(ex),
    amPm:             getAmPm(ex.filledAt || ex.timestamp),
    durationDays:     Math.round((new Date(closeDate) - new Date(openDate)) / 86400000),
    durationCat:      getDurationCat(openDate, closeDate),
    win:              pnlPending ? null : ex.pnl > 0,
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
// 3) UNIDADES (2026-08-03, mismo pase que el fix del adaptador de la Rueda):
//    ex.pnl viene de gain_loss de Tradier — DOLARES TOTALES. El fallback
//    (totalCreditAccumulated / creditReceived) es precio de la opcion POR
//    ACCION, las mismas unidades en que lo usa el motor de la Rueda cuando
//    hace `strike - totalCreditAccumulated` (server.js). Se mezclaban: un
//    ciclo cerrado sin pnl resuelto reportaba, por contrato, 100 veces menos
//    de lo real — un ciclo que cobro $127 de prima y expiro OTM figuraba como
//    $1.27 en Reportes, Historial, calendario y curva. Se convierte igual que
//    ya hacia mapSpxExecution unas lineas mas arriba (`* 100 * contracts`).
// 5) SIN `pnl` EXPLICITO NO SE INVENTA UN NUMERO (2026-08-07). El respaldo era
//    `totalCreditAccumulated`, o sea: "me quede la prima entera". Eso solo es
//    cierto si el put expiro sin valor, y el error va SIEMPRE a favor — la
//    direccion peligrosa. Cruzando agosto contra el /gainloss real de Tradier,
//    seis ciclos estaban mal por esta via y en tres el broker decia lo
//    contrario de lo que mostraba la bitacora:
//      · PDD  +$68 anotado  ->  -$88 real (cerrada el 24-jul, no el 03-ago)
//      · MARA +$49 anotado  ->  -$85 real (17-jul)
//      · NU   +$17 anotado  ->  -$58 real (24-jul)
//    Los otros tres (KO/BAC/JBLU) ademas se contaban dos veces, porque el roll
//    sobreescribio `ex.leg` y trackedLegKeys dejo de tapar la fila del broker.
//    Ahora, sin `pnl`, el ciclo se devuelve con `pnlPending: true` — igual que
//    mapSpxExecution: sigue visible en Historial marcado como pendiente, pero
//    queda fuera de `computed`, o sea fuera de totales, curva, calendario y win
//    rate. Un hueco declarado es preferible a una ganancia inventada.
//    Excepcion: ENTRADA_NO_LLENO. Ahi la orden de entrada nunca lleno, o sea
//    que no hubo posicion en ningun momento — su $0 es un dato confirmado, no
//    un hueco, y marcarlo pendiente inventaria una fila a verificar que no
//    tiene nada que verificar.
function mapWheelExecution(ex) {
  if (ex.phase !== 'CERRADO') return null;
  const nuncaHuboPosicion = ex.closeReason === 'ENTRADA_NO_LLENO';
  const pnlPending = typeof ex.pnl !== 'number' && !nuncaHuboPosicion;
  const pnl        = typeof ex.pnl === 'number' ? ex.pnl : 0;
  const openDate = (ex.timestamp || '').slice(0, 10);
  const eventDates = (ex.events || []).map(e => (e.date || '').slice(0, 10)).filter(Boolean);
  const lastEventDate = eventDates.length ? eventDates.sort().slice(-1)[0] : null;
  const reconciledMatch = /^reconciliado_manual_(\d{4}-\d{2}-\d{2})$/.exec(ex.pnlSource || '');
  // 4) FECHA, segunda pasada (2026-08-04). Dos reportes del usuario el mismo
  //    dia — "aparece algo con fecha de septiembre" y "aparecen trades cerrados
  //    el 14 de agosto, hoy es 4 de agosto" — y una regla suya que fija el
  //    criterio: **"el resultado del calendario es lo que cerre hoy. No importa
  //    si hice roll para septiembre o noviembre, eso no tiene nada que ver."**
  //
  //    Un ROLL no es un cierre y un VENCIMIENTO no es un cierre. La cadena
  //    anterior (lastEventDate -> reconciliado_manual -> leg.expiry) violaba
  //    las dos cosas y nunca leia `ex.closedAt`, la marca explicita de cierre
  //    que mapSpxExecution si usa. Casos reales verificados contra la cuenta:
  //      · JBLU  — cerro el 04-ago (closedAt) y se fechaba el 14-JUL, el dia de
  //        su ROLL_DEFENSIVO: tres semanas antes y en el mes equivocado.
  //      · KO / BAC — cerraron el 04-ago y se fechaban el 03-ago, dia del ROLL.
  //      · PDD / MARA / NU — cerraron el 03-ago (HUERFANO_SIN_POSICION, con
  //        closedAt) y se fechaban el 14-AGO, su vencimiento: en el FUTURO.
  //      · ANET wtex-1785796482836 — cerro el 04-ago (ENTRADA_NO_LLENO, la
  //        orden nunca lleno) y se fechaba el 04-SEP, inventando un bucket de
  //        septiembre con $0 en la curva, el calendario y el desglose mensual.
  //
  //    Orden nuevo, de mas a menos confiable: marca explicita de cierre ->
  //    fecha de reconciliacion manual -> ultimo evento (proxy, puede ser un
  //    roll) -> vencimiento SOLO si ya paso -> apertura.
  const closedAtDate = (ex.closedAt || '').slice(0, 10) || null;
  const expiry       = (ex.leg && ex.leg.expiry) || null;
  const hoy          = todayET();
  let closeDate = closedAtDate
    || (reconciledMatch && reconciledMatch[1])
    || lastEventDate
    || (expiry && expiry <= hoy ? expiry : null)   // un vencimiento futuro no fecha nada
    || openDate;
  // Cinturon y tirantes: ningun proxy puede dejar la fecha en el futuro.
  if (closeDate > hoy) closeDate = openDate;
  if (!openDate) return null;
  return {
    key:              ex.id,
    underlying:       ex.symbol,
    openDate,
    closeDate,
    closeExecAt:      null,
    desc:             pnlPending
      ? 'Ciclo de La Rueda (Tradier) — sin P&L confirmado por el broker'
      : 'Ciclo de La Rueda (Tradier)',
    strategyFamily:   null, // La Rueda no es parte de las 3 familias SPX — se identifica por stratType==='The Wheel'
    stratType:        'The Wheel',
    openValue:        0,
    closeValue:       0,
    pnl:              +(+pnl).toFixed(2),
    pnlPending,                       // <- Historial lo usa para mostrar "pendiente"
    pnlSource:        ex.pnlSource || null,
    commissionEstimate: estimateWheelCommission(ex),
    amPm:             null,
    durationDays: Math.round((new Date(closeDate) - new Date(openDate)) / 86400000),
    durationCat:  getDurationCat(openDate, closeDate),
    win:              pnlPending ? null : pnl > 0,
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

  // `strategies` (la lista completa, con los pendientes) se devuelve tal cual
  // para que Historial pueda listarlos. TODOS los agregados de aca en adelante
  // usan `computed` -- solo trades con P&L real confirmado. Sin esta
  // separacion, un trade cerrado hoy pero sin gain_loss asentado en Tradier
  // contaria como perdedora de $0: bajaria el win rate y ensuciaria curva,
  // calendario y KPIs con un resultado que todavia no existe.
  const computed = strategies.filter(s => !s.pnlPending);

  // Cash flow por "orden" — aproximado con 2 eventos por estrategia (apertura
  // + cierre), ya que Tradier no expone un ledger de ordenes crudo como
  // TastyTrade (metrics.js seccion 3 usa `orders`, que acá no existe).
  const byDay = {}, byMonth = {}, byWeek = {};
  const openByDay = {};
  for (const s of computed) {
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
  for (const s of computed) {
    const un = s.underlying || 'OTHER';
    if (!byUnderlying[un]) byUnderlying[un] = { pnl: 0, trades: 0, wins: 0 };
    byUnderlying[un].pnl += s.pnl;
    byUnderlying[un].trades += 1;
    if (s.pnl > 0) byUnderlying[un].wins += 1;
  }

  const byStrategy = {};
  for (const s of computed) {
    const st = s.stratType || 'Otro';
    if (!byStrategy[st]) byStrategy[st] = { pnl: 0, trades: 0, wins: 0, avgWin: 0, avgLoss: 0, winRate: 0 };
    byStrategy[st].pnl += s.pnl;
    byStrategy[st].trades += 1;
    if (s.pnl > 0) byStrategy[st].wins += 1;
  }
  for (const [type, data] of Object.entries(byStrategy)) {
    const sw = computed.filter(s => s.stratType === type && s.pnl > 0);
    const sl = computed.filter(s => s.stratType === type && s.pnl <= 0);
    data.avgWin  = sw.length ? +(sw.reduce((a, b) => a + b.pnl, 0) / sw.length).toFixed(2) : 0;
    data.avgLoss = sl.length ? +(sl.reduce((a, b) => a + b.pnl, 0) / sl.length).toFixed(2) : 0;
    data.winRate = data.trades ? +((data.wins / data.trades) * 100).toFixed(1) : 0;
  }

  const byTimeSlot = {};
  for (const s of computed) {
    const ap = s.amPm || 'Unknown';
    if (!byTimeSlot[ap]) byTimeSlot[ap] = { pnl: 0, trades: 0, wins: 0 };
    byTimeSlot[ap].pnl += s.pnl;
    byTimeSlot[ap].trades += 1;
    if (s.pnl > 0) byTimeSlot[ap].wins += 1;
  }

  const byDuration = {};
  for (const s of computed) {
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
  for (const s of computed) {
    if (!s.closeDate) continue;
    const mo = s.closeDate.slice(0, 7), wk = weekKey(s.closeDate);
    strategyByMonth[mo] = (strategyByMonth[mo] || 0) + s.pnl;
    strategyByWeek[wk]  = (strategyByWeek[wk]  || 0) + s.pnl;
    stratByDay[s.closeDate] = (stratByDay[s.closeDate] || 0) + s.pnl;
  }

  const winners = computed.filter(s => s.pnl > 0);
  const losers  = computed.filter(s => s.pnl <= 0);
  const totalGain = winners.reduce((a, b) => a + b.pnl, 0);
  const totalLoss = Math.abs(losers.reduce((a, b) => a + b.pnl, 0));
  const sDayVals = Object.values(stratByDay);
  const posD = sDayVals.filter(v => v > 0), negD = sDayVals.filter(v => v < 0);

  return {
    totalStrategies: computed.length,
    winRate:      computed.length ? +((winners.length / computed.length) * 100).toFixed(2) : 0,
    profitFactor: totalLoss > 0 ? +(totalGain / totalLoss).toFixed(2) : totalGain > 0 ? 999 : 0,
    avgWinner:    winners.length ? +(totalGain / winners.length).toFixed(2) : 0,
    avgLoser:     losers.length ? +(totalLoss / losers.length).toFixed(2) : 0,
    totalPnL:     +computed.reduce((a, b) => a + b.pnl, 0).toFixed(2),
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
