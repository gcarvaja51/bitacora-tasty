'use strict';

// Adaptador de un solo sentido: proyecta los registros de
// wheel_trading_executions.json (maquina de estados propia, ver CLAUDE.md
// "Rueda Automatizada — Fase 2/3/4") a la MISMA forma de salida que
// buildWheelData() (src/wheel.js) — para que el renderer rico de "La Rueda"
// ya construido para Tasty (tabla/cards/rendimiento/semanal en index.html)
// se pueda reusar tal cual en Bitacora Tradier, sin tocar wheel.js ni el
// modelo de datos de Tasty. No escribe nada — funcion pura, sin I/O.
//
// ── UNIDADES (leer antes de tocar nada) ────────────────────────────────
// El modelo de la Rueda automatizada guarda TODAS las primas como precio de
// la opcion POR ACCION (entryFillPrice 1.27, netCredit 0.35, quote.bid...),
// igual que las cotiza Tradier. La salida de este adaptador, en cambio, tiene
// que hablar el mismo idioma que buildWheelData() de Tasty, donde totalPremium
// y los `amount` de los eventos son DOLARES TOTALES — porque asi los renderiza
// la Rueda y asi se restan del costo base (`avgCost - totalPremium / shares`).
//
// Bug corregido 2026-08-03: se mezclaban las dos. totalPremium acumulaba
// precios por accion (1.27) y despues se dividia por las acciones (100), o sea
// que la prima entraba al costo base DIVIDIDA POR 100 DOS VECES. Con el unico
// ciclo real de la epoca (SOFI, Put 18 cobrada a 1.27) la base proyectada salia
// 17.9873 cuando la correcta es 16.73 — la prima practicamente no existia. Y el
// "Prima" de la card mostraba $1.27 en vez de $127. Ahora se convierte a dolares
// en el punto de acumulacion: `precio * 100 * contratos`.
//
// Limitacion previa ya resuelta (mismo pase): la prima de la venta inicial de la
// Covered Call solo vivia en ex.totalCreditAccumulated y el evento STO_CALL iba
// sin monto, asi que se reconstruia con amount:0 y no sumaba a totalPremium.
// server.js ahora guarda `credit` en ese evento; para registros viejos que no lo
// tengan se sigue tratando como 0 (no hay de donde sacarlo sin adivinar).

const PHASE_MAP = { CSP_ACTIVA: 'CSP_ACTIVA', ASIGNADO: 'ACCIONES', CC_ACTIVA: 'CC_ACTIVA', CERRADO: 'IDLE' };

