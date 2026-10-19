'use strict';
// ── Clic en TradingView → vertical 0DTE del SPX en TastyTrade REAL (Guillermo 2026-10-19) ──
//
// "hagamos el mismo bot pero ahora vamos con valores reales y dinero real, vamos a hacerlo hacia tastytrade".
// Mismo camino que CLIC_TV (estructura y strikes de processDirectionalEntry sobre la cadena real de TastyTrade,
// ancho 5, credito >= 1.20 / debito <= 3.80, 1 contrato), pero la orden sale a la cuenta REAL en dos pasos:
//   1. preview  -> elige el vertical, cotiza y hace el dry-run en TastyTrade (no manda nada)
//   2. ejecutar -> solo despues de que Guillermo lo aprueba en el PC; recotiza y, si el precio no se movio de mas,
//                  manda una orden LIMITE al medio y la persigue de a 0.05 hasta el natural; si no llena, la cancela.
// Cierre con el clic (quedar plano en TradingView) o, como seguro, a las 15:30 ET. Freno diario de $400.
//
// CLIC_REAL_MODO (env): 'apagado' (default) | 'dryrun' (todo igual pero la orden va a /orders/dry-run y el fill se
// simula al precio limite) | 'real'. Nada sale a la cuenta hasta que se ponga 'real' a proposito.

const fs = require('fs');
const path = require('path');

