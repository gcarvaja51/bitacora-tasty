'use strict';
/* metrics_final.js — FIFO por proximidad de fecha + KPIs completos para reportes */

function detectStrategyType(order) {
  const openLegs = order.legs.filter(l => /to Open/i.test(l.action || ''));
  const n = openLegs.length;
  const puts  = openLegs.filter(l => (l.symbol||'').match(/P\d{8}$/));
  const calls = openLegs.filter(l => (l.symbol||'').match(/C\d{8}$/));
  const isShortLeg = (leg) => /Sell/i.test(leg.action||'');
  const getStrike  = (leg) => parseFloat((leg.symbol||'').slice(-8)) / 1000;
  const shortLegs  = openLegs.filter(l => isShortLeg(l));
  const longLegs   = openLegs.filter(l => !isShortLeg(l));

  // ── 1 PATA ──────────────────────────────────────────────────
  if (n === 1 && openLegs[0]) {
    const leg = openLegs[0];
    const isShort = isShortLeg(leg);
    const isPut   = !!(leg.symbol||'').match(/P\d{8}$/);
    const isCall  = !!(leg.symbol||'').match(/C\d{8}$/);
    if (isPut)  return isShort ? 'Short Put'  : 'Long Put';
    if (isCall) return isShort ? 'Short Call' : 'Long Call';
    return isShort ? 'Short Stock' : 'Long Stock';
  }

  // ── 2 PATAS ─────────────────────────────────────────────────
  if (n === 2) {
    const bothPuts  = puts.length  === 2;
    const bothCalls = calls.length === 2;
    const mixed     = puts.length  === 1 && calls.length === 1;

    // Vertical Spreads — Puts
    if (bothPuts) {
      const strikes   = puts.map(getStrike).sort((a,b) => a-b); // [bajo, alto]
      const shortLeg  = puts.find(l => isShortLeg(l));
      if (!shortLeg) return 'Long Put Spread';
      const shortStrike = getStrike(shortLeg);
      // Bull Put Spread  = sell put alto, buy put bajo  → crédito alcista
      // Bear Put Spread  = sell put bajo, buy put alto  → débito bajista
      return shortStrike === strikes[1] ? 'Bull Put Spread' : 'Bear Put Spread';
    }

    // Vertical Spreads — Calls
    if (bothCalls) {
      const strikes   = calls.map(getStrike).sort((a,b) => a-b); // [bajo, alto]
      const shortLeg  = calls.find(l => isShortLeg(l));
      if (!shortLeg) return 'Long Call Spread';
      const shortStrike = getStrike(shortLeg);
      // Bear Call Spread = sell call BAJO, buy call alto → crédito bajista
      // Bull Call Spread = sell call ALTO, buy call bajo → débito alcista
      return shortStrike === strikes[0] ? 'Bear Call Spread' : 'Bull Call Spread';
    }

    // Combos Put + Call (mismo strike = Straddle, distinto = Strangle)
    if (mixed) {
      const putStrike  = getStrike(puts[0]);
      const callStrike = getStrike(calls[0]);
      const sameStrike = Math.abs(putStrike - callStrike) < 0.01;
      if (shortLegs.length === 2) return sameStrike ? 'Short Straddle'  : 'Short Strangle';
      if (longLegs.length  === 2) return sameStrike ? 'Long Straddle'   : 'Long Strangle';
      // Risk Reversal: long call + short put (alcista) o long put + short call (bajista)
      const longIsCall = !!(longLegs[0]?.symbol||'').match(/C\d{8}$/);
      return longIsCall ? 'Risk Reversal Alcista' : 'Risk Reversal Bajista';
    }
  }

  // ── 3 PATAS ─────────────────────────────────────────────────
  if (n === 3) {
    const allPuts  = openLegs.every(l => !!(l.symbol||'').match(/P\d{8}$/));
    const allCalls = openLegs.every(l => !!(l.symbol||'').match(/C\d{8}$/));

    if (allPuts || allCalls) {
      const strikes = openLegs.map(getStrike).sort((a,b) => a-b);
      const midStrike = strikes[1];
      const midLeg = openLegs.find(l => getStrike(l) === midStrike);
      const midIsShort = midLeg && isShortLeg(midLeg);

      if (shortLegs.length === 2 && longLegs.length === 1) {
        // 2 short, 1 long — Broken Wing Butterfly o Ratio Spread
        const longStrike = getStrike(longLegs[0]);
        const isCenter = longStrike === midStrike;
        return isCenter ? 'Broken Wing Butterfly' : 'Ratio Spread';
      }
      if (shortLegs.length === 1 && longLegs.length === 2) {
        // 1 short central, 2 longs — Butterfly simétrico o asimétrico
        if (midIsShort) {
          const w1 = Math.abs(strikes[1] - strikes[0]);
          const w2 = Math.abs(strikes[2] - strikes[1]);
          return Math.abs(w1 - w2) < 0.01
            ? (allCalls ? 'Call Butterfly' : 'Put Butterfly')
            : 'Broken Wing Butterfly';
        }
      }
      // 1 long central, 2 shorts — Christmas Tree / Ladder
      if (!midIsShort && shortLegs.length === 2) return 'Ladder';
    }

    // Mix put + call en 3 patas
    if (puts.length === 2 && calls.length === 1) return 'Put Spread + Call';
    if (puts.length === 1 && calls.length === 2) return 'Call Spread + Put';
    return 'Spread 3 Patas';
  }

  // ── 4 PATAS ─────────────────────────────────────────────────
  if (n === 4) {
    const allSame = openLegs.every(l => !!(l.symbol||'').match(/P\d{8}$/)) ||
                    openLegs.every(l => !!(l.symbol||'').match(/C\d{8}$/));

    // Iron Condor / Iron Butterfly (2 puts + 2 calls)
    if (puts.length === 2 && calls.length === 2) {
      const putStrikes  = puts.map(getStrike).sort((a,b)=>a-b);
      const callStrikes = calls.map(getStrike).sort((a,b)=>a-b);
      const shortPut    = puts.find(l  => isShortLeg(l));
      const shortCall   = calls.find(l => isShortLeg(l));
      const spStrike    = shortPut  ? getStrike(shortPut)  : null;
      const scStrike    = shortCall ? getStrike(shortCall) : null;
      const putWidth  = putStrikes[1]  - putStrikes[0];
      const callWidth = callStrikes[1] - callStrikes[0];
      // Iron Butterfly: short put y short call en el mismo strike (ATM)
      if (spStrike !== null && scStrike !== null && Math.abs(spStrike - scStrike) < 0.01)
        return 'Iron Butterfly';
      // Iron Condor asimétrico
      if (Math.abs(putWidth - callWidth) > 1) return 'Iron Condor Asimétrico';
      return 'Iron Condor';
    }

    // Butterfly de 4 patas (1-2-1): mismo tipo
    if (allSame) {
      const strikes = openLegs.map(getStrike).sort((a,b)=>a-b);
      const midStrikes = [strikes[1], strikes[2]];
      const shortMids = openLegs.filter(l => midStrikes.includes(getStrike(l)) && isShortLeg(l));
      if (shortMids.length === 2) return calls.length === 4 ? 'Call Condor' : 'Put Condor';
      return 'Doble Spread';
    }

    // Jade Lizard (short put + bear call spread)
    if (puts.length === 1 && calls.length === 2) {
      const shortPut = puts.find(l => isShortLeg(l));
      if (shortPut) return 'Jade Lizard';
    }
    // Big Lizard (short call + bull put spread)
    if (puts.length === 2 && calls.length === 1) {
      const shortCall = calls.find(l => isShortLeg(l));
      if (shortCall) return 'Big Lizard';
    }
  }

  // ── 5+ PATAS ────────────────────────────────────────────────
  if (n === 5) return 'Doble Diagonal';
  if (n >= 6)  return 'Estrategia Compleja';

  return 'Spread';
}

