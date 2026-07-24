'use strict';

// Adaptador de un solo sentido: reproduce el mismo algoritmo de agrupacion
// (spread/naked/CC, meta 50/25/25) que ya usa GET /api/bp-dashboard para
// TastyTrade (server.js), pero contra el esquema crudo de posiciones de
// Tradier — cantidad CON SIGNO (negativo = corto), sin `instrument-type` ni
// `underlying-symbol` (hay que parsear el simbolo OCC para sacar ambos).
// Funcion pura, sin I/O — server.js le pasa balances/posiciones/wheelSymbols
// ya resueltos.
//
// Confirmado contra datos reales (2026-07-24, lectura de solo lectura,
// GET /accounts/.../positions): el simbolo OCC de Tradier viene SIN espacio
// (ej. "ANET260814P00160000") — la misma regex tolerante que ya usa
// server.js para TastyTrade (que SI trae espacio) matchea ambos formatos
// porque el separador es `\s*` (cero o mas espacios), no exige uno.

function parseOccSymbol(sym) {
  const m = (sym || '').trim().match(/([A-Z/]+?)\s*(\d{6})([CP])(\d{8})$/);
  if (!m) return null; // no matchea patron de opcion -> es equity/stock
  return {
    root:   m[1],
    optType: m[3],
    strike:  parseInt(m[4], 10) / 1000,
    expiry:  `20${m[2].slice(0, 2)}-${m[2].slice(2, 4)}-${m[2].slice(4, 6)}`,
  };
}

function buildBPDashboardFromTradier(positions = [], balances = {}, wheelSymbols = new Set()) {
  const derivAvail  = parseFloat(balances.pdt?.option_buying_power ?? balances.margin?.option_buying_power ?? 0);
  const equityAvail = parseFloat(balances.pdt?.stock_buying_power  ?? balances.margin?.stock_buying_power  ?? 0);
  const nlv         = parseFloat(balances.total_equity || 0);

  const equityPos = [];
  const optPos    = [];
  for (const p of positions) {
    const parsed = parseOccSymbol(p.symbol || '');
    if (parsed) optPos.push({ ...p, ...parsed, underlying: parsed.root });
    else        equityPos.push(p);
  }

  const stockUnds = new Set(equityPos.map(p => p.symbol));

  // Agrupar opciones por (underlying, expiry, optType)
  const optGroups = {};
  for (const p of optPos) {
    const key = `${p.underlying}|${p.expiry}|${p.optType}`;
    if (!optGroups[key]) optGroups[key] = { und: p.underlying, expiry: p.expiry, optType: p.optType, shorts: [], longs: [] };
    const qtySigned = parseFloat(p.quantity || 0);
    const entry = { strike: p.strike, qty: Math.abs(qtySigned) };
    if (qtySigned < 0) optGroups[key].shorts.push(entry);
    else                optGroups[key].longs.push(entry);
  }

  const ruedaOptPos = [];
  const specOptPos  = [];

  for (const g of Object.values(optGroups)) {
    const isWheel = wheelSymbols.has(g.und);
    const arr = isWheel ? ruedaOptPos : specOptPos;
    const { shorts, longs, und, expiry, optType } = g;

    if (shorts.length > 0 && longs.length > 0) {
      const shortStrikes = shorts.map(s => s.strike);
      const longStrikes  = longs.map(s => s.strike);
      const qty = Math.min(
        shorts.reduce((s, x) => s + x.qty, 0),
        longs.reduce((s, x) => s + x.qty, 0)
      );
      let width;
      if (optType === 'P') width = Math.max(...shortStrikes) - Math.min(...longStrikes);
      else                  width = Math.max(...longStrikes) - Math.min(...shortStrikes);
      const bpUsed = Math.max(0, width) * 100 * qty;
      const lS = optType === 'P' ? Math.min(...longStrikes) : Math.max(...longStrikes);
      arr.push({ underlying: und, type: 'Spread', qty, bpUsed: +bpUsed.toFixed(2),
        label: `${optType === 'P' ? 'Put' : 'Call'} spread $${lS}/$${Math.max(...shortStrikes)} (${expiry})` });

    } else if (shorts.length > 0) {
      for (const s of shorts) {
        let bpUsed, label;
        if (optType === 'C' && (isWheel || stockUnds.has(und))) {
          bpUsed = 0;
          label  = `CC $${s.strike} cubierta (${expiry})`;
        } else {
          bpUsed = s.strike * 100 * s.qty;
          label  = `${optType === 'P' ? 'CSP' : 'Short Call'} $${s.strike} (${expiry})`;
        }
        arr.push({ underlying: und, type: 'Short Option', qty: s.qty, bpUsed: +bpUsed.toFixed(2), label });
      }
    }
    // Longs sin short: no consumen BP adicional (prima ya pagada)
  }

  // Acciones — cost_basis de Tradier es el monto TOTAL de la posicion (no
  // por accion, a diferencia de average-open-price de TastyTrade), asi que
  // el precio promedio se deriva dividiendo por la cantidad.
  const ruedaStockPos = [];
  const specStockPos  = [];
  for (const p of equityPos) {
    const und  = p.symbol || '';
    const qty  = Math.abs(parseFloat(p.quantity || 0));
    if (!qty) continue;
    const avgP = Math.abs(parseFloat(p.cost_basis || 0)) / qty;
    const entry = { underlying: und, type: 'Equity', qty,
      bpUsed: +(avgP * qty).toFixed(2), label: `${qty} acc @ $${avgP.toFixed(2)}` };
    if (wheelSymbols.has(und)) ruedaStockPos.push(entry);
    else                        specStockPos.push(entry);
  }

  const ruedaOptBP   = ruedaOptPos.reduce((s, p) => s + p.bpUsed, 0);
  const specOptBP    = specOptPos.reduce((s, p) => s + p.bpUsed, 0);
  const ruedaStockBP = ruedaStockPos.reduce((s, p) => s + p.bpUsed, 0);
  const specStockBP  = specStockPos.reduce((s, p) => s + p.bpUsed, 0);

  const optionsBase = ruedaOptBP + specOptBP + derivAvail || 1;
  const libreBP = derivAvail;
  const base    = optionsBase;

  const pctRueda = +(ruedaOptBP / base * 100).toFixed(1);
  const pctSpec  = +(specOptBP  / base * 100).toFixed(1);
  const pctLibre = +(libreBP    / base * 100).toFixed(1);

  return {
    base,
    ruedaBP:      +ruedaOptBP.toFixed(2),
    specBP:       +specOptBP.toFixed(2),
    libreBP:      +libreBP.toFixed(2),
    ruedaStockBP: +ruedaStockBP.toFixed(2),
    specStockBP:  +specStockBP.toFixed(2),
    nlv,
    pctRueda, pctSpec, pctLibre,
    derivAvail:  +derivAvail.toFixed(2),
    equityAvail: +equityAvail.toFixed(2),
    targets: { rueda: 50, spec: 25, libre: 25 },
    ruedaPos: [...ruedaOptPos, ...ruedaStockPos],
    specPos:  [...specOptPos, ...specStockPos],
    ts: new Date().toISOString(),
  };
}

module.exports = { buildBPDashboardFromTradier, parseOccSymbol };