function buildWheelDataFromTradier(executions = []) {
  const bySymbol = {};
  for (const ex of executions) {
    if (!ex || !ex.symbol) continue;
    (bySymbol[ex.symbol] = bySymbol[ex.symbol] || []).push(ex);
  }

  const wheels = [];

  for (const [symbol, recs] of Object.entries(bySymbol)) {
    const sorted = [...recs].sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
    const latest = sorted[sorted.length - 1];

    const events = [];
    let totalPremium = 0;
    let sharesQty = 0;
    let assignedStrike = null; // costo base real una vez asignado

    for (const ex of sorted) {
      const contracts = (ex.leg && ex.leg.contracts) || 1;
      const exEvents = ex.events || [];
      const putRolls = exEvents.filter(e => e.type === 'ROLL' || e.type === 'ROLL_DEFENSIVO');
      // Precio de opcion (por accion) -> dolares totales. Ver nota de UNIDADES arriba.
      const aDolares = (precio) => +((precio || 0) * 100 * contracts).toFixed(2);

      // Entrada del Put — si ya hubo rolls, el primero trae fromStrike/fromExpiry
      // (el leg original antes de rolar); si no, ex.leg todavia tiene el strike
      // de entrada (recien se sobreescribe en el primer roll o en la venta de la Call).
      const entryStrike = putRolls.length ? putRolls[0].fromStrike : (ex.leg && ex.leg.strike);
      const entryExpiry = putRolls.length ? putRolls[0].fromExpiry : (ex.leg && ex.leg.expiry);
      const entryAmount = aDolares(ex.entryFillPrice != null ? ex.entryFillPrice : (ex.creditReceived || 0));
      events.push({ date: (ex.filledAt || ex.timestamp || '').slice(0, 10), type: 'STO_PUT', strike: entryStrike, expiry: entryExpiry, amount: entryAmount });
      totalPremium += entryAmount;

      let runningPutStrike = entryStrike;
      let lastPutExpiry = entryExpiry;
      for (const rv of putRolls) {
        const monto = aDolares(rv.netCredit);
        events.push({ date: (rv.date || '').slice(0, 10), type: 'ROLL', fromStrike: rv.fromStrike, fromExpiry: rv.fromExpiry, toStrike: rv.toStrike, toExpiry: rv.toExpiry, amount: monto });
        totalPremium += monto;
        runningPutStrike = rv.toStrike;
        lastPutExpiry = rv.toExpiry;
      }

      // Asignacion — cualquier fase mas alla de CSP_ACTIVA implica que hubo asignacion
      if (ex.phase !== 'CSP_ACTIVA') {
        assignedStrike = runningPutStrike;
        sharesQty = contracts * 100;
        events.push({ date: lastPutExpiry || '', type: 'ASSIGNED', qty: sharesQty, price: assignedStrike, amount: 0 });
      }

      // Covered Call — venta inicial + rolls. `ce.credit` lo guarda server.js desde
      // 2026-08-03; los registros anteriores no lo traen y quedan en 0 (no hay de
      // donde reconstruirlo sin adivinar).
      const callEvents = exEvents.filter(e => e.type === 'STO_CALL' || e.type === 'ROLL_CALL');
      for (const ce of callEvents) {
        const monto = aDolares(ce.type === 'STO_CALL' ? ce.credit : ce.netCredit);
        if (ce.type === 'STO_CALL') {
          events.push({ date: (ce.date || '').slice(0, 10), type: 'STO_CALL', strike: ce.strike, expiry: ce.expiry, amount: monto });
        } else {
          events.push({ date: (ce.date || '').slice(0, 10), type: 'ROLL', fromStrike: ce.fromStrike, fromExpiry: ce.fromExpiry, toStrike: ce.toStrike, toExpiry: ce.toExpiry, amount: monto });
        }
        totalPremium += monto;
      }

      // Cierre del ciclo
      if (ex.phase === 'CERRADO') {
        const notesLc = (ex.notes || '').toLowerCase();
        if (notesLc.includes('ejercid') && ex.leg) {
          events.push({ date: (ex.leg.expiry || '').slice(0, 10), type: 'STOCK_SELL', qty: sharesQty, price: ex.leg.strike, amount: 0 });
        }
        sharesQty = 0;
        assignedStrike = null;
      }
    }

    events.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    const mappedPhase = PHASE_MAP[latest.phase] || 'IDLE';
    const contracts = (latest.leg && latest.leg.contracts) || 0;
    const activePut = mappedPhase === 'CSP_ACTIVA' && latest.leg ? { strike: latest.leg.strike, expiry: latest.leg.expiry, contracts } : null;
    const activeCall = mappedPhase === 'CC_ACTIVA' && latest.leg ? { strike: latest.leg.strike, expiry: latest.leg.expiry, contracts } : null;
    const shares = (mappedPhase === 'ACCIONES' || mappedPhase === 'CC_ACTIVA') ? contracts * 100 : 0;
    const avgCost = assignedStrike || 0;
    const denom = shares || (contracts * 100) || 1;
    let costBasis = avgCost > 0 ? +(avgCost - totalPremium / denom).toFixed(4) : null;

    // Costo base proyectado (CSP abierta, todavia sin asignar) — mismo fallback
    // que buildWheelData() de Tasty: "si esto se asigna, tu break-even seria X".
    let isProjected = false;
    if (costBasis === null && activePut && activePut.strike > 0 && contracts > 0) {
      costBasis = +(activePut.strike - totalPremium / (contracts * 100)).toFixed(4);
      isProjected = true;
    }

    wheels.push({
      underlying: symbol,
      startDate: null,
      phase: mappedPhase,
      events,
      shares,
      avgCost: +avgCost.toFixed(4),
      costBasis,
      isProjected,
      totalPremium: +totalPremium.toFixed(2),
      contracts,
      contractsPut: mappedPhase === 'CSP_ACTIVA' ? contracts : 0,
      contractsCall: mappedPhase === 'CC_ACTIVA' ? contracts : 0,
      activePut,
      activeCall,
      openStock: null,
    });
  }

  return wheels.sort((a, b) => {
    const ord = { CSP_ACTIVA: 0, CC_ACTIVA: 1, ACCIONES: 2, IDLE: 3 };
    return (ord[a.phase] ?? 9) - (ord[b.phase] ?? 9);
  });
}

module.exports = { buildWheelDataFromTradier };
