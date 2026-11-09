'use strict';
// ── Ejecutor del direccional en TastyTrade (Guillermo 2026-11-09) ───────────────────────────
//
// "si el robot funciona como espero, ejecutaria trades sobre tasty y me gustaria que el demo utilizara toda la
// informacion o la mayoria sobre tasty". Reemplaza el envio de ordenes al sandbox de Tradier para TENDENCIA.
//
// Decisiones de Guillermo (2026-11-09):
//   - Llenado demo CRUZANDO el spread: la misma marca del libro propio (marcarPaper en server.js), que mide el P&L
//     oficial desde el 16-ago. Asi la serie historica sigue siendo comparable.
//   - Si el dry-run de TastyTrade falla al ABRIR: no se abre y se avisa (con dinero real esa orden tampoco saldria).
//     Al CERRAR, un dry-run fallido nunca bloquea el cierre: la comision se estima con la de la apertura.
//   - Cuenta demo propia del robot, $10.000 (la calcula server.js con el P&L oficial de los trades de este ejecutor).
//
// Mismo metodo que la demo del Clic SPX (src/clic_real.js): la orden se valida contra la cuenta real con
// /orders/dry-run, que devuelve las comisiones reales. ESTE MODULO NUNCA MANDA UNA ORDEN: la unica ruta de escritura
// que toca es /orders/dry-run. El modo 'tasty_real' todavia no esta implementado y lo rechaza.
//
// Funciones puras salvo las dos llamadas inyectadas (tt._req y marcar), asi se prueban sin red.

const MODOS = ['tradier', 'tasty_demo', 'tasty_real'];
const MODO_DEFAULT = 'tradier';

// Tradier: SPXW261109P07545000 -> TastyTrade: "SPXW  261109P07545000" (raiz padeada a 6)
function aSimboloTasty(simTradier) {
  const m = String(simTradier || '').match(/^([A-Z]+)(\d{6}[CP]\d{8})$/);
  return m ? m[1].padEnd(6, ' ') + m[2] : null;
}

function modoValido(m) {
  return MODOS.includes(m) ? m : MODO_DEFAULT;
}

// Orden limite de una vertical, en el formato de TastyTrade. `credito` es el de la ESTRUCTURA (Bull Put / Bear Call),
// no el de la orden: al cerrar un credito se paga (Debit).
function cuerpoOrden({ legs, contratos, credito }, precio, abrir) {
  const corta = aSimboloTasty(legs?.shortSym), larga = aSimboloTasty(legs?.longSym);
  if (!corta || !larga) throw new Error(`patas invalidas: ${legs?.shortSym} / ${legs?.longSym}`);
  const efecto = (abrir ? !credito : credito) ? 'Debit' : 'Credit';
  const q = Math.max(1, Math.round(Number(contratos) || 1));
  return {
    'time-in-force': 'Day',
    'order-type': 'Limit',
    price: Math.max(0.05, Math.abs(Number(precio) || 0)).toFixed(2),
    'price-effect': efecto,
    legs: [
      { 'instrument-type': 'Equity Option', symbol: corta, quantity: q, action: abrir ? 'Sell to Open' : 'Buy to Close' },
      { 'instrument-type': 'Equity Option', symbol: larga, quantity: q, action: abrir ? 'Buy to Open' : 'Sell to Close' },
    ],
  };
}

// Una respuesta de error de TastyTrade llega como "TT API 422 /path: {json}". Se distingue el RECHAZO (la orden no
// sirve: simbolo, poder de compra, mercado) de la FALLA de red o del servidor (5xx, timeout), para el aviso.
function clasificarError(e) {
  const msg = String(e?.message || e || '');
  const m = msg.match(/TT API (\d{3})/);
  const status = m ? Number(m[1]) : null;
  let detalle = msg;
  const j = msg.indexOf('{');
  if (j >= 0) {
    try {
      const body = JSON.parse(msg.slice(j));
      const err = body?.error || {};
      const partes = [err.message, ...((err.errors || []).map((x) => x.message || x.code))].filter(Boolean);
      if (partes.length) detalle = partes.join(' · ');
    } catch (_) { /* se deja el texto crudo */ }
  }
  return { tipo: status && status >= 400 && status < 500 ? 'rechazo' : 'red', status, detalle: detalle.slice(0, 300) };
}

