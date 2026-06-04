'use strict';

const signed = (value, effect) =>
  (effect === 'Credit' ? 1 : -1) * parseFloat(value || 0);

/* ── Helpers ───────────────────────────────────────────────── */

function detectStrategyType(order) {
  const openLegs = order.legs.filter(l => /to Open/i.test(l.action || ''));
  if (!openLegs.length) return 'Cierre';
  const puts  = openLegs.filter(l => (l.symbol||'').match(/P\d{8}$/));
  const calls = openLegs.filter(l => (l.symbol||'').match(/C\d{8}$/));
  const n = openLegs.length;
  const short = (leg) => /Sell/i.test(leg.action||'');
  const getStrike = (leg) => parseInt((leg.symbol||'').slice(-8)) / 1000;

  if (n === 1) {
    if (puts.length)  return short(openLegs[0]) ? 'Put Vendida'  : 'Put Comprada';
    if (calls.length) return short(openLegs[0]) ? 'Call Vendida' : 'Call Comprada';
    return 'Acciones';
  }
  if (n === 2 && puts.length === 2) {
    const sLeg = puts.find(short);
    const max  = Math.max(...puts.map(getStrike));
    return sLeg && getStrike(sLeg) === max ? 'Bull Put Spread' : 'Bear Put Spread';
  }
  if (n === 2 && calls.length === 2) {
    const sLeg = calls.find(short);
    const min  = Math.min(...calls.map(getStrike));
    return sLeg && getStrike(sLeg) === min ? 'Bear Call Spread' : 'Bull Call Spread';
  }
  if (n === 2 && puts.length === 1 && calls.length === 1) return 'Strangle';
  if (n === 4 && puts.length === 2 && calls.length === 2) return 'Iron Condor';
  if (n >= 3) return 'Spread Complejo';
  return 'Spread';
}

function getAmPm(isoStr) {
  if (!isoStr) return 'Unknown';
  const d = new Date(isoStr);
  // Mercado ET (EDT = UTC-4, EST = UTC-5). Usamos UTC-4 como aproximación.
  const etH = (d.getUTCHours() - 4 + 24) % 24;
  if (etH < 9)  return 'Pre-market';
  if (etH < 12) return 'AM (9-12h)';
  if (etH < 16) return 'PM (12-16h)';
  return 'After-hours';
}

function getDurationCat(od, cd) {
  if (!od || !cd) return 'Abierto';
  const days = Math.round((new Date(cd) - new Date(od)) / 86400000);
  if (days === 0) return 'Intradía';
  if (days <= 7)  return '1-7 días';
  if (days <= 30) return '1-4 semanas';
  return '> 1 mes';
}

