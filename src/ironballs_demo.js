'use strict';
// ── Iron Balls → cuenta DEMO en TastyTrade (Guillermo 2026-11-03) ───────────────────────────
//
// "coordinemos para que ejecute una orden demo en tastytrade y que me envie un ntfy". Decisiones de Guillermo:
//   - demo PROPIA de Iron Balls ($2.000, su curva), aparte de la demo del Clic SPX (no comparte saldo ni ranura)
//   - ntfy en la ENTRADA y en el CIERRE (excepcion explicita a la norma de "solo cierres", solo para esta familia)
//
// Mismo metodo que la demo del Clic (src/clic_real.js): la orden se valida contra la cuenta real con
// /orders/dry-run (que devuelve las comisiones reales) y el llenado se SIMULA al medio + 0.05 en contra.
// ESTE MODULO NUNCA MANDA UNA ORDEN: la unica ruta de escritura que toca es /orders/dry-run.
//
// Abre con la "Options Alert" de Pipe (los strikes y el vencimiento los pone el) y cierra con su "⚠️ CLOSED"
// o, como seguro, a las 15:30 ET. Sin TP ni SL propios. Registro en <DATA_DIR>/ironballs_demo.json.
// Los trades marcados prueba:true (la prueba forzada) quedan aparte: no tocan el saldo.
const fs = require('fs');
const path = require('path');

const TICK = 0.05;
const r05 = (x, arriba) => +((arriba ? Math.ceil(x / TICK - 1e-9) : Math.floor(x / TICK + 1e-9)) * TICK).toFixed(2);
const fechaET = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
const NOMBRE = { BULL_PUT_SPREAD: 'Bull Put Spread', BEAR_CALL_SPREAD: 'Bear Call Spread',
                 BULL_CALL_SPREAD: 'Bull Call Spread', BEAR_PUT_SPREAD: 'Bear Put Spread' };
const usd = (v) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;

// 🐂 alcista / 🐻 bajista en el título del ntfy (el emoji en el texto se ve también en el iPhone)
const bicho = (d) => (d === 'BULLISH' ? '🐂' : d === 'BEARISH' ? '🐻' : '');

