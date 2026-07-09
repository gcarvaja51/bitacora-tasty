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
  // Soporta strings simples o {symbol, startDate}
  const wheelConfigs = wheelUnderlyings.map(u =>
    typeof u === 'string' ? { symbol: u, startDate: null } : u
  );
  // 'Money Movement' incluye dividendos (y otras cosas como intereses/ajustes) — se
  // suma aca para que la Rueda los muestre; se filtra a solo dividendos mas abajo por
  // sub-type/descripcion (no hay ejemplo real todavia para confirmar el nombre exacto
  // del sub-type de Tastytrade, asi que se matchea de forma tolerante — ver mas abajo).
  const trades = items.filter(t =>
    t['transaction-type'] === 'Trade' ||
    t['transaction-type'] === 'Receive Deliver' ||
    t['transaction-type'] === 'Money Movement'
  );

  const wheels = [];

  for (const cfg of wheelConfigs) {
    const und = cfg.symbol;
    const startDate = cfg.startDate || null;
    const txs = trades
      .filter(t => {
        // Money Movement (dividendos) puede no traer underlying-symbol — cae a symbol
        // directo (el ticker de la accion) en ese caso.
        const underlying = t['underlying-symbol'] || (t['transaction-type'] === 'Money Movement' ? t.symbol : null);
        if (underlying !== und) return false;
        if (startDate) return (t['transaction-date'] || t['executed-at'] || '').slice(0,10) >= startDate;
        return true;
      })
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

      // Ignorar posiciones largas en opciones (coberturas, no parte del ciclo Rueda)
      if (parsed.isOption && /Buy to Open|Sell to Close/i.test(action)) continue;

      if (/Sell to Open/i.test(action) && parsed.type === 'P') {
        events.push({ date, type:'STO_PUT', strike:parsed.strike, expiry:parsed.expiry, amount:Math.abs(nv) });
        totalPremium += Math.abs(nv);

      } else if (/Buy to Close/i.test(action) && parsed.type === 'P') {
        events.push({ date, type:'BTC_PUT', strike:parsed.strike, expiry:parsed.expiry, amount:-Math.abs(nv) });
        totalPremium -= Math.abs(nv);

      } else if (/Sell to Open/i.test(action) && parsed.type === 'C') {
        events.push({ date, type:'STO_CALL', strike:parsed.strike, expiry:parsed.expiry, amount:Math.abs(nv) });
        totalPremium += Math.abs(nv);
        // Reducir costo base por prima de CC (solo si ya hay acciones)
        if (costBasis !== null && shares > 0) costBasis -= Math.abs(nv) / shares;

      } else if (/Buy to Close/i.test(action) && parsed.type === 'C') {
        events.push({ date, type:'BTC_CALL', strike:parsed.strike, expiry:parsed.expiry, amount:-Math.abs(nv) });
        totalPremium -= Math.abs(nv);
        // Revertir reducción al cerrar CC
        if (costBasis !== null && shares > 0) costBasis += Math.abs(nv) / shares;

      } else if (instrType === 'Equity' && /Buy to Open|Buy/i.test(action)) {
        const qty   = parseFloat(tx.quantity || 0);
        const price = parseFloat(tx.price || 0);
        avgCost = shares ? (avgCost * shares + price * qty) / (shares + qty) : price;
        shares += qty;
        // FIX: descontar TODA la prima acumulada hasta ahora (incluye Puts cobradas antes de comprar)
        costBasis = avgCost - totalPremium / shares;
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

      } else if (txType === 'Money Movement' && /dividend/i.test(tx['transaction-sub-type'] || tx.description || '')) {
        // Deteccion tolerante — no hay un dividendo real todavia con el que confirmar
        // el nombre exacto del transaction-sub-type de Tastytrade, asi que matchea
        // por sub-type O descripcion conteniendo "dividend" (case-insensitive) en vez
        // de un valor exacto.
        // A pedido del usuario (2026-07-09): el dividendo SI reduce el costo base,
        // mismo patron que STO_CALL — se suma a totalPremium (para que un STOCK_BUY
        // futuro que recalcule desde cero tambien lo incluya) y se resta directo de
        // costBasis si ya hay acciones en mano.
        const divAmount = Math.abs(nv);
        totalPremium += divAmount;
        if (costBasis !== null && shares > 0) costBasis -= divAmount / shares;
        events.push({ date, type:'DIVIDENDO', amount: divAmount, costBasis });
      }
    }

    // ── Consolidar rolls: BTC+STO mismo día (puts Y calls) ──────────
    // Si el mismo día hay un BTC y un STO del mismo tipo (P o C),
    // se trata como un ROLL y se consolida en un único evento neto.
    const rollsByDate = {};
    const nonRollEvents = [];

    for (const ev of events) {
      const isRollable = ev.type === 'BTC_PUT' || ev.type === 'STO_PUT' ||
                         ev.type === 'BTC_CALL' || ev.type === 'STO_CALL';
      if (isRollable) {
        const kind = ev.type.endsWith('PUT') ? 'put' : 'call';
        const key  = `${ev.date}::${kind}`;
        if (!rollsByDate[key]) rollsByDate[key] = { btc: [], sto: [] };
        if (ev.type.startsWith('BTC')) rollsByDate[key].btc.push(ev);
        else                           rollsByDate[key].sto.push(ev);
      } else {
        nonRollEvents.push(ev);
      }
    }

    const rollEvents = [];
    for (const [key, { btc, sto }] of Object.entries(rollsByDate)) {
      if (btc.length > 0 && sto.length > 0) {
        // Es un roll — consolidar en un único evento ROLL neto
        const netAmount = sto.reduce((s, e) => s + e.amount, 0) +
                          btc.reduce((s, e) => s + e.amount, 0);
        rollEvents.push({
          date:       btc[0].date,
          type:       'ROLL',
          fromStrike: btc[0].strike,
          fromExpiry: btc[0].expiry,
          toStrike:   sto[0].strike,
          toExpiry:   sto[0].expiry,
          amount:     +netAmount.toFixed(2),
        });
      } else {
        // Solo BTC o solo STO sin par → dejar como eventos individuales
        btc.forEach(e => rollEvents.push(e));
        sto.forEach(e => rollEvents.push(e));
      }
    }

    // Reconstruir timeline ordenado por fecha
    const finalEvents = [...nonRollEvents, ...rollEvents]
      .sort((a, b) => a.date.localeCompare(b.date));

    // ── Posiciones abiertas ────────────────────────────────────────
    // FIX multi-contrato: buscar TODAS las puts/calls abiertas, no solo la primera
    const openPuts  = positions.filter(p => p['underlying-symbol']===und && (p.symbol||'').match(/P\d{8}$/));
    const openCalls = positions.filter(p => p['underlying-symbol']===und && (p.symbol||'').match(/C\d{8}$/));
    const openStock = positions.find(p  => p['underlying-symbol']===und && p['instrument-type']==='Equity');

    const openPut  = openPuts[0]  || null;
    const openCall = openCalls[0] || null;

    // Contratos totales (suma de todas las posiciones abiertas del mismo tipo)
    const contractsPut  = openPuts.reduce((s, p)  => s + Math.abs(parseFloat(p.quantity||0)), 0);
    const contractsCall = openCalls.reduce((s, p) => s + Math.abs(parseFloat(p.quantity||0)), 0);
    // Acciones reales desde posición equity (TastyTrade devuelve qty=200 para 2 contratos)
    const sharesFromPos = openStock ? Math.abs(parseFloat(openStock.quantity||0)) : Math.round(shares);
    // Contratos equivalentes: opciones abiertas, o acciones/100 si solo hay equity
    const contracts     = contractsPut || contractsCall || Math.round(sharesFromPos / 100);

    let phase = 'IDLE';
    if (openPut)                      phase = 'CSP_ACTIVA';
    else if (openCall)                phase = 'CC_ACTIVA';
    else if (openStock || shares > 0) phase = 'ACCIONES';

    const putStrike  = openPut  ? parseSymbol(openPut.symbol||'').strike  || parseFloat(openPut['strike-price']||0)  : 0;
    const callStrike = openCall ? parseSymbol(openCall.symbol||'').strike || parseFloat(openCall['strike-price']||0) : 0;
    const putExpiry  = openPut  ? parseSymbol(openPut.symbol||'').expiry  || (openPut['expires-at']||'').slice(0,10)  : '';
    const callExpiry = openCall ? parseSymbol(openCall.symbol||'').expiry || (openCall['expires-at']||'').slice(0,10) : '';

    const activePut  = openPut  ? { strike:putStrike,  expiry:putExpiry,  contracts:contractsPut  } : null;
    const activeCall = openCall ? { strike:callStrike, expiry:callExpiry, contracts:contractsCall } : null;

    // ── Costo base proyectado (CSP abierta, antes de asignación) ──
    const sharesIfAssigned = contracts * 100;
    let projectedCostBasis = costBasis;
    if (costBasis === null && putStrike > 0 && sharesIfAssigned > 0) {
      projectedCostBasis = +(putStrike - totalPremium / sharesIfAssigned).toFixed(4);
    } else if (costBasis === null && shares > 0 && totalPremium > 0) {
      projectedCostBasis = +(avgCost - totalPremium / shares).toFixed(4);
    }

    wheels.push({
      underlying:   und,
      startDate:    startDate,
      phase,
      events:       finalEvents,
      shares:       Math.round(shares),
      avgCost:      +avgCost.toFixed(4),
      costBasis:    projectedCostBasis,
      isProjected:  costBasis === null && projectedCostBasis !== null,
      totalPremium: +totalPremium.toFixed(2),
      contracts,          // ← total contratos abiertos
      contractsPut,       // ← contratos put
      contractsCall,      // ← contratos call
      activePut,
      activeCall,
      openStock,
    });
  }

  return wheels.sort((a, b) => {
    const ord = { CSP_ACTIVA:0, CC_ACTIVA:1, ACCIONES:2, IDLE:3 };
    return (ord[a.phase]??9) - (ord[b.phase]??9);
  });
}

module.exports = { buildWheelData };