/* ── Main ──────────────────────────────────────────────────── */
function buildMetrics(items = []) {
  if (!items.length) return empty();

  const trades = items.filter(t => t['transaction-type'] === 'Trade');

  /* ── 1. Agrupar por order-id ── */
  const orderMap = new Map();
  for (const tx of trades) {
    const oid = String(tx['order-id'] || tx.id);
    if (!orderMap.has(oid)) {
      orderMap.set(oid, {
        id:         oid,
        executedAt: tx['executed-at'],
        date:       (tx['transaction-date'] || '').slice(0, 10),
        underlying: tx['underlying-symbol'] || '',
        legs:       [],
        netValue:   0,
        openLegs:   0,
        closeLegs:  0,
        commission: 0,
        fees:       0,
        desc:       '',
        stratType:  null,
      });
    }
    const o = orderMap.get(oid);
    o.legs.push(tx);
    o.netValue   += signed(tx['net-value'], tx['net-value-effect']);
    o.commission += parseFloat(tx.commission || 0);
    o.fees       += parseFloat(tx['clearing-fees'] || 0)
                  + parseFloat(tx['regulatory-fees'] || 0)
                  + parseFloat(tx['proprietary-index-option-fees'] || 0);
    const action = tx.action || '';
    if (/to Open/i.test(action))                   o.openLegs++;
    if (/to Close|Expir|Assign|Cash/i.test(action)) o.closeLegs++;
    if (!o.desc && tx.description)                 o.desc = tx.description;
  }

  const orders = [...orderMap.values()]
    .sort((a, b) => new Date(a.executedAt) - new Date(b.executedAt));

  // Detectar tipo de estrategia en cada orden de apertura
  for (const o of orders) {
    o.isOpening = o.openLegs >= o.closeLegs;
    if (o.isOpening) o.stratType = detectStrategyType(o);
  }

  /* ── 2. Matching FIFO open→close por símbolo ── */
  const inventory = new Map();
  const strategies = [];

  for (const order of orders) {
    for (const leg of order.legs) {
      const sym    = leg.symbol || '';
      const action = leg.action || '';
      const lv     = signed(leg['net-value'], leg['net-value-effect']);

      if (/to Open/i.test(action)) {
        if (!inventory.has(sym)) inventory.set(sym, []);
        inventory.get(sym).push({
          orderId:   order.id,
          value:     lv,
          date:      order.date,
          execAt:    order.executedAt,
          underlying: order.underlying,
          desc:      order.desc,
          stratType: order.stratType || 'Otro',
        });
      } else if (/to Close|Expir|Assign|Cash/i.test(action)) {
        const stack = inventory.get(sym);
        if (stack?.length) {
          const open = stack.shift();
          const pnl  = open.value + lv;
          const key  = `${open.orderId}_${order.id}_${sym}`;
          if (!strategies.find(s => s.key === key)) {
            strategies.push({
              key,
              underlying:  open.underlying || order.underlying,
              symbol:      sym,
              openDate:    open.date,
              closeDate:   order.date,
              desc:        open.desc || order.desc,
              openValue:   open.value,
              closeValue:  lv,
              pnl,
              win:         pnl > 0,
              stratType:   open.stratType || 'Otro',
              amPm:        getAmPm(order.executedAt),
              durationDays: Math.round((new Date(order.date) - new Date(open.date)) / 86400000),
              durationCat: getDurationCat(open.date, order.date),
            });
          }
        }
      }
    }
  }

  const winners   = strategies.filter(s => s.pnl > 0);
  const losers    = strategies.filter(s => s.pnl <= 0);
  const totalGain = winners.reduce((s, x) => s + x.pnl, 0);
  const totalLoss = Math.abs(losers.reduce((s, x) => s + x.pnl, 0));

  /* ── 3. Agrupaciones temporales ── */
  const byDay   = {};
  const byMonth = {};
  const byWeek  = {};

  for (const o of orders) {
    const d  = o.date;
    const mo = d.slice(0, 7);
    const wk = weekKey(d);
    byDay[d]    = (byDay[d]    || 0) + o.netValue;
    byMonth[mo] = (byMonth[mo] || 0) + o.netValue;
    byWeek[wk]  = (byWeek[wk]  || 0) + o.netValue;
  }

  /* ── 4. P&L por subyacente desde estrategias emparejadas ── */
  const byUnderlying = {};
  for (const s of strategies) {
    const un = s.underlying || 'OTHER';
    if (!byUnderlying[un]) byUnderlying[un] = { pnl: 0, trades: 0, wins: 0 };
    byUnderlying[un].pnl    += s.pnl;
    byUnderlying[un].trades += 1;
    if (s.pnl > 0) byUnderlying[un].wins += 1;
  }

  /* ── 5. Por tipo de estrategia ── */
  const byStrategy = {};
  for (const s of strategies) {
    const st = s.stratType || 'Otro';
    if (!byStrategy[st]) byStrategy[st] = { pnl: 0, trades: 0, wins: 0, avgWin: 0, avgLoss: 0 };
    byStrategy[st].pnl    += s.pnl;
    byStrategy[st].trades += 1;
    if (s.pnl > 0) byStrategy[st].wins += 1;
  }
  // Calcular promedios por tipo
  for (const [type, data] of Object.entries(byStrategy)) {
    const stratWinners = strategies.filter(s => s.stratType === type && s.pnl > 0);
    const stratLosers  = strategies.filter(s => s.stratType === type && s.pnl <= 0);
    data.avgWin  = stratWinners.length ? +(stratWinners.reduce((a,b) => a+b.pnl,0)/stratWinners.length).toFixed(2) : 0;
    data.avgLoss = stratLosers.length  ? +(stratLosers.reduce((a,b) => a+b.pnl,0)/stratLosers.length).toFixed(2)  : 0;
    data.winRate = data.trades ? +((data.wins/data.trades)*100).toFixed(1) : 0;
  }

  /* ── 6. Por horario AM/PM ── */
  const byTimeSlot = {};
  for (const s of strategies) {
    const ap = s.amPm || 'Unknown';
    if (!byTimeSlot[ap]) byTimeSlot[ap] = { pnl: 0, trades: 0, wins: 0 };
    byTimeSlot[ap].pnl    += s.pnl;
    byTimeSlot[ap].trades += 1;
    if (s.pnl > 0) byTimeSlot[ap].wins += 1;
  }

  /* ── 7. Por duración ── */
  const byDuration = {};
  for (const s of strategies) {
    const dc = s.durationCat || 'Unknown';
    if (!byDuration[dc]) byDuration[dc] = { pnl: 0, trades: 0, wins: 0 };
    byDuration[dc].pnl    += s.pnl;
    byDuration[dc].trades += 1;
    if (s.pnl > 0) byDuration[dc].wins += 1;
  }

  /* ── 8. Comisiones del broker por mes ── */
  const brokerByMonth = {};
  for (const o of orders) {
    const mo = (o.date||'').slice(0, 7);
    if (!brokerByMonth[mo]) brokerByMonth[mo] = 0;
    brokerByMonth[mo] += o.commission + o.fees;
  }

  /* ── 9. By month/week desde estrategias (fuente única para calendario) ── */
  const strategyByMonth = {};
  const strategyByWeek  = {};
  for (const s of strategies) {
    if (!s.closeDate) continue;
    const mo = s.closeDate.slice(0, 7);
    const wk = weekKey(s.closeDate);
    strategyByMonth[mo] = (strategyByMonth[mo] || 0) + s.pnl;
    strategyByWeek[wk]  = (strategyByWeek[wk]  || 0) + s.pnl;
  }

  /* ── 9. Días positivos/negativos ── */
  const dayVals  = Object.values(byDay);
  const posDays  = dayVals.filter(v => v > 0);
  const negDays  = dayVals.filter(v => v < 0);

  const totalComm = orders.reduce((s, o) => s + o.commission + o.fees, 0);

  /* ── positiveDays/negativeDays desde estrategias ── */
  const stratDayVals = Object.values(strategyByMonth.constructor === Object ?
    (() => { const d={}; strategies.forEach(s=>{ if(s.closeDate){ d[s.closeDate]=(d[s.closeDate]||0)+s.pnl; } }); return d; })() : {});
  const stratByDay = {};
  strategies.forEach(s => { if(s.closeDate) stratByDay[s.closeDate]=(stratByDay[s.closeDate]||0)+s.pnl; });

  // Primas cobradas en aperturas (no realizadas) — solo créditos netos positivos
  const openByDay = {};
  for (const o of orders) {
    if (o.isOpening && o.netValue > 0) {
      openByDay[o.date] = (openByDay[o.date] || 0) + o.netValue;
    }
  }
  const sDayVals = Object.values(stratByDay);
  const posD2 = sDayVals.filter(v=>v>0);
  const negD2 = sDayVals.filter(v=>v<0);

  return {
    totalStrategies: strategies.length,
    winRate:         strategies.length ? +((winners.length / strategies.length) * 100).toFixed(2) : 0,
    profitFactor:    totalLoss > 0 ? +(totalGain / totalLoss).toFixed(2) : totalGain > 0 ? 999 : 0,
    avgWinner:       winners.length ? +(totalGain / winners.length).toFixed(2) : 0,
    avgLoser:        losers.length  ? +(totalLoss / losers.length).toFixed(2)  : 0,
    totalPnL:        +strategies.reduce((s, x) => s + x.pnl, 0).toFixed(2),
    totalComm:       +totalComm.toFixed(2),
    positiveDays:    posD2.length,
    negativeDays:    negD2.length,
    avgWinDay:       posD2.length ? +(posD2.reduce((a,b)=>a+b,0)/posD2.length).toFixed(2) : 0,
    avgLossDay:      negD2.length ? +(negD2.reduce((a,b)=>a+b,0)/negD2.length).toFixed(2) : 0,
    bestDay:         sDayVals.length ? Math.max(...sDayVals) : 0,
    worstDay:        sDayVals.length ? Math.min(...sDayVals) : 0,
    strategies:      strategies.slice(-200),
    stratByDay,           // daily P&L by close date (fuente única)
    openByDay,            // primas cobradas en aperturas por día (informativo)
    strategyByMonth,      // monthly P&L desde estrategias
    strategyByWeek,       // weekly P&L desde estrategias
    byDay,                // cash flow (para referencia)
    byMonth,              // cash flow (para referencia)
    byWeek,               // cash flow (para referencia)
    byUnderlying,
    byStrategy,
    byTimeSlot,
    byDuration,
    brokerByMonth,
  };
}