// 2026-11-10: la misma demo sirve para las entradas de ALEJANDRO (foto OptionStrat del grupo Operaciones): instancia aparte
// con su archivo, su saldo y stop por perdida (stopUsd por contrato). fuente = quien manda la senal (sale en el ntfy).
function crearIronBallsDemo({ tt, dataDir, horaETmin, avisar = () => {}, capital = 2000, maxAbiertas = 3,
                              archivo = 'ironballs_demo.json', fuente = 'Pipe', stopUsd = null }) {
  const ARCHIVO = path.join(dataDir, archivo);
  const cargar = () => { try { return JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')); } catch (e) { return []; } };
  const guardar = (l) => fs.writeFileSync(ARCHIVO, JSON.stringify(l.slice(0, 2000), null, 2), 'utf8');
  const cuenta = () => process.env.CLIC_REAL_CUENTA || tt.accountNumber;

  // serializa aperturas, cierres y el seguro: nunca dos a la vez sobre el mismo archivo
  let cola = Promise.resolve();
  const enCola = (fn) => { const t = cola.then(fn, fn); cola = t.catch(() => {}); return t; };

  const occ = (expiry, tipo, strike) =>
    `SPXW  ${expiry.replace(/-/g, '').slice(2)}${tipo}${String(Math.round(strike * 1000)).padStart(8, '0')}`;

  // legs: [{ sym, lado }] lado +1 comprada, -1 vendida. Valores en "costo de comprar la estructura" (+ debito, - credito)
  async function cotizar(legs) {
    const d = await tt._req(`/market-data?${legs.map((x) => `symbols[]=${encodeURIComponent(x.sym)}`).join('&')}`);
    const q = {};
    for (const it of d?.data?.items || []) q[it.symbol] = { bid: Number(it.bid), ask: Number(it.ask) };
    let medio = 0, compraNat = 0, ventaNat = 0;
    for (const x of legs) {
      const c = q[x.sym];
      if (!c || !Number.isFinite(c.bid) || !Number.isFinite(c.ask)) throw new Error(`sin cotizacion de ${x.sym}`);
      medio += x.lado * (c.bid + c.ask) / 2;
      compraNat += x.lado > 0 ? c.ask : -c.bid;
      ventaNat += x.lado > 0 ? c.bid : -c.ask;
    }
    return { medio: +medio.toFixed(2), compraNat: +compraNat.toFixed(2), ventaNat: +ventaNat.toFixed(2) };
  }

  function cuerpoOrden(rec, precio, abrir) {
    const efecto = (abrir ? !rec.credito : rec.credito) ? 'Debit' : 'Credit';
    return {
      'time-in-force': 'Day', 'order-type': 'Limit', price: Math.abs(precio).toFixed(2), 'price-effect': efecto,
      legs: rec.legs.map((x) => ({
        'instrument-type': 'Equity Option', symbol: x.sym, quantity: rec.contratos,
        action: x.lado > 0 ? (abrir ? 'Buy to Open' : 'Sell to Close') : (abrir ? 'Sell to Open' : 'Buy to Close'),
      })),
    };
  }

  // SOLO dry-run: valida la orden contra la cuenta y trae las comisiones. Nunca /orders a secas.
  async function dryRun(cuerpo) {
    const r = await tt._req(`/accounts/${cuenta()}/orders/dry-run`, { method: 'POST', body: JSON.stringify(cuerpo) });
    return { fees: Number(r?.data?.['fee-calculation']?.['total-fees'] || 0), avisos: (r?.data?.warnings || []).map((w) => w.message || w.code) };
  }

  const enCurso = (x) => x.estado === 'abierta';
  const abiertas = () => cargar().filter(enCurso);

  function saldoDemo() {
    const l = cargar().filter((x) => !x.prueba);
    const realizado = l.filter((x) => x.estado === 'cerrada' && x.pnlUsd != null).reduce((a, x) => a + x.pnlUsd, 0);
    const reservado = l.filter(enCurso).reduce((a, x) => a + (x.riesgoMaxUsd || 0) + 2 * (x.feesApertura || 0), 0);
    const saldo = +(capital + realizado).toFixed(2);
    return { capital, saldo, realizado: +realizado.toFixed(2), reservado: +reservado.toFixed(2), disponible: +(saldo - reservado).toFixed(2) };
  }

  // p = salida de ironballs.parsearAlerta (ok, vertical, clave, prima...). meta = { alertId, mensajeAt, edadMin, prueba }
  function abrir(p, meta = {}) {
    return enCola(async () => {
      const v = p.vertical;
      const credito = v.strategy === 'BULL_PUT_SPREAD' || v.strategy === 'BEAR_CALL_SPREAD';
      const l0 = cargar();
      if (l0.some((x) => enCurso(x) && x.clave === p.clave)) return { ok: false, estado: 'DUPLICADA', motivo: 'ya hay una demo abierta con esos strikes' };
      if (l0.filter((x) => enCurso(x) && !x.prueba).length >= maxAbiertas && !meta.prueba) {
        return { ok: false, estado: 'CUPO_LLENO', motivo: `${maxAbiertas} demos abiertas` };
      }
      const legs = [{ sym: occ(v.expiry, v.tipo, v.shortStrike), lado: -1 }, { sym: occ(v.expiry, v.tipo, v.longStrike), lado: 1 }];
      const rec = { credito, contratos: 1, legs };
      const q = await cotizar(legs);
      // llenado simulado: medio + 0.05 en contra, sin pasar del natural (igual que la demo del Clic)
      const medio = credito ? r05(-q.medio, false) : r05(q.medio, true);
      const nat = credito ? r05(-q.compraNat, false) : r05(q.compraNat, true);
      const precio = credito ? Math.max(nat, +(medio - TICK).toFixed(2)) : Math.min(nat, +(medio + TICK).toFixed(2));
      if (!(precio > 0)) return { ok: false, estado: 'SIN_PRECIO', motivo: `precio de entrada inválido (medio ${medio}, natural ${nat})` };
      const riesgoMaxUsd = Math.round((credito ? v.ancho - precio : precio) * 100);
      if (!meta.prueba && riesgoMaxUsd > saldoDemo().disponible) {
        return { ok: false, estado: 'SIN_SALDO', motivo: `riesgo $${riesgoMaxUsd} > disponible $${saldoDemo().disponible}` };
      }
      const dr = await dryRun(cuerpoOrden(rec, precio, true));
      let spx = null;
      try { spx = Number((await tt._req('/market-data?symbols[]=SPX'))?.data?.items?.[0]?.last) || null; } catch (e) { /* informativo */ }
      const nombre = NOMBRE[v.strategy] || v.strategy;
      const r = {
        id: 'ibd-' + Date.now(), prueba: !!meta.prueba, fecha: fechaET(), estado: 'abierta', simulado: true,
        clave: p.clave, estrategia: v.strategy, nombre, direccion: v.direction, credito, contratos: 1, legs,
        vence: v.expiry, corto: v.shortStrike, largo: v.longStrike, ancho: v.ancho,
        fuenteSenal: fuente, enviadoPor: meta.autor || fuente, stopUsd: stopUsd || null,
        precioEntrada: precio, medioEntrada: medio, naturalEntrada: nat, primaPipe: p.prima ?? null,
        diferenciaVsPipe: p.prima != null ? +((credito ? precio - p.prima : p.prima - precio)).toFixed(2) : null,   // + = mejor que la senal
        riesgoMaxUsd, gananciaMaxUsd: Math.round((credito ? precio : v.ancho - precio) * 100),
        feesApertura: dr.fees, avisosDryRun: dr.avisos, spxEntrada: spx, spxPipe: p.spot ?? null,
        alertId: meta.alertId || null, mensajeAt: meta.mensajeAt || null, edadMin: meta.edadMin ?? null,
        abiertaEn: new Date().toISOString(),
      };
      const l = cargar(); l.unshift(r); guardar(l);
      const pr = r.prueba ? '[PRUEBA] ' : '';
      avisar(`${nombre} ${v.shortStrike}/${v.longStrike} · vence ${v.expiry} · señal de ${r.enviadoPor}\n`
           + `${credito ? 'Crédito' : 'Débito'} demo $${precio.toFixed(2)}`
           + (p.prima != null ? ` (${fuente} $${p.prima.toFixed(2)} · ${usd(r.diferenciaVsPipe * 100)} vs ${fuente})\n` : '\n')
           + `Riesgo máx $${riesgoMaxUsd} · Ganancia máx $${r.gananciaMaxUsd} · comisión apertura $${dr.fees.toFixed(2)}\n`
           + (stopUsd ? `Stop: pérdida de $${stopUsd} por contrato\n` : '')
           + `SPX ${spx ?? '?'} · señal con ${meta.edadMin ?? '?'} min · DEMO TastyTrade (dry-run)`,
             `${pr}💣 ${bicho(v.direction)} ${fuente} abrió: ${nombre} ${v.shortStrike}/${v.longStrike} (demo)`, 'bell');
      return { ok: true, estado: 'DEMO_ABIERTA', motivo: `${nombre} ${v.shortStrike}/${v.longStrike} a ${precio} (${fuente} ${p.prima ?? '?'})`, registro: r };
    });
  }

  // cierra la demo con esa clave (CLOSED de Pipe) o por id (seguro 15:30). pipe = { pct, resultadoDolares }
  // ultima: true = la demo abierta mas reciente (el "Fuera" de Alejandro no trae strikes)
  function cerrar({ clave = null, id = null, ultima = false, motivo = 'CLOSED_PIPE', pipe = null } = {}) {
    return enCola(async () => {
      let l = cargar();
      const rec = l.find((x) => enCurso(x) && (ultima ? !x.prueba : id ? x.id === id : x.clave === clave));
      if (!rec) return { ok: false, estado: 'SIN_DEMO', motivo: 'no hay demo abierta con esa clave' };
      const q = await cotizar(rec.legs);
      // cerrar: un credito se recompra (sube hacia el natural), un debito se vende (baja hacia el natural); +0.05 en contra
      const medio = rec.credito ? r05(-q.medio, true) : r05(q.medio, false);
      const nat = rec.credito ? r05(-q.ventaNat, true) : r05(Math.max(0, q.ventaNat), false);
      let precio = rec.credito ? Math.min(nat, +(medio + TICK).toFixed(2)) : Math.max(nat, +(medio - TICK).toFixed(2));
      precio = Math.max(0, precio);
      let fees = 0;
      try { fees = precio >= TICK ? (await dryRun(cuerpoOrden(rec, precio, false))).fees : 0; } catch (e) { fees = rec.feesApertura || 0; }
      let spx = null;
      try { spx = Number((await tt._req('/market-data?symbols[]=SPX'))?.data?.items?.[0]?.last) || null; } catch (e) { /* informativo */ }
      l = cargar();
      const r = l.find((x) => x.id === rec.id);
      Object.assign(r, { estado: 'cerrada', cerradaEn: new Date().toISOString(), precioSalida: precio, feesCierre: fees,
                         motivoCierre: motivo, pipeCierre: pipe, spxSalida: spx });
      r.pnlBrutoUsd = Math.round((r.credito ? r.precioEntrada - precio : precio - r.precioEntrada) * 100 * r.contratos);
      r.pnlUsd = +(r.pnlBrutoUsd - (r.feesApertura || 0) - fees).toFixed(2);
      guardar(l);
      const seg = Math.round((new Date(r.cerradaEn) - new Date(r.abiertaEn)) / 1000);
      const dur = seg >= 3600 ? `${Math.floor(seg / 3600)} h ${Math.floor(seg % 3600 / 60)} min` : `${Math.floor(seg / 60)} min ${seg % 60} s`;
      const pr = r.prueba ? '[PRUEBA] ' : '';
      const s = saldoDemo();
      avisar(`${r.nombre} ${r.corto}/${r.largo}: ${r.precioEntrada.toFixed(2)} → ${precio.toFixed(2)}\n`
           + `Bruto ${usd(r.pnlBrutoUsd)} · comisiones -$${((r.feesApertura || 0) + fees).toFixed(2)} · NETO ${usd(r.pnlUsd)}\n`
           + (pipe ? `${fuente} reportó: ${pipe.pct != null ? pipe.pct + '%' : ''}${pipe.resultadoDolares != null ? ` ${usd(pipe.resultadoDolares)}` : ''}\n` : '')
           + `Tiempo: ${dur} · Motivo: ${motivo}\n`
           + (r.prueba ? 'Prueba: no cuenta en el saldo' : `Saldo demo Iron Balls (${fuente}): $${s.saldo.toFixed(2)}`) + ' · DEMO TastyTrade (dry-run)',
             `${pr}${r.pnlUsd >= 0 ? '✅ GANÓ' : '🔻 PERDIÓ'} ${usd(r.pnlUsd)} · 💣 ${bicho(r.direccion)} ${fuente} ${r.nombre} (demo)`,
             r.pnlUsd >= 0 ? 'white_check_mark' : 'small_red_triangle_down');
      return { ok: true, estado: 'DEMO_CERRADA', motivo: `${r.precioEntrada} → ${precio}, neto ${usd(r.pnlUsd)}`, registro: r };
    });
  }

  // anota datos que llegan despues de abrir (nivel de control, "Dentro con X") en la demo abierta mas reciente
  function anotar(campos) {
    return enCola(async () => {
      const l = cargar();
      const r = l.find((x) => enCurso(x) && !x.prueba);
      if (!r) return null;
      Object.assign(r, campos); guardar(l);
      return r.id;
    });
  }

  // stop por perdida (solo si stopUsd): cada 10 s en mercado, si recomprar cuesta stopUsd mas que el credito, se cierra
  async function revisarStop() {
    if (!stopUsd) return;
    const m = horaETmin();
    if (m < 9 * 60 + 30 || m > 16 * 60) return;
    for (const rec of abiertas()) {
      try {
        const q = await cotizar(rec.legs);
        // al MEDIO (no al natural): en 0DTE el spread bid/ask se abre y dispararia el stop sin que el precio se mueva
        const salida = rec.credito ? r05(-q.medio, true) : r05(Math.max(0, q.medio), false);
        const perdida = Math.round((rec.credito ? salida - rec.precioEntrada : rec.precioEntrada - salida) * 100 * rec.contratos);
        if (perdida >= stopUsd * rec.contratos) await cerrar({ id: rec.id, motivo: `STOP_${stopUsd}` });
      } catch (e) { console.error(`[IRONBALLS_DEMO ${fuente}] stop:`, e.message); }
    }
  }

  // seguro: a las 15:30 ET se cierra toda demo que siga abierta (0DTE)
  function vigilar() {
    if (stopUsd) setInterval(() => { revisarStop().catch(() => {}); }, 10000);
    setInterval(async () => {
      try {
        if (horaETmin() < 15 * 60 + 30) return;
        for (const rec of abiertas()) {
          if (rec.vence > fechaET()) continue;     // las de 1DTE+ siguen hasta su dia
          await cerrar({ id: rec.id, motivo: 'CIERRE_PRE_CLOSE_1530' });
        }
      } catch (e) { console.error('[IRONBALLS_DEMO] vigilancia:', e.message); }
    }, 30000);
  }

  function resumen() {
    const l = cargar();
    const cerr = l.filter((x) => !x.prueba && x.estado === 'cerrada' && x.pnlUsd != null);
    const g = cerr.filter((x) => x.pnlUsd > 0).length;
    return { ok: true, ...saldoDemo(), trades: cerr.length, ganados: g, pctGanados: cerr.length ? Math.round(100 * g / cerr.length) : null,
             abiertas: l.filter(enCurso), lista: l.slice(0, 100) };
  }

  return { abrir, cerrar, anotar, vigilar, resumen, revisarStop, _occ: occ };
}

module.exports = { crearIronBallsDemo };
