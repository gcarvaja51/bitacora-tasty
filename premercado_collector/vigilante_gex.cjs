/**
 * VIGILANTE EN VIVO -- muro dominante + MACD/EMAs -> Iron Butterfly
 * =================================================================
 *
 * Corre durante la sesion. Cada ciclo:
 *   1. Captura el perfil de GEX (magnitudes por strike).
 *   2. Mide persistencia del muro, dominancia (regla del 2x) y compresion.
 *   3. Mide MACD y dispersion de EMAs sobre velas de 15m cerradas.
 *   4. Si TODO alinea, arma un iron butterfly centrado en el STRIKE DOMINANTE
 *      y lo ejecuta en Tradier (sandbox) si el interruptor esta encendido.
 *
 * El centro es el muro dominante -- ni el pin del premercado ni el ATM. Esa era
 * una pregunta abierta y esto la cierra: medido sobre 24 dias, centrar en el pin
 * del premercado daba EV -6,67 y en el ATM -3,73; el lunes 24 fue el caso
 * extremo (pin habria dado perdida maxima, ATM casi ganancia maxima). La tesis
 * de Guillermo es que el sitio bueno es donde esta el dinero, y eso es lo que
 * este vigilante mide en vivo.
 *
 * REGISTRA SIEMPRE, dispare o no. Cada evaluacion va al log aunque no se opere:
 * sin las evaluaciones fallidas no hay forma de saber si los umbrales estan
 * bien puestos o si la señal simplemente nunca se da.
 *
 * Uso:
 *   node vigilante_gex.cjs            # una pasada
 *   node vigilante_gex.cjs --loop     # vigila hasta el cierre
 *   node vigilante_gex.cjs --dry      # evalua y registra, nunca ejecuta
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const senalGex = require('../src/senal_gex.js');
const senalesH = require('../src/senales_horizontal.js');
const { TradierClient } = require('../src/tradier.js');

const BASE = path.join('C:', 'Users', 'gcarv', 'Documents', 'CARPETA PERSONAL',
  '01. guillermo carvajal', '01_Sigma', 'mentoria alejandro',
  'premercados alejandro', 'control premercado');
const HIST_GEX = path.join(BASE, 'neutrales', 'gex_perfil_historico.jsonl');
const DIR_CADENAS = path.join(BASE, 'neutrales', 'cadenas');
const BITACORA = path.join(BASE, 'neutrales', 'vigilante_gex_log.jsonl');
const RAIZ = path.join(__dirname, '..');
const CFG_PATH = path.join(RAIZ, 'spx_config.json');
const STRATEGY_LOG = path.join(RAIZ, 'spx_strategy_log.json');

const LOOP = process.argv.includes('--loop');
const DRY = process.argv.includes('--dry');

const leerJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };
const hoyET = () => new Intl.DateTimeFormat('en-CA',
  { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const horaET = () => new Intl.DateTimeFormat('en-GB',
  { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
const horaDecET = () => { const [h, m] = horaET().split(':').map(Number); return h + m / 60; };
const dormir = ms => new Promise(r => setTimeout(r, ms));

function logEstrategia(entry) {
  try {
    const log = leerJSON(STRATEGY_LOG, []);
    log.unshift({ timestamp: new Date().toISOString(), strategyFamily: 'PREMERCADO', ...entry });
    fs.writeFileSync(STRATEGY_LOG, JSON.stringify(log.slice(0, 5000), null, 1));
  } catch (e) { console.error('[log]', e.message); }
}

/** Capturas de GEX de HOY, de mas antigua a mas reciente. */
function capturasDeHoy() {
  if (!fs.existsSync(HIST_GEX)) return [];
  const hoy = hoyET();
  return fs.readFileSync(HIST_GEX, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(r => r && r.fechaET === hoy)
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

async function velas15mCerradas() {
  const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=15m&range=5d',
    { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await r.json();
  const res = j.chart?.result?.[0];
  const ts = res?.timestamp || [], q = res?.indicators?.quote?.[0] || {};
  const ahora = Date.now() / 1000, out = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null) continue;
    if ((ahora - ts[i]) < 900) continue;      // vela en curso: no cuenta
    out.push(q.close[i]);
  }
  return { cierres: out, precio: res?.meta?.regularMarketPrice ?? null };
}

function cadenaFresca(maxEdadMin = 6) {
  const tag = hoyET().replace(/-/g, '');
  let mejor = null;
  try {
    for (const f of fs.readdirSync(DIR_CADENAS)) {
      if (!f.startsWith(`spx_0dte_${tag}`)) continue;
      const p = path.join(DIR_CADENAS, f), st = fs.statSync(p);
      if (!mejor || st.mtimeMs > mejor.mtimeMs) mejor = { p, mtimeMs: st.mtimeMs };
    }
  } catch (e) { /* no existe */ }
  if (!mejor || (Date.now() - mejor.mtimeMs) / 60000 > maxEdadMin) return null;
  const s = leerJSON(mejor.p, null);
  return s && { expiry: s.expiry, spot: s.spot,
                strikes: s.filas.map(f => ({ strike: f.strike, call: f.call, put: f.put })) };
}

/** Butterfly centrado en `centro`, con precios reales de la cadena. */
function armarButterfly(exp, centro, ala, minPctAla) {
  const fila = k => exp.strikes.find(s => Number(s.strike) === k);
  const legs = [
    ['put', centro, false], ['put', centro - ala, true],
    ['call', centro, false], ['call', centro + ala, true],
  ];
  let neto = 0;
  for (const [tipo, k, comprar] of legs) {
    const f = fila(k);
    const o = tipo === 'put' ? f?.put : f?.call;
    if (!o) return { ok: false, motivo: `falta el strike ${k} (${tipo}) en la cadena` };
    const px = comprar ? o.ask : o.bid;
    if (!(px > 0)) return { ok: false, motivo: `strike ${k} (${tipo}) sin precio ejecutable` };
    neto += comprar ? -px : px;
  }
  const pct = (neto / ala) * 100;
  if (neto <= 0) return { ok: false, motivo: `credito no positivo (${neto.toFixed(2)})` };
  if (pct < minPctAla) {
    return { ok: false, motivo: `credito ${neto.toFixed(2)} es ${pct.toFixed(0)}% del ala; ` +
             `minimo ${minPctAla}%` };
  }
  return {
    ok: true, tipo: 'IRON_BUTTERFLY', expiry: exp.expiry, centroStrike: centro, ala,
    putCortoStrike: centro, putLargoStrike: centro - ala,
    callCortoStrike: centro, callLargoStrike: centro + ala,
    credito: +neto.toFixed(2), limite: +neto.toFixed(2),
    maxGanancia: +neto.toFixed(2), maxPerdida: +(ala - neto).toFixed(2),
    rr: +(neto / (ala - neto)).toFixed(2),
    breakevens: [+(centro - neto).toFixed(2), +(centro + neto).toFixed(2)],
    pctDelAla: +pct.toFixed(1),
  };
}

async function pasada(tradier, cfg) {
  const hora = horaET();
  const vg = cfg.vigilanteGex || {};
  const autoExec = cfg.tradierAutoExecute === true && vg.autoExecute === true && !DRY;

  // 1. capturar perfil fresco
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'gex_perfil.cjs')],
      { stdio: 'ignore' });
  } catch (e) { console.error(`[${hora}] la captura de GEX fallo: ${e.message}`); }

  const caps = capturasDeHoy();
  const sg = senalGex.evaluar(caps, vg);
  const { cierres, precio } = await velas15mCerradas();
  const sh = senalesH.evaluar(cierres, (cfg.neutral || {}));

  const linea = { ts: new Date().toISOString(), fechaET: hoyET(), horaET: hora,
                  spot: precio, capturas: caps.length,
                  gex: { ok: sg.ok, lado: sg.lado, strike: sg.strike,
                         dominancia: sg.dominancia, minutosEstable: sg.minutosEstable,
                         corredor: sg.corredor, callWall: sg.callWall, callWall2x: sg.callWall2x,
                         putWall: sg.putWall, putWall2x: sg.putWall2x, motivo: sg.motivo },
                  horizontal: { ok: sh.ok, macdHist: sh.macdHist, dispEmas: sh.dispEmas,
                                motivo: sh.motivo },
                  disparo: false, estructura: null, ejecucion: null };

  const alineado = sg.ok && sh.ok;
  console.log(`[${hora}] SPX ${precio}  caps ${caps.length}`);
  console.log(`   GEX  : ${sg.ok ? 'OK ' : 'no '} ${sg.motivo}`);
  console.log(`   ritmo: ${sh.ok ? 'OK ' : 'no '} ${sh.motivo}`);

  if (!alineado) {
    fs.appendFileSync(BITACORA, JSON.stringify(linea) + '\n');
    return true;
  }

  // 2. ya hubo trade hoy?
  const previas = fs.existsSync(BITACORA)
    ? fs.readFileSync(BITACORA, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
  if (previas.some(r => r.fechaET === hoyET() && r.disparo)) {
    console.log('   -> señal alineada pero YA se disparo hoy; uno por dia');
    linea.gex.motivo += ' (ya operado hoy)';
    fs.appendFileSync(BITACORA, JSON.stringify(linea) + '\n');
    return false;
  }

  // 3. armar el butterfly en el strike dominante
  const exp = cadenaFresca();
  if (!exp) {
    console.log('   -> sin cadena fresca, no se arma');
    fs.appendFileSync(BITACORA, JSON.stringify(linea) + '\n');
    return true;
  }
  const est = armarButterfly(exp, sg.strike, vg.ala || 25,
                             vg.minCreditoAnchoPct ?? (cfg.neutral || {}).minCreditoAnchoPct ?? 35);
  if (!est.ok) {
    console.log(`   -> señal OK pero la estructura no sirve: ${est.motivo}`);
    linea.gex.motivo += ` | estructura rechazada: ${est.motivo}`;
    fs.appendFileSync(BITACORA, JSON.stringify(linea) + '\n');
    logEstrategia({ stage: 'VIGILANTE_ESTRUCTURA_RECHAZADA', passed: false, etTime: hora,
                    reason: est.motivo, snapshot: { spxPrice: precio, gex: linea.gex } });
    return true;
  }

  linea.disparo = true;
  linea.estructura = est;
  console.log(`   *** SEÑAL COMPLETA -> IRON BUTTERFLY ${est.centroStrike} +-${est.ala}`);
  console.log(`       credito ${est.credito} (${est.pctDelAla}% del ala)  R:R 1:${est.rr}  ` +
              `BE ${est.breakevens.join(' - ')}`);

  if (!autoExec) {
    console.log(`       [${DRY ? 'DRY-RUN' : 'interruptor apagado'}] no se ejecuta`);
    fs.appendFileSync(BITACORA, JSON.stringify(linea) + '\n');
    logEstrategia({ stage: 'VIGILANTE_SENAL_PAPEL', passed: true, etTime: hora,
                    reason: `${sg.motivo} | ${sh.motivo}`,
                    snapshot: { spxPrice: precio, gex: linea.gex, estructura: est } });
    return false;
  }

  try {
    const order = await tradier.placeIronCondorOrder({
      underlyingRoot: 'SPXW', expiry: est.expiry,
      putShortStrike: est.putCortoStrike, putLongStrike: est.putLargoStrike,
      callShortStrike: est.callCortoStrike, callLongStrike: est.callLargoStrike,
      quantity: cfg.contratos || 1, minCreditPrice: est.limite,
    });
    linea.ejecucion = { orderId: order.orderId, status: order.status, legs: order.legs };
    console.log(`       [Tradier] orden enviada: ${order.orderId} (${order.status})`);
    logEstrategia({ stage: 'VIGILANTE_EXECUTED', passed: true, etTime: hora,
                    reason: `IB ${est.centroStrike} por muro ${sg.lado} ${sg.dominancia}x`,
                    snapshot: { spxPrice: precio, gex: linea.gex, estructura: est,
                                orderId: order.orderId } });
  } catch (e) {
    linea.ejecucion = { error: e.message };
    console.error(`       [Tradier] FALLO: ${e.message}`);
    logEstrategia({ stage: 'VIGILANTE_EXEC_FALLO', passed: false, etTime: hora,
                    reason: e.message, snapshot: { spxPrice: precio, estructura: est } });
  }
  fs.appendFileSync(BITACORA, JSON.stringify(linea) + '\n');
  return false;
}

