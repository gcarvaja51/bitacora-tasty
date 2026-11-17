'use strict';
// ── Espejo del Robot SPX en la Demo Tasty (fase 2, Guillermo 2026-11-16) ─────────────────────────────────────
//
// "Espejo: ambos": durante la semana en paralelo, Mediodía, Iron Condor y Reversión siguen ejecutando en Tradier
// como siempre, y CADA trade que Tradier llena se copia acá, en el libro Robot SPX de la Demo Tasty, con la cadena
// real de TastyTrade. Así se comparan los dos resultados antes de apagar Tradier.
//
// Cómo copia, sin tocar ninguna estrategia: un reconciliador (tick) mira el archivo de ejecuciones del robot.
//   - Ejecución de Tradier que pasa a 'filled' y no tiene gemelo  → abre el gemelo (cotiza, dry-run, llena cruzando).
//   - Gemelo abierto cuya ejecución de Tradier ya cerró           → cierra el gemelo (cruzando), mismo motivo.
// El gemelo nace cuando Tradier LLENA (no cuando sale la señal): una señal que Tradier cancela sin llenar no tiene
// quién le gestione la salida, así que no se copia. Entra unos segundos después que Tradier (retrasoSeg queda escrito).
//
// Reglas del libro, como las aplicaría un broker: no abre si el libro ya alcanzó la meta del día ni si el riesgo
// máximo de la estructura no cabe en el poder de compra disponible. ESTE MÓDULO NUNCA MANDA UNA ORDEN: solo
// /orders/dry-run. Estado en <DATA_DIR>/espejo_robot.json.
//
// Dependencias inyectadas (se prueba sin red): cotizar(simbolos) → { q: { sym: {bid, ask, mark} } } | null,
// dryRun(cuerpo) → { ok, fees, tipo, detalle }, leerEjecuciones() → [...], libro() → { metaAlcanzada, disponible,
// pnlHoy, metaDia }, pnlTradier(ex) → número | null, ahora() → Date.

const fs = require('fs');
const path = require('path');
const { netoCruzando, netoAlMedio, cuerpoOrden, feesEstimadas, pataDesdeOcc } = require('./libro_senales');

const FAMILIAS = ['MEDIODIA', 'NEUTRAL', 'REVERSION'];
const MAX_RETRASO_APERTURA_SEG = 180;   // si Tradier llenó hace más de 3 min y no se pudo copiar, ya no se entra
const MAX_ESPERA_CIERRE_MIN = 20;       // sin precio para cerrar tras 20 min: se asienta con el resultado de Tradier
const r2 = (x) => +Number(x).toFixed(2);

// Patas del gemelo desde el registro de Tradier. legs = { shortSym, longSym } o { putShortSym, putLongSym,
// callShortSym, callLongSym }: lo que dice "Short" va vendido, lo que dice "Long" comprado. q ya lleva los contratos.
function patasDesdeEjecucion(ex) {
  const c = Math.max(1, Number(ex.contracts) || 1);
  const out = [];
  for (const [k, sym] of Object.entries(ex.legs || {})) {
    if (!/Sym$/.test(k) || !sym) continue;
    const p = pataDesdeOcc(sym, /short/i.test(k) ? -c : /long/i.test(k) ? c : 0);
    if (!p || !p.q) return null;
    out.push(p);
  }
  return out.length >= 2 ? out : null;
}

// Pérdida máxima al vencimiento, en dólares, de una estructura que entró a `neto` (+ = crédito; como las q, ya
// incluye los contratos).
// Se evalúa el pago en cada strike y en los extremos: una estructura con una pata vendida sin cubrir da Infinity.
function riesgoMaximo(patas, neto) {
  const strikes = [...new Set(patas.map((p) => p.strike))].sort((a, b) => a - b);
  const pago = (x) => patas.reduce((a, p) => a + p.q * Math.max(0, p.tipo === 'C' ? x - p.strike : p.strike - x), 0);
  const puntos = [0, ...strikes];
  const peor = Math.min(...puntos.map(pago));
  const callsNetas = patas.filter((p) => p.tipo === 'C').reduce((a, p) => a + p.q, 0);
  if (callsNetas < 0) return Infinity;                       // call vendida sin cubrir: riesgo ilimitado hacia arriba
  return r2(Math.max(0, -(peor + neto) * 100));
}

