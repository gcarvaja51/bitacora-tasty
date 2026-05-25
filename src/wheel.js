'use strict';

const signed = (v, e) => (e === 'Credit' ? 1 : -1) * parseFloat(v || 0);

function parseSymbol(sym) {
  if (!sym) return {};
  const m = sym.match(/([A-Z/ ]+?)\s*(\d{6})([CP])(\d{8})$/);
  if (!m) return { isEquity: true };
  const [,, exp, type, strikeRaw] = m;
  const strike = parseInt(strikeRaw) / 1000;
  const expiry = `20${exp.slice(0,2)}-${exp.slice(2,4)}-${exp.slice(4,6)}`;
  return { isOption: true, type, strike, expiry };
}

function buildWheelData(items = [], positions = [], wheelUnderlyings = []) {
  const trades = items.filter(t =>
    t['transaction-type'] === 'Trade' ||
    t['transaction-type'] === 'Receive Deliver'
  );

  const wheels = [];

  for (const und of wheelUnderlyings) {
    const txs = trades
      .filter(t => t['underlying-symbol'] === und)
      .sort((a, b) => new Date(a['executed-at']) - new Date(b['executed-at']));

    const events = [];
    let totalPremium = 0;
    let shares = 0;
    let avgCost = 0;
    let costBasis = null;

    for (const tx of txs) {
      const action    = tx.action || '';
      const txType    = tx['transaction-type'] || '';
      const instrType = tx['instrument-type'] || '';
      const nv        = signed(tx['net-value'] || tx.value, tx['net-value-effect'] || tx['value-effect']);
      const parsed    = parseSymbol(tx.symbol || '');
      const date      = (tx['transaction-date'] || '').slice(0, 10);

      if (/Sell to Open/i.test(action) && parsed.type === 'P') {
        events.push({ date, type:'STO_PUT', strike:parsed.strike, expiry:parsed.expiry, amount:Math.abs(nv) });
        totalPremium += Math.abs(nv);
      } else if (/Buy to Close/i.test(action) && parsed.type === 'P') {
        events.push({ date, type:'BTC_PUT', strike:parsed.strike, expiry:parsed.expiry, amount:-Math.abs(nv) });
        totalPremium -= Math.abs(nv);
      } else if (/Sell to Open/i.test(action) && parsed.type === 'C') {
        events.push({ date, type:'STO_CALL', strike:parsed.strike, expiry:parsed.expiry, amount:Math.abs(nv) });
        totalPremium += Math.abs(nv);
        if (costBasis !== null && shares > 0) costBasis -= Math.abs(nv) / shares;
      } else if (/Buy to Close/i.test(action) && parsed.type === 'C') {
        events.push({ date, type:'BTC_CALL', strike:parsed.strike, expiry:parsed.expiry, amount:-Math.abs(nv) });
        totalPremium -= Math.abs(nv);
        if (costBasis !== null && shares > 0) costBasis += Math.abs(nv) / shares;
      } else if (instrType === 'Equity' && /Buy to Open|Buy/i.test(action)) {
        const qty   = parseFloat(tx.quantity || 0);
        const price = parseFloat(tx.price || 0);
        avgCost = shares ? (avgCost * shares + price * qty) / (shares + qty) : price;
        shares += qty;
        costBasis = avgCost;
        events.push({ date, type:'STOCK_BUY', qty, price, amount:-Math.abs(nv) });
      } else if (instrType === 'Equity' && /Sell/i.test(action)) {
        const qty   = parseFloat(tx.quantity || 0);
        const price = parseFloat(tx.price || 0);
        events.push({ date, type:'STOCK_SELL', qty, price, amount:Math.abs(nv) });
        shares -= qty;
        if (shares <= 0) shares = 0;
      } else if (txType === 'Receive Deliver' && /Receive/i.test(action)) {
        const qty = parseFloat(tx.quantity || 0);
        if (qty > 0) {
          const lastPut = [...events].reverse().find(e => e.type === 'STO_PUT');
          const assignPrice = lastPut?.strike || avgCost;
          avgCost = shares ? (avgCost * shares + assignPrice * qty) / (shares + qty) : assignPrice;
          shares += qty;
          costBasis = avgCost - totalPremium / shares;
          events.push({ date, type:'ASSIGNED', qty, price:assignPrice, costBasis, amount:0 });
        }
      }
    }

    // Detectar rolls: BTC_PUT + STO_PUT mismo día — agrupar todos en uno
    const rollDates = new Set();
    for (let i = 0; i < events.length - 1; i++) {
      if (events[i].type === 'BTC_PUT' && events[i+1]?.type === 'STO_PUT' && events[i].date === events[i+1].date) {
        if (rollDates.has(events[i].date + events[i].strike)) { events.splice(i,2); i--; continue; }
        rollDates.add(events[i].date + events[i].strike);
        const net = events[i+1].amount + events[i].amount;
        events[i] = {
          date: events[i].date, type:'ROLL',
          fromStrike:events[i].strike, fromExpiry:events[i].expiry,
          toStrike:events[i+1].strike, toExpiry:events[i+1].expiry,
          amount: net,
        };
        events.splice(i + 1, 1);
      }
    }

    const openPut   = positions.find(p => p['underlying-symbol']===und && (p.symbol||'').match(/P\d{8}$/));
    const openCall  = positions.find(p => p['underlying-symbol']===und && (p.symbol||'').match(/C\d{8}$/));
    const openStock = positions.find(p => p['underlying-symbol']===und && p['instrument-type']==='Equity');

    let phase = 'IDLE';
    if (openPut)                      phase = 'CSP_ACTIVA';
    else if (openCall)                phase = 'CC_ACTIVA';
    else if (openStock || shares > 0) phase = 'ACCIONES';

    // Parsear strike del símbolo (más fiable que strike-price field)
    const putStrike  = openPut  ? parseSymbol(openPut.symbol||'').strike  || parseFloat(openPut['strike-price']||0)  : 0;
    const callStrike = openCall ? parseSymbol(openCall.symbol||'').strike || parseFloat(openCall['strike-price']||0) : 0;
    const putExpiry  = openPut  ? parseSymbol(openPut.symbol||'').expiry  || (openPut['expires-at']||'').slice(0,10)  : '';
    const callExpiry = openCall ? parseSymbol(openCall.symbol||'').expiry || (openCall['expires-at']||'').slice(0,10) : '';

    const activePut  = openPut  ? { strike:putStrike,  expiry:putExpiry  } : null;
    const activeCall = openCall ? { strike:callStrike, expiry:callExpiry } : null;

    // Costo base proyectado para CSP abierta (antes de asignación)
    const contracts = openPut ? parseFloat(openPut.quantity||0) : openCall ? parseFloat(openCall.quantity||0) : 0;
    const sharesIfAssigned = contracts * 100;
    let projectedCostBasis = costBasis;
    if (costBasis === null && putStrike > 0 && sharesIfAssigned > 0) {
      projectedCostBasis = +(putStrike - totalPremium / sharesIfAssigned).toFixed(4);
    } else if (costBasis === null && shares > 0 && totalPremium > 0) {
      projectedCostBasis = +(avgCost - totalPremium / shares).toFixed(4);
    }

    wheels.push({
      underlying:und, phase, events,
      shares:Math.round(shares),
      avgCost:+avgCost.toFixed(4),
      costBasis: projectedCostBasis,
      isProjected: costBasis === null && projectedCostBasis !== null,
      totalPremium:+totalPremium.toFixed(2),
      activePut, activeCall, openStock,
    });
  }

  return wheels.sort((a,b) => {
    const ord = { CSP_ACTIVA:0, CC_ACTIVA:1, ACCIONES:2, IDLE:3 };
    return (ord[a.phase]??9) - (ord[b.phase]??9);
  });
}

module.exports = { buildWheelData };