(async () => {
  const cfg = (leerJSON(CFG_PATH, {}).trading || {}).premercado || {};
  const vg = cfg.vigilanteGex || {};
  const tradier = new TradierClient({
    accessToken: process.env.TRADIER_ACCESS_TOKEN,
    accountNumber: process.env.TRADIER_ACCOUNT_NUMBER,
    baseUrl: process.env.TRADIER_BASE_URL,
  });
  fs.mkdirSync(path.dirname(BITACORA), { recursive: true });

  if (!LOOP) { await pasada(tradier, cfg); return; }

  const cada = (vg.intervaloMin || 5) * 60 * 1000;
  const desde = vg.desdeET ?? 10.0, hasta = vg.hastaET ?? 15.0;
  console.log(`[vigilante] cada ${cada / 60000} min entre las ${desde} y las ${hasta} ET`);
  while (horaDecET() < hasta) {
    if (horaDecET() >= desde) {
      try {
        const sigue = await pasada(tradier, cfg);
        if (!sigue) { console.log('[vigilante] nada mas que hacer hoy'); break; }
      } catch (e) { console.error('[vigilante]', e.message); }
    } else {
      console.log(`[${horaET()}] antes de la ventana, esperando`);
    }
    await dormir(cada);
  }
  console.log('[vigilante] fin');
})().catch(e => { console.error('[FALLO]', e.message); process.exit(1); });