function crearEspejoRobot({ dataDir, cotizar, dryRun, leerEjecuciones, libro = () => null, pnlTradier = () => null,
                            ahora = () => new Date(), familias = FAMILIAS, archivo = 'espejo_robot.json' }) {
  const ARCHIVO = path.join(dataDir, archivo);
  const cargar = () => { try { return JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')); } catch (e) { return null; } };
  const guardar = (L) => fs.writeFileSync(ARCHIVO, JSON.stringify(L, null, 1), 'utf8');
  let cola = Promise.resolve();
  const enCola = (fn) => { const t = cola.then(fn, fn); cola = t.catch(() => {}); return t; };

  // El espejo solo copia lo que Tradier abra DESPUÉS de encenderse: lo anterior no se reconstruye.
  function estado() {
    let L = cargar();
    if (!L) { L = { desde: ahora().toISOString(), registros: [] }; guardar(L); }
    return L;
  }

  function base(ex, extra) {
    return { id: `esp-${ex.id}`, espejoDe: ex.id, espejo: true, broker: 'tasty_demo', strategyFamily: ex.strategyFamily,
             strategy: ex.strategy, strikes: ex.strikes || null, expiry: ex.expiry || ex.strikes?.expiry || null,
             contracts: Math.max(1, Number(ex.contracts) || 1), timestamp: ahora().toISOString(), ...extra };
  }

  async function abrir(L, ex) {
    const now = ahora();
    const retraso = Math.round((now - new Date(ex.filledAt || ex.timestamp)) / 1000);
    const patas = patasDesdeEjecucion(ex);
    const noAbre = (motivo) => { L.registros.push(base(ex, { status: 'no_abierta', motivo, patas })); return 'NO_ABIERTA'; };
    if (!patas) return noAbre('no se pudieron leer las patas de la ejecución de Tradier');
    if (retraso > MAX_RETRASO_APERTURA_SEG) return noAbre(`Tradier llenó hace ${retraso} s: demasiado tarde para copiar la entrada`);
    const lb = libro();
    if (lb?.metaAlcanzada) return noAbre(`meta del día alcanzada: el libro lleva $${lb.pnlHoy} cerrados hoy (meta $${lb.metaDia})`);
    const c = await cotizar(patas.map((p) => p.sym));
    const neto = c ? netoCruzando(patas, c.q, 'abrir') : null;
    if (neto == null) return 'ESPERA';                         // se reintenta en el próximo tick, hasta el tope de retraso
    const riesgo = riesgoMaximo(patas, neto);
    if (lb && riesgo > lb.disponible) return noAbre(`sin poder de compra: la estructura arriesga $${riesgo} y el libro tiene $${lb.disponible} disponibles`);
    const nC = Math.max(1, Number(ex.contracts) || 1);          // el límite de la orden va por unidad, no por el total
    const dr = await dryRun(cuerpoOrden(patas, neto / nC, true));
    if (!dr.ok) {
      if (dr.tipo === 'rechazo') return noAbre(`TastyTrade rechazó el dry-run: ${dr.detalle}`);
      return 'ESPERA';
    }
    const fees = dr.fees != null ? dr.fees : feesEstimadas(patas, true);
    L.registros.push(base(ex, {
      status: 'filled', patas, isCredit: neto >= 0, riesgoUsd: riesgo, filledAt: now.toISOString(),
      entrada: { at: now.toISOString(), precio: neto, porContrato: r2(neto / nC), alMedio: netoAlMedio(patas, c.q, 'abrir'), fees, feesEstimadas: dr.fees == null },
      feesApertura: fees, retrasoSeg: retraso,
      // Tradier guarda el fill con signo contrario (negativo = crédito cobrado): acá + = crédito, igual que `precio`.
      tradierEntrada: typeof ex.entryFillPrice === 'number' ? r2(-ex.entryFillPrice) : null,
    }));
    return 'ABIERTA';
  }

  async function cerrar(g, ex) {
    const now = ahora();
    g.cierrePedidoAt = g.cierrePedidoAt || now.toISOString();
    const tradier = pnlTradier(ex);
    const asentar = (salida, fees, extra = {}) => {
      Object.assign(g, {
        status: 'closed', closedAt: now.toISOString(), closeReason: ex.closeReason || ex.status || 'CIERRE_TRADIER',
        salida: { at: now.toISOString(), precio: salida, fees }, feesCierre: fees,
        pnlBruto: salida == null ? null : r2((g.entrada.precio + salida) * 100),
        tradierPnl: typeof tradier === 'number' ? r2(tradier) : null, ...extra,
      });
      if (g.pnlBruto != null) g.pnlNeto = r2(g.pnlBruto - (g.feesApertura || 0) - fees);
      return 'CERRADA';
    };
    let c = null;
    try { c = await cotizar(g.patas.map((p) => p.sym)); } catch (e) { /* sin precio: se reintenta */ }
    const neto = c ? netoCruzando(g.patas, c.q, 'cerrar') : null;
    if (neto != null) {
      const dr = await dryRun(cuerpoOrden(g.patas, neto / (g.contracts || 1), false)).catch(() => ({ ok: false }));
      const fees = dr.ok && dr.fees != null ? dr.fees : feesEstimadas(g.patas, false);
      return asentar(neto, fees, { feesCierreEstimadas: !(dr.ok && dr.fees != null) });
    }
    // Sin cotización (típico: el 0DTE ya venció). Tras la espera se asienta con el resultado de Tradier, marcado.
    if ((now - new Date(g.cierrePedidoAt)) / 60000 < MAX_ESPERA_CIERRE_MIN) return 'ESPERA';
    if (typeof tradier === 'number') {
      const feesC = feesEstimadas(g.patas, false);
      Object.assign(g, { status: 'closed', closedAt: now.toISOString(), closeReason: ex.closeReason || 'CIERRE_TRADIER',
        salida: null, feesCierre: feesC, feesCierreEstimadas: true, pnlBruto: r2(tradier),
        pnlNeto: r2(tradier - (g.feesApertura || 0) - feesC), tradierPnl: r2(tradier), salidaDeTradier: true,
        nota: 'TastyTrade no cotizó las patas al cierre: se asentó con el resultado de Tradier' });
      return 'CERRADA';
    }
    return 'ESPERA';
  }

  // Una pasada del reconciliador. Devuelve qué hizo (para el log); nunca lanza.
  function tick() {
    return enCola(async () => {
      const L = estado();
      const ejec = leerEjecuciones() || [];
      const porId = new Map(ejec.map((e) => [e.id, e]));
      const conGemelo = new Set(L.registros.map((g) => g.espejoDe));
      const hechos = [];
      for (const ex of ejec) {
        if (!familias.includes(ex.strategyFamily) || ex.broker === 'tasty_demo' || conGemelo.has(ex.id)) continue;
        if (String(ex.timestamp) < L.desde || ex.status !== 'filled') continue;
        try { const r = await abrir(L, ex); if (r !== 'ESPERA') hechos.push(`${ex.strategyFamily} ${ex.id}: ${r}`); }
        catch (e) { hechos.push(`${ex.id}: error al abrir (${e.message})`); }
      }
      for (const g of L.registros.filter((x) => x.status === 'filled')) {
        const ex = porId.get(g.espejoDe);
        if (ex && ex.status === 'filled') continue;            // Tradier sigue abierto: el gemelo también
        try { const r = await cerrar(g, ex || { status: 'desaparecida', closeReason: 'ORIGEN_NO_ENCONTRADO' }); if (r !== 'ESPERA') hechos.push(`${g.strategyFamily} ${g.id}: ${r}`); }
        catch (e) { hechos.push(`${g.id}: error al cerrar (${e.message})`); }
      }
      if (hechos.length) guardar(L); else if (L.registros.some((g) => g.cierrePedidoAt && g.status === 'filled')) guardar(L);
      return hechos;
    });
  }

  // Registros con forma de ejecución, para sumarlos al libro Robot SPX (cuentaDemoTendencia).
  const registros = () => (cargar()?.registros || []).filter((g) => g.status === 'filled' || g.status === 'closed');

  // Comparación Tradier vs Demo Tasty, por estrategia, sobre los pares ya cerrados.
  function resumen() {
    const L = cargar() || { desde: null, registros: [] };
    const fam = {};
    for (const g of L.registros) {
      const f = fam[g.strategyFamily] = fam[g.strategyFamily] || { estrategia: g.strategyFamily, copiados: 0, abiertos: 0, cerrados: 0,
        noAbiertos: 0, demoNeto: 0, tradierBruto: 0, comparables: 0, retrasoProm: null, _ret: [] };
      if (g.status === 'no_abierta') { f.noAbiertos++; continue; }
      f.copiados++;
      if (g.retrasoSeg != null) f._ret.push(g.retrasoSeg);
      if (g.status === 'filled') f.abiertos++;
      if (g.status === 'closed') {
        f.cerrados++;
        f.demoNeto = r2(f.demoNeto + (g.pnlNeto || 0));
        if (typeof g.tradierPnl === 'number' && !g.salidaDeTradier) { f.comparables++; f.tradierBruto = r2(f.tradierBruto + g.tradierPnl); }
      }
    }
    for (const f of Object.values(fam)) { f.retrasoProm = f._ret.length ? Math.round(f._ret.reduce((a, b) => a + b, 0) / f._ret.length) : null; delete f._ret; }
    return { ok: true, desde: L.desde, familias, porEstrategia: Object.values(fam),
             registros: [...L.registros].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))).slice(0, 200) };
  }

  return { tick, registros, resumen, _estado: estado };
}

module.exports = { crearEspejoRobot, patasDesdeEjecucion, riesgoMaximo, FAMILIAS };