function crearEjecutorTasty({ tt, cuenta, marcar, log = console }) {
  if (!tt || typeof tt._req !== 'function') throw new Error('ejecutor_tasty: falta el cliente de TastyTrade');
  if (typeof marcar !== 'function') throw new Error('ejecutor_tasty: falta la funcion de marca (marcarPaper)');
  const nCuenta = () => (typeof cuenta === 'function' ? cuenta() : cuenta) || tt.accountNumber;

  async function dryRun(cuerpo) {
    try {
      const r = await tt._req(`/accounts/${nCuenta()}/orders/dry-run`, { method: 'POST', body: JSON.stringify(cuerpo) });
      const d = r?.data || {};
      const fees = Number(d?.['fee-calculation']?.['total-fees']);
      return {
        ok: true,
        fees: Number.isFinite(fees) ? +Math.abs(fees).toFixed(2) : null,
        avisos: (d.warnings || []).map((w) => w.message || w.code).filter(Boolean),
        bpEfecto: d?.['buying-power-effect']?.['change-in-buying-power'] ?? null,
      };
    } catch (e) {
      return { ok: false, ...clasificarError(e) };
    }
  }

  // Abre en la demo. Devuelve { ok:true, marca, precio, fees, dryRun } o { ok:false, motivo, etapa }.
  // La marca se toma ANTES del dry-run: es el precio en el instante de la decision, igual que hoy con Tradier.
  async function abrirDemo({ legs, contratos = 1, credito }) {
    const marca = await marcar(legs, 'apertura');
    if (!marca || !marca.confiable || typeof marca.neto !== 'number') {
      return { ok: false, etapa: 'marca', marca, motivo: `sin precio confiable de TastyTrade: ${marca?.motivo || 'sin dato'}` };
    }
    // Una vertical de credito cobra al abrir (neto > 0); una de debito paga (neto < 0). Si sale al reves, la cadena
    // esta rota (cotizaciones cruzadas) y no hay un precio de llenado creible.
    if (credito ? marca.neto <= 0 : marca.neto >= 0) {
      return { ok: false, etapa: 'marca', marca,
               motivo: `precio incoherente para un ${credito ? 'credito' : 'debito'}: neto ${marca.neto} cruzando` };
    }
    const precio = +Math.abs(marca.neto).toFixed(2);
    let cuerpo;
    try { cuerpo = cuerpoOrden({ legs, contratos, credito }, precio, true); }
    catch (e) { return { ok: false, etapa: 'orden', marca, motivo: e.message }; }
    const dr = await dryRun(cuerpo);
    if (!dr.ok) {
      return { ok: false, etapa: 'dry-run', marca, dryRun: dr,
               motivo: `TastyTrade ${dr.tipo === 'rechazo' ? 'rechazo' : 'no respondio'} el dry-run${dr.status ? ` (${dr.status})` : ''}: ${dr.detalle}` };
    }
    return { ok: true, marca, precio, fees: dr.fees, dryRun: dr };
  }

  // Cierra en la demo. Nunca deja un trade colgado por el dry-run: si falla, se cierra igual con la comision de la
  // apertura como estimado (`feesEstimadas: true`). Solo devuelve ok:false si no hay ningun precio de salida
  // (TastyTrade no cotizo las patas): ahi el llamador reintenta en el proximo ciclo.
  async function cerrarDemo({ legs, contratos = 1, credito, feesApertura = null }) {
    const marca = await marcar(legs, 'cierre');
    if (!marca || typeof marca.neto !== 'number') {
      return { ok: false, etapa: 'marca', marca, motivo: `sin precio de TastyTrade para cerrar: ${marca?.motivo || 'sin dato'}` };
    }
    const precio = +Math.abs(marca.neto).toFixed(2);
    let dr;
    try { dr = await dryRun(cuerpoOrden({ legs, contratos, credito }, precio, false)); }
    catch (e) { dr = { ok: false, tipo: 'orden', detalle: e.message }; }
    const fees = dr.ok && dr.fees != null ? dr.fees : feesApertura;
    if (!dr.ok) log.warn?.(`[EJECUTOR-TASTY] dry-run de cierre fallido (${dr.detalle || dr.tipo}) — se cierra igual con la comision de la apertura.`);
    return { ok: true, marca, precio, fees, feesEstimadas: !(dr.ok && dr.fees != null), dryRun: dr };
  }

  return { dryRun, abrirDemo, cerrarDemo };
}