function getDurationCat(openDate, closeDate) {
  const days = Math.round((new Date(closeDate) - new Date(openDate)) / 86400000);
  if (days === 0) return 'Intradía';
  if (days <= 7)  return '1-7 días';
  if (days <= 30) return '1-4 semanas';
  return '> 1 mes';
}

/* TODO lo que fecha un dia de mercado en la Bitacora va en hora de NUEVA YORK.
   `new Date().toISOString()` da la fecha UTC, que a partir de las 8pm ET ya es
   MAÑANA: entre las 8pm y la medianoche el sistema creia estar un dia adelante.
   Mismo criterio que `todayStrET()` de server.js. */
function hoyET() {
  return fechaET(new Date());
}
function fechaET(instante) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(instante));
}

/* La franja horaria de un cierre, en hora de NUEVA YORK.
   Estaba comparando `getUTCHours() < 13` contra un umbral pensado en hora del
   mercado. El mercado abre 9:30 ET = 13:30 UTC en verano y 14:30 en invierno,
   asi que la condicion NO SE CUMPLIA NUNCA: el cubo AM salia vacio y la pestana
   Reportes enseñaba el 100% de los cierres como PM. Medido el 2026-09-05:
   164 de 266 (62%) eran de la manana. Intl resuelve el horario de verano solo.
   Las cuatro etiquetas son las que la pantalla ya esperaba (`timeOrder`). */
function getAmPm(isoStr) {
  if (!isoStr) return null;
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(isoStr));
  const hh  = +(partes.find(x => x.type === 'hour')   || {}).value || 0;
  const mm  = +(partes.find(x => x.type === 'minute') || {}).value || 0;
  const min = hh * 60 + mm;
  if (min <  9 * 60 + 30) return 'Pre-market';
  if (min < 12 * 60)      return 'AM (9-12h)';
  if (min < 16 * 60)      return 'PM (12-16h)';
  return 'After-hours';   // liquidaciones de vencimiento, que llegan 17:00 ET
}

function signed(val, effect) {
  const v = parseFloat(val || 0);
  return effect === 'Credit' ? v : -v;
}

// Contratos (o acciones) de una pata. Devuelve 0 si el feed no la trae — quien
// llama debe tratar el 0 como "cantidad desconocida", no como "cero contratos".
function legQty(leg) {
  return Math.abs(parseFloat(leg?.quantity || 0)) || 0;
}

// Vencimiento YYMMDD embebido en el símbolo OCC (`NFLX  260828P00068000`).
// '' para acciones.
function symExpiry(sym) {
  return ((sym || '').match(/(\d{6})[CP]\d+$/) || [])[1] || '';
}

