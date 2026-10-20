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
  // Cuenta demo (Guillermo 2026-10-19: "abramos una cuenta demo en tastytrade de 2000 dolares y la monitoreamos en la
  // bitacora"): en modo dryrun los trades se llevan contra un capital ficticio que arranca en CLIC_DEMO_DESDE.
  const demoCapital = () => Number(process.env.CLIC_DEMO_CAPITAL || 2000);
  const demoDesde = () => process.env.CLIC_DEMO_DESDE || '2026-10-19T17:45:00Z';
  const previews = new Map();
  let ocupado = false;

  // ── Sesión nocturna de práctica (Guillermo 2026-10-19: "solo para un tema didáctico, pongamos en demo después de las
  // 5 pm hora NY para que podamos hacer ejercicios"). Las opciones del SPX vuelven a cotizar en la sesión global de Cboe
  // (GTH, desde las 20:15 ET, con vencimiento del día hábil siguiente); entre 16:15 y 20:15 no hay precios. Solo en
  // modo dryrun: nunca sale una orden real de noche. El SPX contado no se mueve fuera de horario, así que el precio del
  // subyacente se saca de las opciones (paridad put-call en el strike ATM: S = K + C - P).
  const NOCHE_DESDE = 20 * 60 + 15, NOCHE_HASTA = 23 * 60 + 30;
  const diaSemET = () => new Date(fechaET() + 'T12:00:00Z').getUTCDay();          // 0 = domingo
  const nocturna = () => modo() === 'dryrun' && String(process.env.CLIC_NOCHE || 'on').toLowerCase() !== 'off'
    && diaSemET() <= 4 && horaETmin() >= NOCHE_DESDE && horaETmin() <= NOCHE_HASTA;  // domingo a jueves en la noche
  const proximoHabil = () => {
    for (let i = 1; i <= 5; i++) {
      const f = fechaET(new Date(Date.now() + i * 86400000));
      const w = new Date(f + 'T12:00:00Z').getUTCDay();
      if (w >= 1 && w <= 5) return f;
    }
    return null;
  };
  let cacheSint = { ts: 0, v: null };
  async function spxSintetico(vence) {
    if (Date.now() - cacheSint.ts < 15000 && cacheSint.v) return cacheSint.v;
    const exp = vence.replace(/-/g, '').slice(2);
    const occ = (t, k) => `SPXW  ${exp}${t}${String(Math.round(k * 1000)).padStart(8, '0')}`;
    let s = Number((await tt._req('/market-data?symbols[]=SPX'))?.data?.items?.[0]?.last) || null;
    if (!s) throw new Error('sin precio de referencia del SPX');
    for (let i = 0; i < 3; i++) {
      const k = Math.round(s / 5) * 5;
      const d = await tt._req(`/market-data?symbols[]=${encodeURIComponent(occ('C', k))}&symbols[]=${encodeURIComponent(occ('P', k))}`);
      const q = {};
      for (const it of d?.data?.items || []) q[it.symbol] = (Number(it.bid) + Number(it.ask)) / 2;
      const c = q[occ('C', k)], p = q[occ('P', k)];
      if (!Number.isFinite(c) || !Number.isFinite(p)) throw new Error('las opciones del SPX no cotizan ahora');
      s = +(k + c - p).toFixed(2);
      if (Math.abs(s - k) <= 2.5) break;
    }
    cacheSint = { ts: Date.now(), v: s };
    return s;
  }               // una orden a la vez: un segundo pedido mientras otro corre se rechaza

  const cargar = () => { try { return JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')); } catch (e) { return []; } };
  const guardar = (l) => fs.writeFileSync(ARCHIVO, JSON.stringify(l, null, 2), 'utf8');
  // Ranuras (Guillermo 2026-10-20: "ajusta para que me permita abrir el IB adicional a la posición que tengo"):
  // 'principal' = la del clic de TradingView (vertical, o IB con BUY de 2 desde plano) y 'adicional' = el Iron Butterfly
  // que se abre con el botón IB del gráfico, sin tocar la posición de Paper Trading. Una posición por ranura.
  const enCurso = (x) => (x.estado === 'abierta' || x.estado === 'cerrando') && x.modo === modo();
  const abierta = (ranura = 'principal') => cargar().find((x) => enCurso(x) && (x.ranura || 'principal') === ranura);
  const abiertas = () => cargar().filter(enCurso);

  // patas: [{ sym, lado }] con lado +1 = comprada, -1 = vendida (vertical: 2 patas; Iron Butterfly: 4). Los registros
  // de antes del 2026-10-19 traen { comprada, vendida } y se convierten aca.
  const patas = (legs) => Array.isArray(legs) ? legs : [{ sym: legs.comprada, lado: 1 }, { sym: legs.vendida, lado: -1 }];

  // cotizacion de la estructura: solo sus patas, directo de TastyTrade /market-data (< 1 s; la cadena entera ~35 s).
  // Todo en "valor de comprar la estructura": positivo = debito, negativo = credito.
  async function cotizar(legs) {
    const L = patas(legs);
    const d = await tt._req(`/market-data?${L.map((x) => `symbols[]=${encodeURIComponent(x.sym)}`).join('&')}`);
    const q = {};
    for (const it of d?.data?.items || []) q[it.symbol] = { bid: Number(it.bid), ask: Number(it.ask), delta: Number(it.delta || 0) };
    let medio = 0, compraNat = 0, ventaNat = 0, deltaNeto = 0;
    const vendidas = [];   // Guillermo 2026-10-20: "solo el delta de la put o call vendida" (el IB trae dos)
    for (const x of L) {
      const c = q[x.sym];
      if (!c || !Number.isFinite(c.bid) || !Number.isFinite(c.ask)) throw new Error(`sin cotizacion de ${x.sym}`);
      if (x.lado < 0) {
        const m = /([CP])(\d{8})$/.exec(String(x.sym).trim());
        vendidas.push({ tipo: m ? (m[1] === 'C' ? 'call' : 'put') : null, strike: m ? Number(m[2]) / 1000 : null, delta: +c.delta.toFixed(3) });
      }
      medio += x.lado * (c.bid + c.ask) / 2;
      // compraNat: abrir ya (lo comprado al ask, lo vendido al bid); en un credito, -compraNat es lo que se cobra al
      // abrir ya. ventaNat: deshacer ya (lo comprado al bid, lo vendido al ask); en un credito, -ventaNat es lo que
      // cuesta recomprarlo ya.
      compraNat += x.lado > 0 ? c.ask : -c.bid;
      ventaNat += x.lado > 0 ? c.bid : -c.ask;
      deltaNeto += x.lado * c.delta;
    }
    return { medio: +medio.toFixed(2), compraNat: +compraNat.toFixed(2), ventaNat: +ventaNat.toFixed(2), deltaNeto: +deltaNeto.toFixed(3), vendidas };
  }

  function cuerpoOrden(rec, precio, abrir) {
    const credito = rec.credito;
    // abrir debito = Debit; abrir credito = Credit; cerrar al reves
    const efecto = (abrir ? !credito : credito) ? 'Debit' : 'Credit';
    return {
      'time-in-force': 'Day', 'order-type': 'Limit', price: Math.abs(precio).toFixed(2), 'price-effect': efecto,
      legs: patas(rec.legs).map((x) => ({
        'instrument-type': 'Equity Option', symbol: x.sym, quantity: rec.contratos,
        action: x.lado > 0 ? (abrir ? 'Buy to Open' : 'Sell to Close') : (abrir ? 'Sell to Open' : 'Buy to Close'),
      })),
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
    // comisiones que TastyTrade calcula para esta orden (dry-run); se descuentan del P&L (2026-10-19). En la apertura
    // ya vienen del dry-run del preview (rec.feesConocidas): no se repite esa llamada (2026-10-20, meta de 5 s)
    const fees = rec.feesConocidas != null ? Number(rec.feesConocidas)
      : Number((await dryRun(cuerpoOrden(rec, precios[0], abrir)))?.data?.['fee-calculation']?.['total-fees'] || 0);
    if (modo() === 'dryrun') {
      // demo (Guillermo 2026-10-19): llena al medio + 0.05 en contra (el segundo escalon), un deslizamiento tipico
      // de los spreads 0DTE del SPX; si el natural esta al medio, al natural.
      const precio = precios[Math.min(1, precios.length - 1)];
      return { lleno: true, precio, orderId: 'DRYRUN', simulado: true, fees };
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
          if (o.status === 'Filled') return { lleno: true, precio: precioLleno(o, rec) ?? precios[i - 1], orderId, fees };
          throw e;
        }
      }
      const fin = Date.now() + esperaMs;
      while (Date.now() < fin) {
        await dormir(1500);
        const o = await leerOrden(orderId);
        if (o.status === 'Filled') return { lleno: true, precio: precioLleno(o, rec) ?? precios[i], orderId, fees };
        if (['Rejected', 'Cancelled', 'Expired'].includes(o.status)) {
          return { lleno: false, orderId, motivo: `orden ${o.status}${o['reject-reason'] ? ': ' + o['reject-reason'] : ''}` };
        }
      }
    }
    try { await tt._req(`/accounts/${cuenta()}/orders/${orderId}`, { method: 'DELETE' }); } catch (e) { /* ya se lleno o murio */ }
    await dormir(1500);
    const o = await leerOrden(orderId);                 // pudo llenarse justo al cancelar
    if (o.status === 'Filled') return { lleno: true, precio: precioLleno(o, rec) ?? precios[precios.length - 1], orderId, fees };
    return { lleno: false, orderId, motivo: 'no se lleno persiguiendo hasta el natural; cancelada' };
  }

  function cuentaDemo() {
    const desde = demoDesde();
    const l = cargar().filter((x) => x.modo === 'dryrun' && x.abiertaEn >= desde && x.estado !== 'no_llenada').reverse();
    const cerr = l.filter((x) => x.estado === 'cerrada' && x.pnlUsd != null);
    const realizado = cerr.reduce((a, x) => a + x.pnlUsd, 0);
    const abiertos = l.filter((x) => x.estado === 'abierta' || x.estado === 'cerrando');
    const reservado = abiertos.reduce((a, x) => a + (x.riesgoMaxUsd || 0) + 2 * (x.feesApertura || 0), 0);
    let eq = demoCapital(), pico = eq, dd = 0;
    const curva = [{ t: desde, saldo: eq }];
    for (const x of cerr) { eq += x.pnlUsd; pico = Math.max(pico, eq); dd = Math.max(dd, pico - eq); curva.push({ t: x.cerradaEn, saldo: +eq.toFixed(2) }); }
    const saldo = +(demoCapital() + realizado).toFixed(2);
    return { capital: demoCapital(), desde, saldo, disponible: +(saldo - reservado).toFixed(2), reservado: +reservado.toFixed(2),
             realizado: +realizado.toFixed(2), maxDrawdown: +dd.toFixed(2), curva, trades: l, abiertos };
  }

  function pnlHoy() {
    const hoy = fechaET();
    // solo los del modo vigente: las pruebas en dry-run no cuentan para el freno del dinero real
    return cargar().filter((x) => x.fecha === hoy && x.pnlUsd != null && x.modo === modo()).reduce((a, x) => a + x.pnlUsd, 0);
  }

  // ventana de clics: la regular (9:31-15:15 ET) o, en demo, la nocturna de práctica (20:15-23:30 ET)
  function fueraDeVentana() {
    if (nocturna()) return null;
    if (!isMarketHours()) return 'mercado cerrado (práctica nocturna en demo: 20:15-23:30 ET, domingo a jueves)';
    const m = horaETmin();
    if (m < 9 * 60 + 31 || m > 15 * 60 + 15) return 'fuera de la ventana de clics (9:31-15:15 ET; práctica nocturna en demo: 20:15-23:30 ET)';
    return null;
  }

  async function preview(direccion) {
    if (modo() === 'apagado') return { ok: false, error: 'clic real apagado (CLIC_REAL_MODO)' };
    const fuera = fueraDeVentana();
    if (fuera) return { ok: false, error: fuera };
    const noche = nocturna();
    if (abierta()) return { ok: false, error: 'ya hay un clic real abierto: hay que cerrarlo primero' };
    if (pnlHoy() <= -frenoUsd()) return { ok: false, error: `freno diario: P&L de hoy ${pnlHoy().toFixed(0)} <= -${frenoUsd()}` };
    if (modo() === 'dryrun' && cuentaDemo().disponible < 100) return { ok: false, error: `cuenta demo sin saldo disponible ($${cuentaDemo().disponible})` };
    let out;
    if (noche) {
      // de noche no corre el motor de la Bitácora (sin contexto del SPX contado): débito ATM, como el clic de día en
      // tendencia (Bull Call / Bear Put), vencimiento del día hábil siguiente
      const vence = proximoHabil();
      const spxN = await spxSintetico(vence);
      const atmN = Math.round(spxN / 5) * 5;
      const alc = direccion === 'BULLISH';
      out = { signal: { strategy: alc ? 'BULL_CALL_SPREAD' : 'BEAR_PUT_SPREAD',
                        strikes: { expiry: vence, shortStrike: atmN, longStrike: alc ? atmN - 5 : atmN + 5 } },
              ctx: { spxPrice: spxN } };
    } else {
      out = await obtenerSenal(direccion);
    }
    const sig = out.signal;
    if (!sig?.strikes) return { ok: false, error: out.reason || 'no se pudo armar el vertical' };
    const a = ACCION[sig.strategy];
    if (!a) return { ok: false, error: `estructura no soportada: ${sig.strategy}` };
    const k = sig.strikes;
    const exp = k.expiry.replace(/-/g, '').slice(2);
    const occ = (strike) => `SPXW  ${exp}${a.tipo}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
    const ancho = Math.abs(k.shortStrike - k.longStrike) || 5;
    // Dos opciones para la pata VENDIDA (Guillermo 2026-10-19): "at the money" (el strike mas cercano al precio) o
    // "a 5 puntos del precio" del lado fuera del dinero (calls arriba, puts abajo): mas protegido, menos credito /
    // debito mas barato. La estructura (credito o debito) la sigue eligiendo la Bitacora; la comprada va a +-ancho.
    const spx = out.ctx?.spxPrice ?? null;
    const atm = Math.round((spx || (k.shortStrike + k.longStrike) / 2) / 5) * 5;
    const otm = a.tipo === 'C' ? 5 : -5;
    const lejos = (corto) => (a.tipo === 'C') === a.credito ? corto + ancho : corto - ancho;   // la comprada
    const armar = async (clave, etiqueta, corto) => {
      const largo = lejos(corto);
      const rec = { credito: a.credito, contratos: 1, legs: { comprada: occ(largo), vendida: occ(corto) } };
      const q = await cotizar(rec.legs);
      const precioMedio = a.credito ? r05(-q.medio, false) : r05(q.medio, true);
      const dr = await dryRun(cuerpoOrden(rec, precioMedio, true));
      const v = {
        id: 'pv-' + Date.now() + '-' + clave, creado: Date.now(), direccion, estrategia: sig.strategy, nombre: a.nombre,
        credito: a.credito, legs: rec.legs, contratos: 1, vence: k.expiry, corto, largo, ancho, ubicacion: clave, etiqueta,
        precioMedio, natural: a.credito ? r05(-q.compraNat, false) : r05(q.compraNat, true), deltaNeto: q.deltaNeto,
        spx, sesion: noche ? 'nocturna' : 'regular', bp: dr?.data?.['buying-power-effect']?.['change-in-buying-power'] ?? null,
        fees: dr?.data?.['fee-calculation']?.['total-fees'] ?? null, avisosDryRun: dr?.data?.warnings || [],
      };
      v.riesgoMaxUsd = Math.round((v.credito ? ancho - precioMedio : precioMedio) * 100);
      v.gananciaMaxUsd = Math.round((v.credito ? precioMedio : ancho - precioMedio) * 100);
      // mismas reglas del clic: credito >= 1.20 / debito <= 3.80; si no cumple, la opcion no se ofrece
      if (v.credito ? precioMedio < 1.20 - 1e-9 : precioMedio > 3.80 + 1e-9) {
        v.noCumple = v.credito ? `crédito $${precioMedio.toFixed(2)} < $1.20` : `débito $${precioMedio.toFixed(2)} > $3.80`;
      }
      if (modo() === 'dryrun' && !v.noCumple && v.riesgoMaxUsd > cuentaDemo().disponible) v.noCumple = 'no cabe en el saldo de la cuenta demo';
      previews.set(v.id, v);
      return v;
    };
    // las dos en paralelo (2026-10-20, meta de 5 s del clic a la orden): cada una cotiza y hace su dry-run
    const variantes = await Promise.all([armar('ATM', 'At the money', atm), armar('OTM5', 'A 5 puntos del precio', atm + otm)]);
    for (const [kk, v] of previews) if (Date.now() - v.creado > 6 * 3600 * 1000) previews.delete(kk);
    if (variantes.every((v) => v.noCumple)) {
      return { ok: false, error: `ninguna opcion cumple las reglas del clic (ATM: ${variantes[0].noCumple}; a 5 pts: ${variantes[1].noCumple})` };
    }
    const p = variantes.find((v) => !v.noCumple);
    return { ok: true, modo: modo(), cuenta: cuenta(), preview: p, variantes, venceEnSeg: null };
  }

  // Iron Butterfly (Guillermo 2026-10-19: "IB pero que yo decida el strike y las alas"): vende put y call en el centro y
  // compra las alas a +-alas, 0DTE, 1 contrato. Credito; riesgo maximo = alas - credito.
  async function previewIB(centro, alas, ranura = 'principal') {
    if (modo() === 'apagado') return { ok: false, error: 'clic real apagado (CLIC_REAL_MODO)' };
    const fuera = fueraDeVentana();
    if (fuera) return { ok: false, error: fuera };
    const noche = nocturna();
    centro = Math.round(Number(centro) / 5) * 5; alas = Math.round(Number(alas) / 5) * 5;
    if (!(centro > 1000) || !(alas >= 5 && alas <= 100)) return { ok: false, error: `centro ${centro} / alas ${alas} invalidos (alas de 5 a 100, multiplo de 5)` };
    if (abierta(ranura)) return { ok: false, error: ranura === 'adicional' ? 'ya hay un IB adicional abierto: hay que cerrarlo primero'
                                                                      : 'ya hay un clic real abierto: hay que cerrarlo primero' };
    if (pnlHoy() <= -frenoUsd()) return { ok: false, error: `freno diario: P&L de hoy ${pnlHoy().toFixed(0)} <= -${frenoUsd()}` };
    const vence = noche ? proximoHabil() : fechaET();
    const exp = vence.replace(/-/g, '').slice(2);
    const occ = (t, k) => `SPXW  ${exp}${t}${String(Math.round(k * 1000)).padStart(8, '0')}`;
    const legs = [{ sym: occ('P', centro), lado: -1 }, { sym: occ('C', centro), lado: -1 },
                  { sym: occ('P', centro - alas), lado: 1 }, { sym: occ('C', centro + alas), lado: 1 }];
    const rec = { credito: true, contratos: 1, legs };
    const q = await cotizar(legs);
    if (q.medio >= 0) return { ok: false, error: 'el Iron Butterfly no da credito con esos strikes' };
    const precioMedio = r05(-q.medio, false);
    const dr = await dryRun(cuerpoOrden(rec, precioMedio, true));
    let spx = null;
    try { spx = noche ? await spxSintetico(vence) : (await tt._req('/market-data?symbols[]=SPX'))?.data?.items?.[0]?.last ?? null; } catch (e) { /* informativo */ }
    const p = {
      id: 'pv-' + Date.now(), creado: Date.now(), direccion: 'NEUTRAL', estrategia: 'IRON_BUTTERFLY', estructura: 'IB',
      nombre: 'Iron Butterfly', credito: true, legs, contratos: 1, vence, sesion: noche ? 'nocturna' : 'regular', corto: centro, largo: alas, ancho: alas,
      strikesTxt: `${centro - alas}/${centro}/${centro + alas}`, precioMedio, natural: r05(-q.compraNat, false),
      deltaNeto: q.deltaNeto, spx: spx != null ? Number(spx) : null, ranura,
      bp: dr?.data?.['buying-power-effect']?.['change-in-buying-power'] ?? null,
      fees: dr?.data?.['fee-calculation']?.['total-fees'] ?? null, avisosDryRun: dr?.data?.warnings || [],
    };
    p.riesgoMaxUsd = Math.round((alas - precioMedio) * 100);
    p.gananciaMaxUsd = Math.round(precioMedio * 100);
    if (modo() === 'dryrun' && p.riesgoMaxUsd > cuentaDemo().disponible) {
      return { ok: false, error: `cuenta demo: el riesgo del IB ($${p.riesgoMaxUsd}) supera el saldo disponible ($${cuentaDemo().disponible})` };
    }
    previews.set(p.id, p);
    return { ok: true, modo: modo(), cuenta: cuenta(), preview: p, venceEnSeg: null };
  }

  async function ejecutar(previewId) {
    if (modo() === 'apagado') return { ok: false, error: 'clic real apagado' };
    const p = previews.get(previewId);
    if (!p) return { ok: false, error: 'preview inexistente o vencido: hay que volver a pedirlo' };
    // sin vencimiento (Guillermo 2026-10-19: "no le pongas límite de tiempo a la aprobación"): al ejecutar se recotiza y,
    // si el precio se movió más de la tolerancia, vuelve un precio nuevo para una segunda confirmación
    if (ocupado) return { ok: false, error: 'ya hay una orden en curso' };
    if (abierta(p.ranura || 'principal')) return { ok: false, error: 'ya hay un clic real abierto en esa ranura' };
    if (pnlHoy() <= -frenoUsd()) return { ok: false, error: 'freno diario alcanzado' };
    ocupado = true;
    previews.delete(previewId);
    try {
      const q = await cotizar(p.legs);
      const medio = p.credito ? r05(-q.medio, false) : r05(q.medio, true);
      const nat = p.credito ? r05(-q.compraNat, false) : r05(q.compraNat, true);
      const peor = p.credito ? p.precioMedio - medio : medio - p.precioMedio;
      if (peor > tolPts() + 1e-9) {
        // 2026-10-19: en un movimiento rapido el spread se encarecio 0.35 en 7 s y la entrada se perdio. En vez de
        // rechazar seco, se devuelve un preview nuevo con el precio de ahora para que Guillermo decida otra vez.
        const fuera = p.estructura === 'IB' ? false : p.credito ? medio < 1.20 - 1e-9 : medio > 3.80 + 1e-9;
        const msg = `el precio se movio ${peor.toFixed(2)} pts en contra desde el preview (${p.precioMedio} -> ${medio})`;
        if (fuera) return { ok: false, error: `${msg} y quedo fuera de los limites del clic (${p.credito ? 'credito < 1.20' : 'debito > 3.80'})` };
        const p2 = { ...p, id: 'pv-' + Date.now(), creado: Date.now(), precioAnterior: p.precioMedio, precioMedio: medio, natural: nat,
                     deltaNeto: q.deltaNeto };
        p2.riesgoMaxUsd = Math.round((p2.credito ? p2.ancho - medio : medio) * 100);
        p2.gananciaMaxUsd = Math.round((p2.credito ? medio : p2.ancho - medio) * 100);
        previews.set(p2.id, p2);
        return { ok: false, recotizado: true, error: msg, preview: p2, modo: modo(), cuenta: cuenta() };
      }
      // escalera: medio, medio+0.05, ... hasta el natural, sin pasar de los limites del clic
      const tope = p.estructura === 'IB' ? (p.credito ? 0.05 : 1e9) : p.credito ? 1.20 : 3.80;
      const precios = [];
      for (let x = medio; p.credito ? x >= nat - 1e-9 : x <= nat + 1e-9; x = +(x + (p.credito ? -TICK : TICK)).toFixed(2)) {
        if (p.credito ? x < tope - 1e-9 : x > tope + 1e-9) break;
        precios.push(x);
        if (precios.length >= 4) break;
      }
      if (!precios.length) return { ok: false, error: `fuera de los limites del clic (${p.credito ? 'credito < 1.20' : 'debito > 3.80'})` };
      if (modo() === 'dryrun') {
        const riesgo = Math.round((p.credito ? p.ancho - precios[0] : precios[0]) * 100);
        const disp = cuentaDemo().disponible;
        if (riesgo > disp) return { ok: false, error: `cuenta demo: el riesgo del vertical ($${riesgo}) supera el saldo disponible ($${disp})` };
      }
      const t0 = Date.now();
      const r = await mandarYPerseguir({ ...p, feesConocidas: p.fees ?? null }, precios, true);
      const segEjec = +((Date.now() - t0) / 1000).toFixed(1);
      const lista = cargar();
      const rec = {
        id: 'cr-' + Date.now(), modo: modo(), cuenta: cuenta(), fecha: fechaET(), direccion: p.direccion, estrategia: p.estrategia,
        nombre: p.nombre, credito: p.credito, legs: p.legs, contratos: 1, vence: p.vence, corto: p.corto, largo: p.largo,
        ancho: p.ancho, spxEntrada: p.spx, deltaEntrada: q.deltaNeto, vendidasEntrada: q.vendidas || null, ordenApertura: r.orderId, abiertaEn: new Date().toISOString(),
        estructura: p.estructura || 'VERTICAL', strikesTxt: p.strikesTxt || null, sesion: p.sesion || 'regular',
        ranura: p.ranura || 'principal',
      };
      if (!r.lleno) {
        lista.unshift({ ...rec, estado: 'no_llenada', motivo: r.motivo, precios });
        guardar(lista);
        return { ok: false, error: r.motivo, orderId: r.orderId };
      }
      Object.assign(rec, { estado: 'abierta', precioEntrada: r.precio, simulado: !!r.simulado, feesApertura: r.fees || 0, segEjecApertura: segEjec });
      rec.riesgoMaxUsd = Math.round((p.credito ? p.ancho - r.precio : r.precio) * 100);
      rec.gananciaMaxUsd = Math.round((p.credito ? r.precio : p.ancho - r.precio) * 100);
      lista.unshift(rec);
      guardar(lista);
      avisar(`${p.nombre} ${p.strikesTxt || `${p.largo}/${p.corto}`} · ${p.credito ? 'crédito' : 'débito'} $${r.precio.toFixed(2)} · `
             + `riesgo máx $${rec.riesgoMaxUsd} · ganancia máx $${rec.gananciaMaxUsd}${r.simulado ? ' · DEMO (dry-run)' : ''}`,
             `Clic SPX abierto: ${p.nombre}${r.simulado ? ' (demo)' : ''}`, 'chart_with_upwards_trend');
      return { ok: true, registro: rec };
    } finally {
      ocupado = false;
    }
  }

  async function cerrar(motivo = 'CIERRE_CLIC', ranura = 'principal') {
    const rec0 = abierta(ranura);
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
      const t0 = Date.now();
      // el SPX de salida (para el informe) se pide a la vez que se manda la orden, no después (2026-10-20)
      const spxSal = (rec.sesion === 'nocturna' ? spxSintetico(rec.vence)
        : tt._req('/market-data?symbols[]=SPX').then((d) => Number(d?.data?.items?.[0]?.last) || null)).catch(() => null);
      const r = await mandarYPerseguir({ ...rec }, precios, false, 7000);
      const segEjecCierre = +((Date.now() - t0) / 1000).toFixed(1);
      lista = cargar();
      rec = lista.find((x) => x.id === rec0.id);
      if (!r.lleno) {
        rec.estado = 'abierta';
        rec.ultimoIntentoCierre = { en: new Date().toISOString(), motivo: r.motivo };
        guardar(lista);
        avisar(`${r.motivo}. Revisar en TastyTrade.`, '⚠️ Clic SPX: NO se pudo cerrar', 'warning');
        return { ok: false, error: r.motivo };
      }
      rec.estado = 'cerrada'; rec.cerradaEn = new Date().toISOString(); rec.precioSalida = r.precio; rec.ordenCierre = r.orderId;
      rec.feesCierre = r.fees || 0;
      rec.segEjecCierre = segEjecCierre;
      rec.pnlBrutoUsd = Math.round((rec.credito ? rec.precioEntrada - r.precio : r.precio - rec.precioEntrada) * 100 * rec.contratos);
      rec.pnlUsd = +(rec.pnlBrutoUsd - (rec.feesApertura || 0) - rec.feesCierre).toFixed(2);   // neto de comisiones
      rec.dayTrade = rec.fecha === fechaET();
      rec.spxSalida = await spxSal;          // SPX al cerrar, para el informe del trade (informativo)
      guardar(lista);
      // Guillermo 2026-10-19: el resultado en dolares tiene que verse en la notificacion -> va en el titulo
      const usd = (v) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
      // y cuanto duro el trade y cuanto se le pago a TastyTrade (Guillermo 2026-10-19)
      const seg = Math.round((new Date(rec.cerradaEn) - new Date(rec.abiertaEn)) / 1000);
      const dur = seg >= 3600 ? `${Math.floor(seg / 3600)} h ${Math.floor(seg % 3600 / 60)} min` : `${Math.floor(seg / 60)} min ${seg % 60} s`;
      const pago = (rec.feesApertura || 0) + rec.feesCierre;
      avisar(`${rec.nombre} ${rec.strikesTxt || `${rec.largo}/${rec.corto}`}: ${rec.precioEntrada.toFixed(2)} → ${r.precio.toFixed(2)}
`
             + `Resultado bruto: ${usd(rec.pnlBrutoUsd)}
`
             + `Pago a TastyTrade: -$${pago.toFixed(2)} (apertura $${(rec.feesApertura || 0).toFixed(2)} + cierre $${rec.feesCierre.toFixed(2)})
`
             + `Resultado NETO: ${usd(rec.pnlUsd)}
`
             + `Tiempo en el trade: ${dur}
`
             + `Ejecución de las órdenes: apertura ${rec.segEjecApertura ?? '?'} s · cierre ${segEjecCierre} s
`
             + `Motivo: ${motivo}${rec.simulado ? ' · DEMO (dry-run)' : ''}`,
             `${rec.pnlUsd >= 0 ? '✅ GANÓ' : '🔻 PERDIÓ'} ${usd(rec.pnlUsd)} neto en ${dur} · Clic SPX${rec.simulado ? ' (demo)' : ''}`,
             rec.pnlUsd >= 0 ? 'white_check_mark' : 'small_red_triangle_down');
      return { ok: true, registro: rec };
    } finally {
      ocupado = false;
    }
  }

  let cacheEstado = { ts: 0, data: null };
  async function estado() {
    // 1,5 s (era 4): la tabla de TV pide cada 2 s y el P&L no debe tener más de ~3,5 s (Guillermo 2026-10-20)
    if (Date.now() - cacheEstado.ts < 1500 && cacheEstado.data) return cacheEstado.data;
    const hoy = fechaET();
    const l = cargar();
    const rec = abierta() || l.find((x) => x.fecha === hoy && x.estado === 'cerrada' && x.modo === modo()
                                         && (x.ranura || 'principal') === 'principal');
    const vista = async (rec) => {
      let pnl = rec.pnlUsd ?? null, delta = rec.deltaEntrada, vendidas = rec.vendidasEntrada || null, spxAhora = null;
      if (rec.estado !== 'cerrada') {
        try {
          const q = await cotizar(rec.legs);
          const salida = rec.credito ? -q.ventaNat : q.ventaNat;   // lo que cuesta/da cerrar ya, al natural
          // neto estimado: cierre al natural y comisiones de ida + otras tantas de vuelta
          pnl = +(Math.round((rec.credito ? rec.precioEntrada - salida : salida - rec.precioEntrada) * 100 * rec.contratos)
                  - 2 * (rec.feesApertura || 0)).toFixed(2);
          delta = q.deltaNeto;
          vendidas = q.vendidas;
        } catch (e) { /* sin cotizacion: se muestra sin P&L */ }
        // SPX ahora: el bot lo usa para traducir el TP/SL que Guillermo pone en TradingView a P&L de las opciones
        try {
          spxAhora = rec.sesion === 'nocturna' ? await spxSintetico(rec.vence)
            : Number((await tt._req('/market-data?symbols[]=SPX'))?.data?.items?.[0]?.last) || null;
        } catch (e) { /* informativo */ }
      }
      return {
        id: rec.id, origen: 'CLIC_REAL', modo: rec.modo, estado: rec.estado === 'cerrada' ? 'closed' : 'filled',
        estructura: rec.nombre, direccion: rec.direccion, credito: rec.credito, contratos: rec.contratos, vence: rec.vence,
        strikes: rec.strikesTxt || `${rec.corto}/${rec.largo}`, primaPts: rec.precioEntrada, primaUsd: Math.round(rec.precioEntrada * 100 * rec.contratos),
        riesgoMaxUsd: rec.riesgoMaxUsd, gananciaMaxUsd: rec.gananciaMaxUsd, deltaEntrada: rec.deltaEntrada, deltaAhora: delta,
        vendidas, spxEntrada: rec.spxEntrada, abiertaEn: rec.abiertaEn, cerradaEn: rec.cerradaEn || null, motivoCierre: rec.motivoCierre || null,
        cierrePedido: rec.estado === 'cerrando', pnl, spxAhora, simulado: !!rec.simulado, sesion: rec.sesion || 'regular',
        ranura: rec.ranura || 'principal',
      };
    };
    let trade = null;
    if (rec) trade = await vista(rec);
    const ad = abierta('adicional');
    const adicional = ad ? await vista(ad) : null;
    cacheEstado = { ts: Date.now(), data: { ok: true, modo: modo(), pnlHoy: pnlHoy(), freno: frenoUsd(), trade, adicional } };
    return cacheEstado.data;
  }

  // resumen de los trades cerrados del modo vigente (o del pedido): hoy y acumulado
  function resumen(modoPedido) {
    const m = modoPedido || modo();
    const hoy = fechaET();
    const cerr = cargar().filter((x) => x.modo === m && x.estado === 'cerrada' && x.pnlUsd != null);
    const est = (l) => {
      const n = l.length, g = l.filter((x) => x.pnlUsd > 0).length, tot = l.reduce((a, x) => a + x.pnlUsd, 0);
      return { n, ganados: g, pctGanados: n ? Math.round(100 * g / n) : null, pnlNeto: +tot.toFixed(2),
               promedio: n ? +(tot / n).toFixed(2) : null,
               comisiones: +l.reduce((a, x) => a + (x.feesApertura || 0) + (x.feesCierre || 0), 0).toFixed(2) };
    };
    const deHoy = cerr.filter((x) => x.fecha === hoy);
    return { ok: true, modo: m, hoy: est(deHoy), acumulado: est(cerr), desde: cerr.length ? cerr[cerr.length - 1].fecha : null,
             tradesHoy: deHoy.map((x) => ({ hora: x.abiertaEn, nombre: x.nombre, strikes: `${x.largo}/${x.corto}`, entrada: x.precioEntrada,
                                            salida: x.precioSalida, pnlNeto: x.pnlUsd, motivo: x.motivoCierre, strikesTxt: x.strikesTxt })) };
  }

  // vista de la cuenta demo para la web: saldo, curva, trades y la posicion abierta con su P&L en vivo
  async function demo() {
    const c = cuentaDemo();
    const cerr = c.trades.filter((x) => x.estado === 'cerrada');
    const g = cerr.filter((x) => x.pnlUsd > 0).length;
    let abierta = null, adicional = null;
    if (c.abiertos[0]) {
      const e = await estado();
      abierta = e.trade && e.trade.modo === 'dryrun' && e.trade.estado !== 'closed' ? e.trade : null;
      adicional = e.adicional && e.adicional.modo === 'dryrun' ? e.adicional : null;
    }
    return { ok: true, modo: modo(), capital: c.capital, desde: c.desde, saldo: c.saldo, disponible: c.disponible, reservado: c.reservado,
             pnlRealizado: c.realizado, pnlAbierto: +((abierta?.pnl ?? 0) + (adicional?.pnl ?? 0)).toFixed(2), adicional, rendimientoPct: +(100 * c.realizado / c.capital).toFixed(2),
             trades: cerr.length, ganados: g, pctGanados: cerr.length ? Math.round(100 * g / cerr.length) : null,
             promedio: cerr.length ? +(c.realizado / cerr.length).toFixed(2) : null,
             comisiones: +cerr.reduce((a, x) => a + (x.feesApertura || 0) + (x.feesCierre || 0), 0).toFixed(2),
             maxDrawdown: c.maxDrawdown, curva: c.curva, abierta,
             lista: c.trades.slice().reverse().map((x) => ({ id: x.id, fecha: x.fecha, abiertaEn: x.abiertaEn, cerradaEn: x.cerradaEn || null,
               nombre: x.nombre, direccion: x.direccion, strikes: x.strikesTxt || `${x.largo}/${x.corto}`, credito: x.credito, entrada: x.precioEntrada,
               salida: x.precioSalida ?? null, spxEntrada: x.spxEntrada, pnlBruto: x.pnlBrutoUsd ?? null, pnlNeto: x.pnlUsd ?? null,
               comisiones: +((x.feesApertura || 0) + (x.feesCierre || 0)).toFixed(2), motivo: x.motivoCierre || null, estado: x.estado,
               // 2026-10-20 (Guillermo: "en la bitácora pongamos el pdf de cada posición"): lo que necesita el informe del bot
               estructura: x.estructura || 'VERTICAL', corto: x.corto, largo: x.largo, ancho: x.ancho, vence: x.vence,
               contratos: x.contratos, riesgoMaxUsd: x.riesgoMaxUsd, gananciaMaxUsd: x.gananciaMaxUsd, deltaEntrada: x.deltaEntrada,
               vendidasEntrada: x.vendidasEntrada || null, spxSalida: x.spxSalida ?? null, sesion: x.sesion || 'regular',
               feesApertura: x.feesApertura || 0, feesCierre: x.feesCierre || 0, segEjecApertura: x.segEjecApertura ?? null })) };
  }

  // seguro: a las 15:30 ET se cierra lo que quede abierto
  function vigilar() {
    setInterval(async () => {
      try {
        if (ocupado) return;
        const m = horaETmin();
        for (const rec of abiertas()) {             // todas las ranuras (principal y el IB adicional)
          const r = rec.ranura || 'principal';
          if (rec.sesion === 'nocturna') {
            // la práctica nocturna se cierra sola al terminar su ventana (23:30 ET)
            if (m > NOCHE_HASTA || m < NOCHE_DESDE) await cerrar('CIERRE_FIN_PRACTICA_NOCTURNA', r);
          } else if (m >= 15 * 60 + 30) await cerrar('CIERRE_PRE_CLOSE_1530', r);
        }
      } catch (e) { console.error('[CLIC_REAL] vigilancia:', e.message); }
    }, 20000);
  }

  return { preview, previewIB, ejecutar, cerrar, estado, vigilar, modo, resumen, demo, _cuerpoOrden: cuerpoOrden, _r05: r05 };
}

module.exports = { crearClicReal, ACCION };