// Campos que deja un cierre de la demo sobre el registro de la ejecucion. Funcion pura: el llamador hace
// Object.assign(ex, asentarCierreDemo(ex, rc)). Misma convencion de signos que cerrarLibroPaper (server.js):
// las dos marcas vienen con "positivo = entra plata", asi que el P&L por accion es la SUMA. La diferencia es la
// comision: aca es la REAL de TastyTrade (dry-run de apertura + de cierre), no la estimacion de Tradier.
function asentarCierreDemo(ex, rc, ahora = new Date().toISOString()) {
  const entrada = ex.paperEntry, salida = rc.marca;
  const contratos = ex.contracts || 1;
  const feesAp = Number(ex.feesApertura) || 0;
  const feesCi = rc.fees != null ? Number(rc.fees) : feesAp;
  const out = {
    paperExit: salida,
    feesCierre: +feesCi.toFixed(2),
    feesCierreEstimadas: !!rc.feesEstimadas,
    dryRunCierre: rc.dryRun || null,
    status: 'closed',
    closedAt: ahora,
    closeOrderSentAt: ahora,
    pnlSource: 'tasty_demo',
  };
  if (entrada?.confiable && typeof entrada.neto === 'number' && typeof salida?.neto === 'number') {
    const bruto = +((entrada.neto + salida.neto) * 100 * contratos).toFixed(2);
    const comision = +(feesAp + feesCi).toFixed(2);
    out.paperPnl = {
      bruto,
      neto: +(bruto - comision).toFixed(2),
      comisionAsumida: comision,
      comisionReal: !rc.feesEstimadas,
      contratos,
      entrada: entrada.neto,
      salida: salida.neto,
      costoCruceTotal: +((entrada.costoCruce ?? 0) + (salida.costoCruce ?? 0)).toFixed(2),
      // Una salida con cotizacion de mas de 15 s se cierra igual (nunca se deja colgado un trade), pero queda
      // fuera de los comparables: el precio no se pudo verificar.
      confiable: !!salida.confiable,
      ...(salida.confiable ? {} : { motivo: `cierre con marca no confiable: ${salida.motivo || 'sin dato'}` }),
    };
    out.pnl = bruto;
  } else {
    out.paperPnl = { confiable: false, motivo: !entrada?.confiable ? 'apertura sin marca confiable' : 'cierre sin precio' };
    out.pnl = null;
  }
  return out;
}

// Saldo de la cuenta demo del robot: capital inicial + P&L oficial de lo cerrado - comisiones reales de TastyTrade.
// `pnlDe(ex)` lo inyecta server.js (resultadoOficial). Funcion pura.
function cuentaDemoTendencia(ejecuciones, { capital = 10000, pnlDe }) {
  const propias = (ejecuciones || []).filter((e) => e.broker === 'tasty_demo');
  const cerradas = propias.filter((e) => e.status === 'closed')
    .sort((a, b) => String(a.closedAt).localeCompare(String(b.closedAt)));
  const abiertas = propias.filter((e) => e.status === 'filled');
  let saldo = capital, pico = capital, dd = 0, ganadores = 0, comisiones = 0;
  const curva = [{ t: propias.length ? propias.map((e) => e.timestamp).sort()[0] : null, saldo: capital }];
  for (const e of cerradas) {
    const bruto = pnlDe(e);
    if (typeof bruto !== 'number') continue;
    const fees = (Number(e.feesApertura) || 0) + (Number(e.feesCierre) || 0);
    const neto = bruto - fees;
    comisiones += fees;
    if (bruto > 0) ganadores++;
    saldo += neto; pico = Math.max(pico, saldo); dd = Math.max(dd, pico - saldo);
    curva.push({ t: e.closedAt, saldo: +saldo.toFixed(2) });
  }
  const reservado = abiertas.reduce((a, e) => {
    const ancho = Math.abs((e.strikes?.shortStrike ?? 0) - (e.strikes?.longStrike ?? 0));
    const prima = Math.abs(e.paperEntry?.neto ?? 0);
    const riesgo = (e.isCredit ? ancho - prima : prima) * 100 * (e.contracts || 1);
    return a + Math.max(0, riesgo);
  }, 0);
  return {
    capital,
    saldo: +saldo.toFixed(2),
    disponible: +(saldo - reservado).toFixed(2),
    reservado: +reservado.toFixed(2),
    cerrados: cerradas.length,
    abiertos: abiertas.length,
    ganadores,
    comisiones: +comisiones.toFixed(2),
    maxDrawdown: +dd.toFixed(2),
    curva,
  };
}

module.exports = { crearEjecutorTasty, cuentaDemoTendencia, asentarCierreDemo, cuerpoOrden, aSimboloTasty, clasificarError, modoValido, MODOS, MODO_DEFAULT };