const ACCION = {
  BULL_CALL_SPREAD: { tipo: 'C', credito: false, nombre: 'Bull Call Spread' },
  BEAR_PUT_SPREAD:  { tipo: 'P', credito: false, nombre: 'Bear Put Spread' },
  BULL_PUT_SPREAD:  { tipo: 'P', credito: true,  nombre: 'Bull Put Spread' },
  BEAR_CALL_SPREAD: { tipo: 'C', credito: true,  nombre: 'Bear Call Spread' },
};
const TICK = 0.05;
const r05 = (x, arriba) => +((arriba ? Math.ceil(x / TICK - 1e-9) : Math.floor(x / TICK + 1e-9)) * TICK).toFixed(2);
const fechaET = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function crearClicReal({ tt, dataDir, horaETmin, isMarketHours, obtenerSenal, avisar = () => {} }) {
  const ARCHIVO = path.join(dataDir, 'clic_real.json');
  const modo = () => String(process.env.CLIC_REAL_MODO || 'apagado').toLowerCase();
  const frenoUsd = () => Number(process.env.CLIC_REAL_FRENO_USD || 400);
  const tolPts = () => Number(process.env.CLIC_REAL_TOL_PTS || 0.15);
  const cuenta = () => process.env.CLIC_REAL_CUENTA || tt.accountNumber;
  const previews = new Map();
  let ocupado = false;               // una orden a la vez: un segundo pedido mientras otro corre se rechaza

  const cargar = () => { try { return JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')); } catch (e) { return []; } };
  const guardar = (l) => fs.writeFileSync(ARCHIVO, JSON.stringify(l, null, 2), 'utf8');
  const abierta = () => cargar().find((x) => (x.estado === 'abierta' || x.estado === 'cerrando') && x.modo === modo());

  // cotizacion del vertical: solo las dos patas, directo de TastyTrade /market-data (< 1 s; la cadena entera tarda ~35 s)
  async function cotizar(legs) {
    const params = [legs.comprada, legs.vendida].map((x) => `symbols[]=${encodeURIComponent(x)}`).join('&');
    const d = await tt._req(`/market-data?${params}`);
    const q = {};
    for (const it of d?.data?.items || []) {
      q[it.symbol] = { bid: Number(it.bid), ask: Number(it.ask), delta: Number(it.delta || 0) };
    }
    const comprada = q[legs.comprada], vendida = q[legs.vendida];
    if (!comprada || !vendida || !Number.isFinite(comprada.bid) || !Number.isFinite(vendida.ask)) throw new Error('sin cotizacion de las patas');
    return {
      medio: +((comprada.bid + comprada.ask) / 2 - (vendida.bid + vendida.ask) / 2).toFixed(2),
      // compraNat: abrir un debito ya (comprar la comprada al ask, vender la vendida al bid). En un credito,
      // -compraNat es lo que se cobra al abrir ya. ventaNat: cerrar un debito ya; en un credito, -ventaNat es lo que
      // cuesta recomprarlo ya.
      compraNat: +(comprada.ask - vendida.bid).toFixed(2),
      ventaNat: +(comprada.bid - vendida.ask).toFixed(2),
      deltaNeto: +((comprada.delta || 0) - (vendida.delta || 0)).toFixed(3),
    };
  }

  function cuerpoOrden(rec, precio, abrir) {
    const credito = rec.credito;
    // abrir debito = Debit; abrir credito = Credit; cerrar al reves
    const efecto = (abrir ? !credito : credito) ? 'Debit' : 'Credit';
    return {
      'time-in-force': 'Day', 'order-type': 'Limit', price: Math.abs(precio).toFixed(2), 'price-effect': efecto,
      legs: [
        { 'instrument-type': 'Equity Option', symbol: rec.legs.comprada, quantity: rec.contratos, action: abrir ? 'Buy to Open' : 'Sell to Close' },
        { 'instrument-type': 'Equity Option', symbol: rec.legs.vendida, quantity: rec.contratos, action: abrir ? 'Sell to Open' : 'Buy to Close' },
      ],
    };
  }

  async function dryRun(cuerpo) {
    return tt._req(`/accounts/${cuenta()}/orders/dry-run`, { method: 'POST', body: JSON.stringify(cuerpo) });
  }

  function precioLleno(o, rec) {
    let neto = 0, n = 0;
    for (const l of o.legs || []) for (const f of l.fills || []) {
      const v = Number(f['fill-price']) * Number(f.quantity);
      neto += /^Buy/.test(l.action) ? v : -v; n++;
    }
    return n ? +(Math.abs(neto) / rec.contratos).toFixed(2) : null;
  }
  const leerOrden = async (id) => (await tt._req(`/accounts/${cuenta()}/orders/${id}`))?.data || {};

  // manda la orden y la persigue: precios = [medio, ..., natural]. Devuelve {lleno, precio, orderId} o {lleno:false}
  async function mandarYPerseguir(rec, precios, abrir, esperaMs = 8000) {
    if (modo() === 'dryrun') {
      const dr = await dryRun(cuerpoOrden(rec, precios[0], abrir));
      return { lleno: true, precio: precios[0], orderId: 'DRYRUN', simulado: true, fees: dr?.data?.['fee-calculation'] || null };
    }
    let orderId = null;
    for (let i = 0; i < precios.length; i++) {
      const cuerpo = cuerpoOrden(rec, precios[i], abrir);
      if (!orderId) {
        const r = await tt._req(`/accounts/${cuenta()}/orders`, { method: 'POST', body: JSON.stringify(cuerpo) });
        orderId = r?.data?.order?.id;
        if (!orderId) throw new Error('TastyTrade no devolvio id de orden');
        console.log(`[CLIC_REAL] orden ${orderId} ${abrir ? 'apertura' : 'cierre'} a ${precios[i]}`);
      } else {
        try {   // subir/bajar el precio = reemplazar la orden (TastyTrade le da id nuevo)
          const r = await tt._req(`/accounts/${cuenta()}/orders/${orderId}`, { method: 'PUT', body: JSON.stringify(cuerpo) });
          orderId = r?.data?.order?.id || r?.data?.id || orderId;
          console.log(`[CLIC_REAL] orden ${orderId} reemplazada a ${precios[i]}`);
        } catch (e) {
          const o = await leerOrden(orderId);          // si ya se lleno, el reemplazo falla: se toma el fill
          if (o.status === 'Filled') return { lleno: true, precio: precioLleno(o, rec) ?? precios[i - 1], orderId };
          throw e;
        }
      }
      const fin = Date.now() + esperaMs;
      while (Date.now() < fin) {
        await dormir(1500);
        const o = await leerOrden(orderId);
        if (o.status === 'Filled') return { lleno: true, precio: precioLleno(o, rec) ?? precios[i], orderId };
        if (['Rejected', 'Cancelled', 'Expired'].includes(o.status)) {
          return { lleno: false, orderId, motivo: `orden ${o.status}${o['reject-reason'] ? ': ' + o['reject-reason'] : ''}` };
        }
      }
    }
    try { await tt._req(`/accounts/${cuenta()}/orders/${orderId}`, { method: 'DELETE' }); } catch (e) { /* ya se lleno o murio */ }
    await dormir(1500);
    const o = await leerOrden(orderId);                 // pudo llenarse justo al cancelar
    if (o.status === 'Filled') return { lleno: true, precio: precioLleno(o, rec) ?? precios[precios.length - 1], orderId };
    return { lleno: false, orderId, motivo: 'no se lleno persiguiendo hasta el natural; cancelada' };
  }

  function pnlHoy() {
    const hoy = fechaET();
    // solo los del modo vigente: las pruebas en dry-run no cuentan para el freno del dinero real
    return cargar().filter((x) => x.fecha === hoy && x.pnlUsd != null && x.modo === modo()).reduce((a, x) => a + x.pnlUsd, 0);
  }

  async function preview(direccion) {
    if (modo() === 'apagado') return { ok: false, error: 'clic real apagado (CLIC_REAL_MODO)' };
    if (!isMarketHours()) return { ok: false, error: 'mercado cerrado' };
    const m = horaETmin();
    if (m < 9 * 60 + 31 || m > 15 * 60 + 15) return { ok: false, error: 'fuera de la ventana de clics (9:31-15:15 ET)' };
    if (abierta()) return { ok: false, error: 'ya hay un clic real abierto: hay que cerrarlo primero' };
    if (pnlHoy() <= -frenoUsd()) return { ok: false, error: `freno diario: P&L de hoy ${pnlHoy().toFixed(0)} <= -${frenoUsd()}` };
    const out = await obtenerSenal(direccion);
    const sig = out.signal;
    if (!sig?.strikes) return { ok: false, error: out.reason || 'no se pudo armar el vertical' };
    const a = ACCION[sig.strategy];
    if (!a) return { ok: false, error: `estructura no soportada: ${sig.strategy}` };
    const k = sig.strikes;
    const exp = k.expiry.replace(/-/g, '').slice(2);
    const occ = (strike) => `SPXW  ${exp}${a.tipo}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
    // longStrike = la pata comprada, shortStrike = la vendida (misma convencion que findStrikesByDelta)
    const rec = { credito: a.credito, contratos: 1, legs: { comprada: occ(k.longStrike), vendida: occ(k.shortStrike) } };
    const q = await cotizar(rec.legs);
    // abrir: debito se paga (sube hacia compraNat); credito se cobra (valor negativo; baja hacia ventaNat)
    const precioMedio = a.credito ? r05(-q.medio, false) : r05(q.medio, true);
    const dr = await dryRun(cuerpoOrden(rec, precioMedio, true));
    const id = 'pv-' + Date.now();
    const p = {
      id, creado: Date.now(), direccion, estrategia: sig.strategy, nombre: a.nombre, credito: a.credito, legs: rec.legs,
      contratos: 1, vence: k.expiry, corto: k.shortStrike, largo: k.longStrike, ancho: Math.abs(k.shortStrike - k.longStrike),
      precioMedio, natural: a.credito ? r05(-q.compraNat, false) : r05(q.compraNat, true), deltaNeto: q.deltaNeto,
      spx: out.ctx?.spxPrice ?? null, bp: dr?.data?.['buying-power-effect']?.['change-in-buying-power'] ?? null,
      fees: dr?.data?.['fee-calculation']?.['total-fees'] ?? null, avisosDryRun: dr?.data?.warnings || [],
    };
    p.riesgoMaxUsd = Math.round((p.credito ? p.ancho - p.precioMedio : p.precioMedio) * 100);
    p.gananciaMaxUsd = Math.round((p.credito ? p.precioMedio : p.ancho - p.precioMedio) * 100);
    previews.set(id, p);
    for (const [kk, v] of previews) if (Date.now() - v.creado > 10 * 60 * 1000) previews.delete(kk);
    return { ok: true, modo: modo(), cuenta: cuenta(), preview: p, venceEnSeg: 90 };
  }

  async function ejecutar(previewId) {
    if (modo() === 'apagado') return { ok: false, error: 'clic real apagado' };
    const p = previews.get(previewId);
    if (!p) return { ok: false, error: 'preview inexistente o vencido: hay que volver a pedirlo' };
    if (Date.now() - p.creado > 90 * 1000) return { ok: false, error: 'preview vencido (90 s): hay que volver a pedirlo' };
    if (ocupado) return { ok: false, error: 'ya hay una orden en curso' };
    if (abierta()) return { ok: false, error: 'ya hay un clic real abierto' };
    if (pnlHoy() <= -frenoUsd()) return { ok: false, error: 'freno diario alcanzado' };
    ocupado = true;
    previews.delete(previewId);
    try {
      const q = await cotizar(p.legs);
      const medio = p.credito ? r05(-q.medio, false) : r05(q.medio, true);
      const nat = p.credito ? r05(-q.compraNat, false) : r05(q.compraNat, true);
      const peor = p.credito ? p.precioMedio - medio : medio - p.precioMedio;
      if (peor > tolPts() + 1e-9) {
        return { ok: false, error: `el precio se movio ${peor.toFixed(2)} pts en contra desde el preview (${p.precioMedio} -> ${medio}): pide uno nuevo` };
      }
      // escalera: medio, medio+0.05, ... hasta el natural, sin pasar de los limites del clic
      const tope = p.credito ? 1.20 : 3.80;
      const precios = [];
      for (let x = medio; p.credito ? x >= nat - 1e-9 : x <= nat + 1e-9; x = +(x + (p.credito ? -TICK : TICK)).toFixed(2)) {
        if (p.credito ? x < tope - 1e-9 : x > tope + 1e-9) break;
        precios.push(x);
        if (precios.length >= 4) break;
      }
      if (!precios.length) return { ok: false, error: `fuera de los limites del clic (${p.credito ? 'credito < 1.20' : 'debito > 3.80'})` };
      const r = await mandarYPerseguir({ ...p }, precios, true);
      const lista = cargar();
      const rec = {
        id: 'cr-' + Date.now(), modo: modo(), cuenta: cuenta(), fecha: fechaET(), direccion: p.direccion, estrategia: p.estrategia,
        nombre: p.nombre, credito: p.credito, legs: p.legs, contratos: 1, vence: p.vence, corto: p.corto, largo: p.largo,
        ancho: p.ancho, spxEntrada: p.spx, deltaEntrada: q.deltaNeto, ordenApertura: r.orderId, abiertaEn: new Date().toISOString(),
      };
      if (!r.lleno) {
        lista.unshift({ ...rec, estado: 'no_llenada', motivo: r.motivo, precios });
        guardar(lista);
        return { ok: false, error: r.motivo, orderId: r.orderId };
      }
      Object.assign(rec, { estado: 'abierta', precioEntrada: r.precio, simulado: !!r.simulado });
      rec.riesgoMaxUsd = Math.round((p.credito ? p.ancho - r.precio : r.precio) * 100);
      rec.gananciaMaxUsd = Math.round((p.credito ? r.precio : p.ancho - r.precio) * 100);
      lista.unshift(rec);
      guardar(lista);
      avisar(`${r.simulado ? '[DRY-RUN] ' : ''}Clic REAL abierto: ${p.nombre} ${p.largo}/${p.corto} a ${r.precio} (${p.credito ? 'credito' : 'debito'})`);
      return { ok: true, registro: rec };
    } finally {
      ocupado = false;
    }
  }

  async function cerrar(motivo = 'CIERRE_CLIC') {
    const rec0 = abierta();
    if (!rec0) return { ok: true, nada: true };
    if (ocupado) return { ok: false, error: 'ya hay una orden en curso' };
    ocupado = true;
    try {
      let lista = cargar();
      let rec = lista.find((x) => x.id === rec0.id);
      rec.estado = 'cerrando'; rec.cierrePedido = new Date().toISOString(); rec.motivoCierre = motivo;
      guardar(lista);
      const q = await cotizar(rec.legs);
      // cerrar: un debito se VENDE (recibo, baja hacia ventaNat); un credito se RECOMPRA (pago, sube hacia compraNat)
      const medio = rec.credito ? r05(-q.medio, true) : r05(q.medio, false);
      const nat = rec.credito ? r05(-q.ventaNat, true) : r05(Math.max(0, q.ventaNat), false);
      const precios = [];
      for (let x = medio; rec.credito ? x <= nat + 1e-9 : x >= nat - 1e-9; x = +(x + (rec.credito ? TICK : -TICK)).toFixed(2)) {
        precios.push(Math.max(0.05, x));
        if (precios.length >= 6) break;
      }
      if (!precios.length) precios.push(Math.max(0.05, nat));
      const r = await mandarYPerseguir({ ...rec }, precios, false, 7000);
      lista = cargar();
      rec = lista.find((x) => x.id === rec0.id);
      if (!r.lleno) {
        rec.estado = 'abierta';
        rec.ultimoIntentoCierre = { en: new Date().toISOString(), motivo: r.motivo };
        guardar(lista);
        avisar(`⚠️ Clic REAL: NO se pudo cerrar (${r.motivo}). Revisar en TastyTrade.`);
        return { ok: false, error: r.motivo };
      }
      rec.estado = 'cerrada'; rec.cerradaEn = new Date().toISOString(); rec.precioSalida = r.precio; rec.ordenCierre = r.orderId;
      rec.pnlUsd = Math.round((rec.credito ? rec.precioEntrada - r.precio : r.precio - rec.precioEntrada) * 100 * rec.contratos);
      rec.dayTrade = rec.fecha === fechaET();
      guardar(lista);
      avisar(`${rec.simulado ? '[DRY-RUN] ' : ''}Clic REAL cerrado (${motivo}): ${rec.nombre} ${rec.largo}/${rec.corto} ${rec.precioEntrada} -> ${r.precio} = ${rec.pnlUsd >= 0 ? '+' : ''}$${rec.pnlUsd}`);
      return { ok: true, registro: rec };
    } finally {
      ocupado = false;
    }
  }

  let cacheEstado = { ts: 0, data: null };
  async function estado() {
    if (Date.now() - cacheEstado.ts < 4000 && cacheEstado.data) return cacheEstado.data;
    const hoy = fechaET();
    const l = cargar();
    const rec = abierta() || l.find((x) => x.fecha === hoy && x.estado === 'cerrada' && x.modo === modo());
    let trade = null;
    if (rec) {
      let pnl = rec.pnlUsd ?? null, delta = rec.deltaEntrada;
      if (rec.estado !== 'cerrada') {
        try {
          const q = await cotizar(rec.legs);
          const salida = rec.credito ? -q.ventaNat : q.ventaNat;   // lo que cuesta/da cerrar ya, al natural
          pnl = Math.round((rec.credito ? rec.precioEntrada - salida : salida - rec.precioEntrada) * 100 * rec.contratos);
          delta = q.deltaNeto;
        } catch (e) { /* sin cotizacion: se muestra sin P&L */ }
      }
      trade = {
        id: rec.id, origen: 'CLIC_REAL', modo: rec.modo, estado: rec.estado === 'cerrada' ? 'closed' : 'filled',
        estructura: rec.nombre, direccion: rec.direccion, credito: rec.credito, contratos: rec.contratos, vence: rec.vence,
        strikes: `${rec.corto}/${rec.largo}`, primaPts: rec.precioEntrada, primaUsd: Math.round(rec.precioEntrada * 100 * rec.contratos),
        riesgoMaxUsd: rec.riesgoMaxUsd, gananciaMaxUsd: rec.gananciaMaxUsd, deltaEntrada: rec.deltaEntrada, deltaAhora: delta,
        spxEntrada: rec.spxEntrada, abiertaEn: rec.abiertaEn, cerradaEn: rec.cerradaEn || null, motivoCierre: rec.motivoCierre || null,
        cierrePedido: rec.estado === 'cerrando', pnl, simulado: !!rec.simulado,
      };
    }
    cacheEstado = { ts: Date.now(), data: { ok: true, modo: modo(), pnlHoy: pnlHoy(), freno: frenoUsd(), trade } };
    return cacheEstado.data;
  }

  // seguro: a las 15:30 ET se cierra lo que quede abierto
  function vigilar() {
    setInterval(async () => {
      try {
        if (!abierta() || ocupado) return;
        if (horaETmin() >= 15 * 60 + 30) await cerrar('CIERRE_PRE_CLOSE_1530');
      } catch (e) { console.error('[CLIC_REAL] vigilancia:', e.message); }
    }, 20000);
  }

  return { preview, ejecutar, cerrar, estado, vigilar, modo, _cuerpoOrden: cuerpoOrden, _r05: r05 };
}

module.exports = { crearClicReal, ACCION };