/* ── Curva de equity ── */
function buildEquityCurve(nlvItems = []) {
  if (!nlvItems.length) return { labels: [], values: [], initial: 0, maxDD: 0, maxDDPct: 0 };
  const labels = [];
  const values = [];
  for (const item of nlvItems) {
    labels.push(new Date(item.time).toISOString().slice(0, 10));
    values.push(parseFloat(item['total-close'] || item.close || 0));
  }
  const initial = values[0] || 0;
  let peak = initial, maxDD = 0, maxDDPct = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDD) { maxDD = dd; maxDDPct = peak > 0 ? dd / peak * 100 : 0; }
  }
  return { labels, values, initial, maxDD: +maxDD.toFixed(2), maxDDPct: +maxDDPct.toFixed(2) };
}

/* ── Calendario ── */
function buildCalendar(nlvItems = []) {
  const result = {};
  for (let i = 1; i < nlvItems.length; i++) {
    const prev = parseFloat(nlvItems[i-1]['total-close'] || nlvItems[i-1].close || 0);
    const curr = parseFloat(nlvItems[i]['total-close']   || nlvItems[i].close   || 0);
    const date = new Date(nlvItems[i].time).toISOString().slice(0, 10);
    result[date] = +(curr - prev).toFixed(2);
  }
  return result;
}

function weekKey(dateStr) {
  if (!dateStr) return '';
  const d    = new Date(dateStr + 'T12:00:00Z');
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - jan1) / 86400000) + jan1.getUTCDay() + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function empty() {
  return {
    totalStrategies:0, winRate:0, profitFactor:0,
    avgWinner:0, avgLoser:0, totalPnL:0, totalComm:0,
    positiveDays:0, negativeDays:0, avgWinDay:0, avgLossDay:0,
    bestDay:0, worstDay:0,
    strategies:[], byDay:{}, byMonth:{}, byWeek:{},
    byUnderlying:{}, byStrategy:{}, byTimeSlot:{}, byDuration:{}, brokerByMonth:{},
  };
}

module.exports = { buildMetrics, buildEquityCurve, buildCalendar };
