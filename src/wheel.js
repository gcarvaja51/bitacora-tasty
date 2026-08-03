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
    // totalPremium = flujo de caja NETO de todas las patas de opciones + dividendos
    // netos. Signo real (credito suma, debito resta) — ver nota de la auditoria
    // 2026-08-03 mas abajo.
    let totalPremium = 0;
    let shares = 0;
    let stockCost = 0;   // desembolso real por las acciones, neto de fees de asignacion
    let avgCost = 0;
    let costBasis = null;

    // Costo base = lo que realmente pusiste por accion menos TODO lo que cobraste
    // por ese subyacente. Se recalcula entero despues de cada movimiento en vez de
    // ajustarse incrementalmente — antes (pre 2026-08-03) solo las calls y los
    // dividendos tocaban costBasis y las puts no, asi que la ganancia/perdida de
    // cualquier put vendida DESPUES de tener las acciones nunca llegaba a la base.
    const syncBasis = () => { if (shares > 0) costBasis = avgCost - totalPremium / shares; };

    for (const tx of txs) {
      const action    = tx.action || '';
      const txType    = tx['transaction-type'] || '';
      const instrType = tx['instrument-type'] || '';
      const nv        = signed(tx['net-value'] || tx.value, tx['net-value-effect'] || tx['value-effect']);
      const parsed    = parseSymbol(tx.symbol || '');
      const date      = (tx['transaction-date'] || '').slice(0, 10);

      // ── Opciones: TODAS las patas, cortas y largas ────────────────
      // Antes (pre 2026-08-03) se descartaban las patas largas asumiendo que eran
      // coberturas ajenas al ciclo. En la practica varias entradas fueron spreads
      // verticales de una sola orden (misma marca de tiempo, IDs consecutivos —
      // p.ej. GAP 27/24 del 28-may, 20/19.5 x3 del 25-jun, 19.5/20 x6 del 29-jun),
      // asi que la pata larga es parte del mismo trade y su plata cuenta igual.
      // No hay forma confiable de distinguir "cobertura" de "pata de spread" en el
      // feed de Tastytrade, y en ambos casos es dinero real del subyacente.
      if (parsed.isOption && parsed.type) {
        let type = null;
        if      (/Sell to Open/i.test(action))  type = parsed.type === 'P' ? 'STO_PUT' : 'STO_CALL';
        else if (/Buy to Close/i.test(action))  type = parsed.type === 'P' ? 'BTC_PUT' : 'BTC_CALL';
        else if (/Buy to Open/i.test(action))   type = parsed.type === 'P' ? 'BTO_PUT' : 'BTO_CALL';
        else if (/Sell to Close/i.test(action)) type = parsed.type === 'P' ? 'STC_PUT' : 'STC_CALL';
        // Assignment / Expiration: sin `action` y net-value 0 — no mueven plata.
        if (!type) continue;
        const qty = Math.abs(parseFloat(tx.quantity || 0)) || undefined;
        events.push({ date, type, strike:parsed.strike, expiry:parsed.expiry, contracts:qty, amount:+nv.toFixed(3) });
        totalPremium += nv;
        syncBasis();
        continue;
      }

      // ── Dividendos ────────────────────────────────────────────────
      // Deteccion tolerante por sub-type O descripcion. Se usa el signo real: el
      // credito del dividendo suma y la retencion de impuesto (que llega como una
      // fila Debit aparte con el mismo sub-type "Dividend") resta. Antes se hacia
      // Math.abs() sobre ambas, asi que la retencion se contaba como si fuera
      // ingreso extra — p.ej. GAP 29-jul: +17.50 y -5.25 se sumaban como 22.75
      // cuando el neto real era 12.25.
      if (txType === 'Money Movement' && /dividend/i.test(tx['transaction-sub-type'] || tx.description || '')) {
        totalPremium += nv;
        syncBasis();
        events.push({ date, type:'DIVIDENDO', amount:+nv.toFixed(2), costBasis });
        continue;
      }

      // ── Acciones ──────────────────────────────────────────────────
      if (instrType === 'Equity' && /Buy to Open|Buy/i.test(action)) {
        const qty   = parseFloat(tx.quantity || 0);
        const price = parseFloat(tx.price || 0);
        // net-value, no price*qty: incluye los fees de asignacion (clearing-fees),
        // que son plata que efectivamente saliste a pagar por las acciones.
        const cost  = Math.abs(nv);
        stockCost += cost;
        shares    += qty;
        avgCost    = shares > 0 ? stockCost / shares : 0;
        syncBasis();
        events.push({ date, type:'STOCK_BUY', qty, price, fees:+(cost - price * qty).toFixed(2), amount:-cost });
        continue;
      }

      if (instrType === 'Equity' && /Sell/i.test(action)) {
        const qty   = parseFloat(tx.quantity || 0);
        const price = parseFloat(tx.price || 0);
        events.push({ date, type:'STOCK_SELL', qty, price, amount:Math.abs(nv) });
        stockCost -= avgCost * Math.min(qty, shares);
        shares    -= qty;
        if (shares <= 0) { shares = 0; stockCost = 0; }
        syncBasis();
        continue;
      }

      if (txType === 'Receive Deliver' && /Receive/i.test(action)) {
        const qty = parseFloat(tx.quantity || 0);
        if (qty > 0) {
          const lastPut = [...events].reverse().find(e => e.type === 'STO_PUT');
          const assignPrice = lastPut?.strike || avgCost;
          stockCost += assignPrice * qty;
          shares    += qty;
          avgCost    = shares > 0 ? stockCost / shares : 0;
          syncBasis();
          events.push({ date, type:'ASSIGNED', qty, price:assignPrice, costBasis, amount:0 });
        }
      }
    }

    // ── Consolidar rolls: BTC+STO mismo día (puts Y calls) ──────────
    // Si el mismo día hay un BTC y un STO del mismo tipo (P o C),
    // se trata como un ROLL y se consolida en un único evento neto.
    // Solo entran las patas CORTAS: un BTO/STC (pata larga de un spread) no es un
    // roll aunque caiga el mismo dia, y mezclarlo acá inventaría rolls que nunca
    // ocurrieron. Quedan como eventos sueltos en el timeline.
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

    // ── Consolidar dividendos: bruto + retención del mismo día = UN pago ──
    // Tastytrade parte cada dividendo en DOS asientos con el mismo
    // `transaction-sub-type: "Dividend"`: el bruto (Credit) y la retención de
    // impuesto (Debit, 30% para no residentes). Es un solo pago — mostrarlo en dos
    // renglones se lee como si hubieras cobrado dos veces (reportado por el usuario
    // 2026-08-03). `totalPremium` no cambia: ya se calculó sumando los netos de cada
    // asiento en el loop, esto es solo la presentación del timeline.
    const divsPorFecha = {};
    const sinDividendos = [];
    for (const ev of nonRollEvents) {
      if (ev.type === 'DIVIDENDO') (divsPorFecha[ev.date] = divsPorFecha[ev.date] || []).push(ev);
      else sinDividendos.push(ev);
    }
    const divEvents = Object.entries(divsPorFecha).map(([date, list]) => {
      const bruto     = list.reduce((s, e) => s + Math.max(0, e.amount || 0), 0);
      const retencion = list.reduce((s, e) => s + Math.min(0, e.amount || 0), 0); // negativo
      return {
        date, type: 'DIVIDENDO',
        amount:    +(bruto + retencion).toFixed(2),
        bruto:     +bruto.toFixed(2),
        retencion: +Math.abs(retencion).toFixed(2),
        // La base ya trae aplicados ambos asientos: el último del día es el vigente.
        costBasis: list[list.length - 1].costBasis,
      };
    });

    // Reconstruir timeline ordenado por fecha
    const finalEvents = [...sinDividendos, ...divEvents, ...rollEvents]
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
    let projectedCostBasis = costBasis !== null ? +costBasis.toFixed(4) : null;
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