function weekKey(dateStr) {
  if (!dateStr) return '';
  const d    = new Date(dateStr + 'T12:00:00Z');
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - jan1) / 86400000) + jan1.getUTCDay() + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// opts.limit — cuántos round-trips devolver en `strategies` (los más recientes).
// Default 200, que es lo que necesitan las pestañas de análisis. La hoja de
// Impuestos pasa `limit: 0` (sin recorte): un año gravable tiene que entrar
// completo o el total declarado queda por debajo del real.
function buildMetrics(items, opts = {}) {
  const stratLimit = opts.limit === undefined ? 200 : Number(opts.limit) || 0;
  /* Simbolo+fecha que SI tienen una fila "Cash Settled". Ahi el Removal a $0 es
     su acompañante y hay que ignorarlo o la pata se cierra dos veces. Cuando NO
     la hay —una asignacion que entrega ACCIONES, no efectivo— ese Removal es la
     unica transaccion que cierra la opcion, y botarlo dejaba la corta viva para
     siempre con su prima sin realizar. Encontrado el 2026-09-05 auditando hacia
     atras: la put de GAP $27 06/18 (+$279,87, asignada el 29-may en 100
     acciones) y la de NU $13 06/05 (+$55,73, asignada el 3-jun en 200). */
  const liquidadoEnEfectivo = new Set(
    items.filter(t => t['transaction-type'] === 'Receive Deliver' &&
                      /Cash Settled/i.test(t['transaction-sub-type'] || ''))
         .map(t => `${t.symbol}|${(t['transaction-date'] || '').slice(0, 10)}`));

  const trades = items.filter(t => {
    if (t['transaction-type'] === 'Trade') return true;
    if (t['transaction-type'] === 'Receive Deliver') {
      // Los Removal/Assignment/Exercise a net-value=0 son el acompanante de una
      // fila "Cash Settled" del mismo simbolo: procesarlos cerraria la pata dos
      // veces. Pero una **Expiration a $0 SI es el cierre** de la pata, y era la
      // unica transaccion que lo registraba: botarla dejaba viva para siempre una
      // pata ya vencida y su prima nunca se realizaba. Historico § Expiraciones a
      // cero (15-abr-2026: el calendario daba +$6.258,21 en un dia de -$77,59).
      const nv  = parseFloat(t['net-value'] || 0);
      if (nv !== 0) return true;
      const sub = t['transaction-sub-type'] || '';
      if (/Expiration/i.test(sub)) return true;
      if (/Assignment|Exercise/i.test(sub)) {
        return !liquidadoEnEfectivo.has(`${t.symbol}|${(t['transaction-date'] || '').slice(0, 10)}`);
      }
      return false;
    }
    return false;
  });

  /* ── 1. Agrupar por order-id, acumulando fills del mismo order ── */
  const orderMap = new Map();
  let _rdSeq = 0;
  for (const tx of trades) {
    const isRD = tx['transaction-type'] === 'Receive Deliver';
    const subType = tx['transaction-sub-type'] || '';
    // Todos los Receive Deliver del mismo subyacente+fecha van juntos (mismo settlement)
    const sym = tx.symbol || '';
    const inferredUnderlying = tx['underlying-symbol'] ||
      sym.replace(/\s+\d{6}[CP]\d+$/, '').replace(/W$/, '').trim() || sym.slice(0,4).trim();
    const oid = (isRD && !tx['order-id'])
      ? `RD_${inferredUnderlying}_${(tx['transaction-date']||'').slice(0,10)}`
      : String(tx['order-id'] || tx.id);
    if (!orderMap.has(oid)) {
      // Inferir underlying del símbolo si viene vacío (ej: SPXW → SPX)
      const sym = tx.symbol || '';
      const inferredUnderlying = tx['underlying-symbol'] ||
        sym.replace(/\s+\d{6}[CP]\d+$/, '').replace(/W$/, '').trim() || '';
      orderMap.set(oid, {
        id:         oid,
        executedAt: tx['executed-at'],
        date:       (tx['transaction-date'] || '').slice(0, 10),
        underlying: inferredUnderlying,
        legs:       [],
        netValue:   0,
        commission: 0,
        fees:       0,
        openLegs:   0,
        closeLegs:  0,
        desc:       null,
        stratType:  null,
      });
    }
    const o = orderMap.get(oid);
    // Para Receive Deliver sin action, inferirlo del sub-type
    const txSubType = tx['transaction-sub-type'] || '';
    const txAction = tx.action ||
      (/Cash Settled|Assignment|Exercise|Removal/i.test(txSubType) ? 'Settled to Close' : '');
    const txWithAction = txAction !== tx.action ? { ...tx, action: txAction } : tx;
    // Receive Deliver: NO acumular — cada transacción es una pata independiente
    // Trade: acumular fills del mismo símbolo+acción
    const isRDTx = tx['transaction-type'] === 'Receive Deliver';
    const existingLeg = !isRDTx && o.legs.find(l => l.symbol === tx.symbol && l.action === txAction);
    if (existingLeg) {
      existingLeg['net-value'] = String(parseFloat(existingLeg['net-value']||0) + parseFloat(tx['net-value']||0));
      // La cantidad tambien se acumula. Antes solo se sumaba el dinero y la pata
      // agregada conservaba la cantidad del PRIMER fill, asi que una orden partida
      // en varios fills quedaba con menos contratos de los reales — y el prorrateo
      // del cierre parcial (mas abajo) consumia una fraccion equivocada.
      existingLeg.quantity = String(parseFloat(existingLeg.quantity||0) + parseFloat(tx.quantity||0));
    } else {
      o.legs.push({ ...txWithAction });
    }
    o.netValue   += signed(tx['net-value'], tx['net-value-effect']);
    o.commission += parseFloat(tx.commission || 0);
    o.fees       += parseFloat(tx['clearing-fees'] || 0)
                  + parseFloat(tx['regulatory-fees'] || 0)
                  + parseFloat(tx['proprietary-index-option-fees'] || 0);
    const action = txAction;
    if (/to Open/i.test(action))                                                    o.openLegs++;
    if (/to Close|Expir|Assign|Cash|Exercise|Removal|Deliver|Settled/i.test(action)) o.closeLegs++;
    if (!o.desc && tx.description)                  o.desc = tx.description;
  }

  const orders = [...orderMap.values()]
    .sort((a, b) => new Date(a.executedAt) - new Date(b.executedAt));

  for (const o of orders) {
    o.isOpening = o.openLegs >= o.closeLegs;
    if (o.isOpening) o.stratType = detectStrategyType(o);
  }

  /* ── 2. FIFO con matching por apertura más próxima en fecha ── */
  const inventory = new Map(); // sym → [{orderId, value, date, ...}]
  const rawPairs  = [];
  /* orderId -> CONTRATOS de esa orden que se cerraron el MISMO dia en que se
     abrieron. Sirve para no contar dos veces un intradia: su historia entera va
     en la fila de cierre, con su P&L; enseñarlo ademas como "prima nueva que
     entro hoy" lo mostraba dos veces en el detalle del dia.
     Se mide en CONTRATOS y no en dinero a proposito: el valor de apertura de una
     pata nacida de un roll viene ARRASTRADO de dias anteriores, asi que restarlo
     del neto de la orden es mezclar dos cosas distintas — el 2026-07-31 la orden
     del roll de COIN daba `vivo` 192,12 sobre un neto de 19,75. Con contratos la
     proporcion siempre es la correcta. */
  const cerradoMismoDiaQty = {};

  // Detectar si una orden es un ROLL: tiene patas "to Close" y "to Open" del mismo tipo (C o P)
  function detectRoll(order) {
    const openLegs  = order.legs.filter(l => /to Open/i.test(l.action||''));
    const closeLegs = order.legs.filter(l => /to Close/i.test(l.action||''));
    if (!openLegs.length || !closeLegs.length) return false;
    const openTypes  = new Set(openLegs.map(l  => ((l.symbol||'').match(/([CP])\d{8}$/)||[])[1]));
    const closeTypes = new Set(closeLegs.map(l => ((l.symbol||'').match(/([CP])\d{8}$/)||[])[1]));
    return [...openTypes].some(t => t && closeTypes.has(t));
  }

  for (const order of orders) {
    const isRoll = detectRoll(order);

    /* Un ROLL no cierra una operacion: la MUEVE (norma 5 del usuario, "el
       resultado del calendario es lo que cerre hoy"). Antes se emitia como un par
       propio con `pnl = order.netValue`, lo que hacia tres cosas mal a la vez:
         1. metia en el calendario un resultado que no se realizo,
         2. tiraba a la basura el valor de apertura de la pata vieja, y
         3. contaba el credito de la pata nueva dos veces (en el roll y otra vez
            al cerrarse de verdad).
       Ahora la apertura vieja se ARRASTRA a la pata nueva: la operacion sigue
       siendo una sola y su P&L completo aflora el dia del cierre real. Es el
       mismo encadenado que ya hacia `src/wheel.js`. Para poder arrastrar hay que
       procesar primero las patas que cierran. */
    const rollOpenQty = isRoll
      ? order.legs.filter(l => /to Open/i.test(l.action || ''))
                  .reduce((a, l) => a + (legQty(l) || 0), 0)
      : 0;
    let rollCarry = null;
    const legsToWalk = isRoll
      ? [...order.legs].sort((a, b) =>
          (/to Open/i.test(a.action || '') ? 1 : 0) - (/to Open/i.test(b.action || '') ? 1 : 0))
      : order.legs;

    for (const leg of legsToWalk) {
      const sym    = leg.symbol || '';
      const action = leg.action || '';
      const lv     = signed(leg['net-value'], leg['net-value-effect']);
      const qty    = legQty(leg);

      if (/to Open/i.test(action)) {
        if (!inventory.has(sym)) inventory.set(sym, []);
        const entry = {
          orderId:    order.id,
          value:      lv,
          qty,
          date:       order.date,
          // `date` puede quedar pisada por el arrastre de un roll (pasa a ser la
          // apertura original de la campaña, que es lo que quiere la duracion).
          // `orderDate` conserva el dia en que ESTA pata nacio, que es lo unico
          // que sirve para saber si se cerro el mismo dia.
          orderDate:  order.date,
          execAt:     order.executedAt,
          underlying: order.underlying,
          desc:       order.desc,
          stratType:  order.stratType || 'Otro',
        };
        if (isRoll && rollCarry) {
          // El arrastre se reparte entre las patas nuevas a prorrata de contratos.
          const share = rollOpenQty ? (qty || 0) / rollOpenQty : 1;
          entry.value    += rollCarry.value * share;
          entry.date      = rollCarry.date      || entry.date;
          entry.desc      = rollCarry.desc      || entry.desc;
          entry.stratType = rollCarry.stratType || entry.stratType;
        }
        inventory.get(sym).push(entry);

      } else if (/to Close|Expir|Assign|Cash|Exercise|Removal|Deliver|Settled/i.test(action)) {
        const stack = inventory.get(sym);
        if (stack?.length) {
          // Un cierre puede tapar solo UNA PARTE de la apertura (vender 1 de 2
          // contratos) o abarcar varias aperturas. Antes se hacia splice de la
          // entrada entera sin mirar la cantidad: cerrar 1 de 2 borraba los 2 del
          // inventario y el P&L restaba el costo de 2 contra el ingreso de 1
          // (NFLX 05-ago-2026: -104.37 reportado, -22.25 real). Ahora se consume
          // contrato a contrato y el valor de apertura se prorratea.
          let remaining = qty;
          const taken   = [];

          while (stack.length) {
            // Tomar la apertura más cercana en fecha al cierre
            let bestIdx = 0, bestDiff = Infinity;
            for (let i = 0; i < stack.length; i++) {
              const diff = Math.abs(new Date(order.date) - new Date(stack[i].date));
              if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
            }
            const open = stack[bestIdx];

            // Sin cantidades fiables (Receive Deliver antiguos, acciones sin
            // quantity) se conserva el comportamiento previo: consumir entera.
            if (!qty || !open.qty) {
              stack.splice(bestIdx, 1);
              taken.push({ open, openValue: open.value, qty: open.qty || qty, partial: false });
              break;
            }

            const take      = Math.min(remaining, open.qty);
            const portion   = take / open.qty;
            const openValue = open.value * portion;
            if (portion >= 1) {
              stack.splice(bestIdx, 1);
            } else {
              open.qty   -= take;
              open.value -= openValue;
            }
            taken.push({ open, openValue, qty: take, partial: portion < 1 });
            remaining -= take;
            if (remaining <= 1e-9) break;
          }

          for (const t of taken) {
            if ((t.open.orderDate || t.open.date) === order.date) {
              cerradoMismoDiaQty[t.open.orderId] = (cerradoMismoDiaQty[t.open.orderId] || 0) + (t.qty || 0);
            }
          }

          if (isRoll) {
            // Roll: consumir el inventario viejo y guardarlo para la pata nueva.
            // No se emite par: la operacion sigue abierta, solo cambio de strike
            // o de vencimiento.
            rollCarry = rollCarry || { value: 0, date: null, desc: null, stratType: null };
            for (const t of taken) {
              rollCarry.value    += t.openValue;
              if (!rollCarry.date || t.open.date < rollCarry.date) rollCarry.date = t.open.date;
              rollCarry.desc      = rollCarry.desc      || t.open.desc;
              rollCarry.stratType = rollCarry.stratType || t.open.stratType;
            }
            rollCarry.value += lv;   // lo que costo recomprar la pata vieja
          } else {
            taken.forEach((t, i) => {
              // El cierre se reparte entre las aperturas que tapa
              const closeValue = qty ? lv * (t.qty / qty) : lv;
              // La clave se mantiene igual cuando hay una sola apertura detrás
              // (el caso normal) para no alterar la deduplicación existente.
              const key = taken.length > 1
                ? `${t.open.orderId}_${order.id}_${sym}_${i}`
                : `${t.open.orderId}_${order.id}_${sym}`;
              rawPairs.push({
                key,
                closeOrderId: order.id,
                underlying:   t.open.underlying || order.underlying,
                symbol:       sym,
                openDate:     t.open.date,
                closeDate:    order.date,
                closeExecAt:  order.executedAt,
                desc:         t.open.desc || order.desc,
                openValue:    t.openValue,
                closeValue,
                pnl:          t.openValue + closeValue,
                qty:          t.qty,
                partialClose: t.partial,
                stratType:    t.open.stratType || 'Otro',
                amPm:         getAmPm(order.executedAt),
                durationDays: Math.round((new Date(order.date) - new Date(t.open.date)) / 86400000),
                durationCat:  getDurationCat(t.open.date, order.date),
              });
            });
          }
        }
      }
    }

    // Un roll ya no emite fila propia: su resultado vive dentro de la operacion
    // que movio, y aflora entero el dia del cierre real.
    if (isRoll && !rollCarry) {
      // Sin nada que arrastrar (la pata vieja se abrio fuera del rango pedido):
      // el neto del roll se registra como su propio evento, o se perderia.
      rawPairs.push({
        key:          `ROLL_${order.id}`,
        closeOrderId: order.id,
        underlying:   order.underlying,
        symbol:       order.legs.find(l => /to Open/i.test(l.action||''))?.symbol || '',
        openDate:     order.date,
        closeDate:    order.date,
        closeExecAt:  order.executedAt,
        desc:         order.desc,
        openValue:    order.netValue,
        closeValue:   0,
        pnl:          order.netValue,
        stratType:    'Roll',
        amPm:         getAmPm(order.executedAt),
        durationDays: 0,
        durationCat:  'Intradía',
      });
    }
  }

  /* ── 2b. Deduplicar ── */
  const seenKeys = new Set();
  const deduped  = rawPairs.filter(p => { if (seenKeys.has(p.key)) return false; seenKeys.add(p.key); return true; });

  /* ── 2b-bis. Qué quedó vivo en el inventario ──
     Lo que sobra tras recorrer todas las órdenes son las patas que siguen
     abiertas. Sirve para no presentar como "cerrado" un trade cuyo subyacente
     y vencimiento todavía tienen posición (NFLX 05-ago-2026: se vendió 1 de las
     2 patas largas y el spread seguía vivo, pero la fila salía como cerrada).
     Se exige vencimiento futuro: una opción vieja sin transacción de
     expiración se queda colgada en el inventario para siempre y marcaría
     abiertos trades que no lo están. */
  // En ET, no en UTC: este corte decide si una opcion ya vencio, y por tanto si
  // una operacion se presenta como abierta. Con la fecha UTC, entre las 8pm y la
  // medianoche de Nueva York el corte saltaba al dia siguiente y una posicion que
  // vence hoy dejaba de contar como viva antes de tiempo.
  const todayYmd  = hoyET().slice(2).replace(/-/g, '');
  const openNow   = new Set();
  for (const [sym, stack] of inventory) {
    const exp = symExpiry(sym);
    if (!exp || exp < todayYmd) continue;
    for (const e of stack) {
      if (e.qty > 0) openNow.add(`${e.underlying}|${exp}`);
    }
  }

  /* ── 2c. Consolidar patas del mismo cierre (multi-leg) ── */
  const consolidatedMap = new Map();
  for (const s of deduped) {
    const ckey = `${s.closeOrderId}_${s.underlying}_${s.closeDate}`;
    if (!consolidatedMap.has(ckey)) {
      // _legs cuenta CONTRATOS DISTINTOS, no pares. Un cierre puede generar
      // varios pares contra el mismo símbolo si tapa varias aperturas, y
      // contarlos como patas convertía un cierre simple en "Iron Condor".
      consolidatedMap.set(ckey, { ...s, key: ckey, _legs: 1, _symbols: new Set([s.symbol]) });
    } else {
      const g = consolidatedMap.get(ckey);
      g.openValue  += s.openValue;
      g.closeValue += s.closeValue;
      g.pnl        += s.pnl;
      g.qty         = (g.qty || 0) + (s.qty || 0);
      g.partialClose = g.partialClose || s.partialClose;
      g._symbols.add(s.symbol);
      g._legs = g._symbols.size;
      if (s.openDate < g.openDate) {
        g.openDate     = s.openDate;
        g.durationDays = Math.round((new Date(s.closeDate) - new Date(s.openDate)) / 86400000);
        g.durationCat  = getDurationCat(s.openDate, s.closeDate);
      }
      if (g._legs === 4) g.stratType = 'Iron Condor';
      // No sobreescribir — conservar el stratType de la apertura (Bear Call Spread, Bull Put Spread, etc.)
    }
  }

  // El vencimiento sale de cualquier pata del grupo (todas comparten expiry en
  // un spread); si el grupo es de acciones no hay expiry y nunca se marca.
  for (const g of consolidatedMap.values()) {
    const exp = [...g._symbols].map(symExpiry).find(Boolean) || '';
    // Un Roll SIEMPRE deja posición abierta — es lo que hace. Marcarlo no aporta
    // nada y ensuciaría la mitad de las filas de La Rueda.
    g.positionOpen = g.stratType !== 'Roll' && !!exp && openNow.has(`${g.underlying}|${exp}`);
    delete g._symbols;
  }

  // Recalcular win con P&L final
  const consolidatedStrategies = [...consolidatedMap.values()].map(s => { s.win = s.pnl > 0; return s; });

  /* ── 3. Agrupaciones temporales desde órdenes (cash flow) ── */
  const byDay = {}, byMonth = {}, byWeek = {};
  for (const o of orders) {
    const d = o.date, mo = d.slice(0,7), wk = weekKey(d);
    byDay[d]    = (byDay[d]    || 0) + o.netValue;
    byMonth[mo] = (byMonth[mo] || 0) + o.netValue;
    byWeek[wk]  = (byWeek[wk]  || 0) + o.netValue;
  }

  /* ── 4. Por subyacente ── */
  const byUnderlying = {};
  for (const s of consolidatedStrategies) {
    const un = s.underlying || 'OTHER';
    if (!byUnderlying[un]) byUnderlying[un] = { pnl:0, trades:0, wins:0 };
    byUnderlying[un].pnl    += s.pnl;
    byUnderlying[un].trades += 1;
    if (s.pnl > 0) byUnderlying[un].wins += 1;
  }

  /* ── 5. Por tipo de estrategia ── */
  const byStrategy = {};
  for (const s of consolidatedStrategies) {
    const st = s.stratType || 'Otro';
    if (!byStrategy[st]) byStrategy[st] = { pnl:0, trades:0, wins:0, avgWin:0, avgLoss:0, winRate:0 };
    byStrategy[st].pnl    += s.pnl;
    byStrategy[st].trades += 1;
    if (s.pnl > 0) byStrategy[st].wins += 1;
  }
  for (const [type, data] of Object.entries(byStrategy)) {
    const sw = consolidatedStrategies.filter(s => s.stratType === type && s.pnl > 0);
    const sl = consolidatedStrategies.filter(s => s.stratType === type && s.pnl <= 0);
    data.avgWin  = sw.length ? +(sw.reduce((a,b)=>a+b.pnl,0)/sw.length).toFixed(2) : 0;
    data.avgLoss = sl.length ? +(sl.reduce((a,b)=>a+b.pnl,0)/sl.length).toFixed(2) : 0;
    data.winRate = data.trades ? +((data.wins/data.trades)*100).toFixed(1) : 0;
  }

  /* ── 6. Por horario AM/PM ── */
  const byTimeSlot = {};
  for (const s of consolidatedStrategies) {
    const ap = s.amPm || 'Unknown';
    if (!byTimeSlot[ap]) byTimeSlot[ap] = { pnl:0, trades:0, wins:0 };
    byTimeSlot[ap].pnl    += s.pnl;
    byTimeSlot[ap].trades += 1;
    if (s.pnl > 0) byTimeSlot[ap].wins += 1;
  }

  /* ── 7. Por duración ── */
  const byDuration = {};
  for (const s of consolidatedStrategies) {
    const dc = s.durationCat || 'Unknown';
    if (!byDuration[dc]) byDuration[dc] = { pnl:0, trades:0, wins:0 };
    byDuration[dc].pnl    += s.pnl;
    byDuration[dc].trades += 1;
    if (s.pnl > 0) byDuration[dc].wins += 1;
  }

  /* ── 8. Comisiones por mes y por DIA ──
   * brokerByDay se agrego el 2026-08-14: la pestaña Reportes filtra por rango de
   * fechas, pero con solo el agregado mensual lo unico que podia hacer era incluir
   * o excluir el mes ENTERO. Con un rango que no cubre meses completos eso mete
   * comisiones de dias que quedan fuera del filtro -- medido ese dia: el rango
   * 10-ago a 14-ago mostraba $144.51 (todo agosto) contra $271.53 de P&L realizado
   * del rango, y el rango 15-jul a 14-ago sumaba julio completo ($136.26) incluyendo
   * del 1 al 14 de julio. Eso descuadra tambien el "P&L Bruto" y el ratio
   * comisiones/bruto, que se derivan de este total.
   * El agregado mensual se mantiene: lo consume la tabla "Comisiones por Mes". */
  const brokerByMonth = {}, brokerByDay = {};
  for (const o of orders) {
    const dia = o.date || '';
    const mo  = dia.slice(0,7);
    if (!brokerByMonth[mo]) brokerByMonth[mo] = 0;
    brokerByMonth[mo] += o.commission + o.fees;
    if (!brokerByDay[dia]) brokerByDay[dia] = 0;
    brokerByDay[dia] += o.commission + o.fees;
  }

  /* ── 9. P&L mensual/semanal desde estrategias ── */
  const strategyByMonth = {}, strategyByWeek = {}, stratByDay = {};
  for (const s of consolidatedStrategies) {
    if (!s.closeDate) continue;
    const mo = s.closeDate.slice(0,7), wk = weekKey(s.closeDate);
    strategyByMonth[mo] = (strategyByMonth[mo] || 0) + s.pnl;
    strategyByWeek[wk]  = (strategyByWeek[wk]  || 0) + s.pnl;
    stratByDay[s.closeDate] = (stratByDay[s.closeDate] || 0) + s.pnl;
  }

  /* ── 9b. Lo que entro o salio de caja por abrir y por rolar ──
     Antes esto era `if (o.isOpening && o.netValue > 0)`: solo sumaba las ordenes
     de apertura con neto POSITIVO, asi que una apertura de debito o un roll que
     se paga eran invisibles y el numero salia inflado. 22 dias de 127 mal,
     $14.088,50 de exceso acumulado; el peor el 2026-05-29, que mostraba +$187 en
     un dia donde salieron $2.518 (la asignacion de GAP, 100 acciones a $2.705).
     Ahora entra TODA orden que abra algo, con su signo — un dia puede salir en
     rojo, que es lo que de verdad paso. Sigue siendo caja, no resultado. */
  /* Lo que sigue ABIERTO hoy, fechado en la apertura de su campaña.
     `openByDay` mira solo el mismo dia (es lo que quiere la vista diaria); esto
     mira hasta hoy, que es lo que quiere el resumen del mes: "de lo que abri
     este mes, cuanto sigue abierto".
     Sumar la caja diaria de todo un mes NO responde eso: cuenta entera la prima
     de una posicion abierta y cerrada dentro del mismo mes, y febrero daria
     +$3.158 de "abierto" cuando de febrero no queda ni una pata viva.
     Se toma el VALOR de las patas que quedan en el inventario, no una fraccion
     del neto de la orden: en una cadena de rolls la pata viva carga el arrastre
     de toda la campaña, asi que solo el valor real hace que la suma de todos los
     meses de exactamente el costo de lo abierto — y con eso la invariante
     `caja = realizado + patas vivas` sigue cerrando. La fecha es la de la
     apertura original (`e.date`), que es cuando empezo la operacion. */
  const abiertoByDay = {};
  for (const [, stack] of inventory) {
    for (const e of stack) {
      if (e.qty > 0 && e.date) abiertoByDay[e.date] = (abiertoByDay[e.date] || 0) + e.value;
    }
  }
  for (const d of Object.keys(abiertoByDay)) abiertoByDay[d] = +abiertoByDay[d].toFixed(2);

  const openByDay = {};      // caja del dia: lo que sobrevivio ESE dia
  const vivoDeOrden = {};
  for (const o of orders) {
    const patasAbiertas = o.legs.filter(l => /to Open/i.test(l.action || ''));
    if (!patasAbiertas.length) continue;
    // Lo que se abrio y se cerro el mismo dia no deja caja en juego. Se prorratea
    // por CONTRATOS: abrir 2 y cerrar 1 deja viva la mitad del neto. Aplica igual
    // a un roll cuya pata nueva muere el mismo dia (JBLU 2026-08-18: rolo a la
    // put $6 09/18 y la recompro esa misma tarde).
    const abiertos = patasAbiertas.reduce((a, l) => a + (legQty(l) || 0), 0);
    const cerrados = cerradoMismoDiaQty[o.id] || 0;
    const frac     = abiertos > 0 ? Math.max(0, 1 - cerrados / abiertos) : 1;
    const vivo     = +(o.netValue * frac).toFixed(2);
    vivoDeOrden[o.id] = vivo;
    if (Math.abs(vivo) > 0.005) openByDay[o.date] = (openByDay[o.date] || 0) + vivo;
  }
  for (const d of Object.keys(openByDay)) openByDay[d] = +openByDay[d].toFixed(2);

  /* ── 9c. Movimientos del dia — que PASO, no solo que cerro ──
     El detalle del calendario solo sabia de round-trips cerrados, asi que un dia
     con cinco ordenes podia mostrar dos filas: las aperturas de posiciones que
     siguen vivas y los rolls no existian para la pantalla. (2026-09-04: cinco
     ordenes, dos filas.) Aca va una fila por orden, con su signo de caja. Los
     cierres se marcan igual pero la pantalla los toma de `strategies`, que es
     quien tiene el P&L. */
  const fmtExp = (e) => e ? `${e.slice(2, 4)}/${e.slice(4, 6)}` : '';
  function ladoDe(order, filtro) {
    const legs    = order.legs.filter(l => filtro.test(l.action || ''));
    const strikes = [...new Set(legs.map(l => {
      const mm = (l.symbol || '').match(/[CP](\d{8})$/);
      return mm ? +mm[1] / 1000 : null;
    }).filter(v => v !== null))].sort((a, b) => a - b);
    const exps = [...new Set(legs.map(l => symExpiry(l.symbol || '')).filter(Boolean))];
    return { strikes, exp: exps[0] || '' };
  }
  const movimientos = orders.map(o => {
    const abre   = o.legs.filter(l => /to Open/i.test(l.action || '')).length;
    const cierra = o.legs.length - abre;
    const tipo   = (abre && cierra) ? 'Roll' : (abre ? 'Apertura' : 'Cierre');
    let resumen = '';
    if (tipo === 'Roll') {
      const c = ladoDe(o, /to Close/i), a = ladoDe(o, /to Open/i);
      const cambiaVenc = c.exp && a.exp && c.exp !== a.exp;
      resumen = `${c.strikes.join('/')}${cambiaVenc ? ' ' + fmtExp(c.exp) : ''}`
              + ` → ${a.strikes.join('/')}${cambiaVenc ? ' ' + fmtExp(a.exp) : ''}`;
    } else {
      const x = ladoDe(o, tipo === 'Apertura' ? /to Open/i : /./);
      resumen = `${x.strikes.join('/')}${x.exp ? ' ' + fmtExp(x.exp) : ''}`;
    }
    return {
      date:       o.date,
      id:         o.id,
      underlying: o.underlying || '—',
      tipo,
      net:        +o.netValue.toFixed(2),
      // `vivo` = lo que quedo en juego al cerrar el dia. Un intradia lo deja en
      // 0: su resultado ya sale en la fila de cierre y volver a enseñar su prima
      // como caja nueva era contarlo dos veces (2026-09-04: el bear call de SPX
      // abrio y cerro el mismo dia y aparecia en los dos bloques).
      vivo:       tipo === 'Cierre' ? 0 : (vivoDeOrden[o.id] ?? +o.netValue.toFixed(2)),
      stratType:  o.stratType || null,
      resumen:    resumen.trim() || (o.desc || ''),
    };
  }).filter(mv => mv.date);

  /* ── KPIs finales ── */
  const winners    = consolidatedStrategies.filter(s => s.pnl > 0);
  const losers     = consolidatedStrategies.filter(s => s.pnl <= 0);
  const totalGain  = winners.reduce((a,b) => a+b.pnl, 0);
  const totalLoss  = Math.abs(losers.reduce((a,b) => a+b.pnl, 0));
  const totalComm  = orders.reduce((a,o) => a + o.commission + o.fees, 0);
  const sDayVals   = Object.values(stratByDay);
  const posD = sDayVals.filter(v=>v>0), negD = sDayVals.filter(v=>v<0);

  return {
    totalStrategies: consolidatedStrategies.length,
    winRate:         consolidatedStrategies.length ? +((winners.length/consolidatedStrategies.length)*100).toFixed(2) : 0,
    profitFactor:    totalLoss > 0 ? +(totalGain/totalLoss).toFixed(2) : totalGain > 0 ? 999 : 0,
    avgWinner:       winners.length ? +(totalGain/winners.length).toFixed(2) : 0,
    avgLoser:        losers.length  ? +(totalLoss/losers.length).toFixed(2)  : 0,
    totalPnL:        +consolidatedStrategies.reduce((a,b)=>a+b.pnl,0).toFixed(2),
    totalComm:       +totalComm.toFixed(2),
    positiveDays:    posD.length,
    negativeDays:    negD.length,
    avgWinDay:       posD.length ? +(posD.reduce((a,b)=>a+b,0)/posD.length).toFixed(2) : 0,
    avgLossDay:      negD.length ? +(negD.reduce((a,b)=>a+b,0)/negD.length).toFixed(2) : 0,
    bestDay:         sDayVals.length ? Math.max(...sDayVals) : 0,
    worstDay:        sDayVals.length ? Math.min(...sDayVals) : 0,
    strategies:      stratLimit > 0 ? consolidatedStrategies.slice(-stratLimit) : consolidatedStrategies,
    stratByDay,
    openByDay,
    abiertoByDay,
    movimientos,
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
    brokerByDay,
  };
}

function buildEquityCurve(nlvItems = []) {
  if (!nlvItems.length) return { labels:[], values:[], initial:0, maxDD:0, maxDDPct:0 };
  const labels = [], values = [];
  for (const item of nlvItems) {
    labels.push(fechaET(item.time));
    values.push(parseFloat(item['total-close'] || item.close || 0));
  }
  const initial = values[0] || 0;
  let peak = initial, maxDD = 0, maxDDPct = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDD) { maxDD = dd; maxDDPct = peak > 0 ? dd/peak*100 : 0; }
  }
  return { labels, values, initial, maxDD:+maxDD.toFixed(2), maxDDPct:+maxDDPct.toFixed(2) };
}

function buildCalendar(nlvItems = []) {
  const result = {};
  for (let i = 1; i < nlvItems.length; i++) {
    const prev = parseFloat(nlvItems[i-1]['total-close'] || nlvItems[i-1].close || 0);
    const curr = parseFloat(nlvItems[i]['total-close']   || nlvItems[i].close   || 0);
    const date = fechaET(nlvItems[i].time);
    result[date] = +(curr - prev).toFixed(2);
  }
  return result;
}

module.exports = { buildMetrics, buildEquityCurve, buildCalendar, getAmPm, fechaET };

