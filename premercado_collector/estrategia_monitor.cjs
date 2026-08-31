/**
 * ESTRATEGIA PREMERCADO -- monitor de salida (TP / SL)
 * ====================================================
 *
 * Vigila la posicion abierta del dia y la cierra cuando toca. Dos criterios
 * distintos, uno por tipo de estructura, y NO son intercambiables:
 *
 * DEBIT_VERTICAL (direccional)
 *   TP: por NIVEL del subyacente -- el objetivo mas lejano que declaro el
 *       premercado (`nivelProfit`). Es lo que pidio Guillermo el 2026-08-25:
 *       "profit en los niveles que se determinen en premercado, el valor mas
 *       alejado". No es un porcentaje: si el analisis dijo 7.638, se cierra en
 *       7.638. Asi el trade mide la tesis del informe y no un umbral generico.
 *   SL: `slPct` sobre el DEBITO pagado -- misma convencion que
 *       `trading.debit.slPct` de las direccionales existentes.
 *
 * IRON_CONDOR (neutral)
 *   TP: `tpPct` del credito recibido.
 *   SL: `slMult` sobre el COSTO DE CERRAR, no sobre el P&L neto. Esto ultimo
 *       importa y no es un detalle: con credito 200 y slMult 1.5, el umbral es
 *       que cerrar cueste 300 (perdida neta real -100), NO que el neto caiga a
 *       -300. Es exactamente el bug que ya se corrigio en el condor de
 *       produccion (ver server.js ~9133); se replica la version correcta.
 *
 * Un neutral no tiene "nivel mas lejano" en sentido direccional, por eso ahi el
 * TP sigue siendo porcentual. Mezclar los dos criterios seria inventar.
 *
 * Uso:
 *   node estrategia_monitor.cjs           # una pasada
 *   node estrategia_monitor.cjs --loop    # vigila hasta el cierre
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { TradierClient } = require('../src/tradier.js');

const BASE = path.join('C:', 'Users', 'gcarv', 'Documents', 'CARPETA PERSONAL',
  '01. guillermo carvajal', '01_Sigma', 'mentoria alejandro',
  'premercados alejandro', 'control premercado');
const REGISTRO = path.join(BASE, 'estrategia_premercado_papel.json');
const RAIZ = path.join(__dirname, '..');
const CFG_PATH = path.join(RAIZ, 'spx_config.json');
const STRATEGY_LOG = path.join(RAIZ, 'spx_strategy_log.json');

const LOOP = process.argv.includes('--loop');
const leerJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };
const guardar = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 1));
const hoyET = () => new Intl.DateTimeFormat('en-CA',
  { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const horaET = () => new Intl.DateTimeFormat('en-GB',
  { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
const horaDecET = () => { const [h, m] = horaET().split(':').map(Number); return h + m / 60; };
const dormir = (ms) => new Promise(r => setTimeout(r, ms));

function logEstrategia(entry) {
  try {
    const log = leerJSON(STRATEGY_LOG, []);
    log.unshift({ timestamp: new Date().toISOString(), strategyFamily: 'PREMERCADO', ...entry });
    guardar(STRATEGY_LOG, log.slice(0, 5000));
  } catch (e) { console.error('[log]', e.message); }
}

async function spxAhora() {
  const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1m&range=1d',
    { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await r.json();
  return j.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
}

/** Cotizaciones de las patas, indexadas por simbolo OCC. */
async function cotizar(tradier, syms) {
  const q = await tradier.getQuotes(syms);
  const arr = Array.isArray(q) ? q : (q?.quotes?.quote ? [].concat(q.quotes.quote) : []);
  const m = {};
  for (const x of arr) m[x.symbol] = x;
  return m;
}

/** ¿Toca cerrar? Devuelve {cerrar:'TP'|'SL'|null, detalle} */
function evaluarSalida(e, spx, cot, cfg) {
  const s = e.estructura;
  const legs = e.ejecucion?.legs || {};

  if (s.tipo === 'DEBIT_VERTICAL') {
    const esCall = s.sentido === 'CALL';
    const nivel = s.nivelProfit;
    // TP por NIVEL del subyacente, no por precio del spread.
    const alcanzado = esCall ? (spx >= nivel) : (spx <= nivel);
    if (alcanzado) {
      return { cerrar: 'TP', detalle: `SPX ${spx.toFixed(2)} alcanzo el nivel del premercado ${nivel}` };
    }
    // SL: se compara el VALOR ACTUAL del spread contra el debito pagado.
    const L = cot[legs.longSym], C = cot[legs.shortSym];
    if (!L || !C) return { cerrar: null, detalle: 'sin cotizacion de alguna pata' };
    // Cerrar = vender la larga (bid) y recomprar la corta (ask).
    const valorCierre = (L.bid ?? 0) - (C.ask ?? 0);
    const pnl = valorCierre - s.debito;
    const slUmbral = s.debito * ((cfg.direccional?.slPct ?? 50) / 100);
    if (pnl <= -slUmbral) {
      return { cerrar: 'SL', detalle: `spread vale ${valorCierre.toFixed(2)} vs debito ${s.debito}; ` +
               `perdida ${pnl.toFixed(2)} supera el stop de ${slUmbral.toFixed(2)} ` +
               `(${cfg.direccional?.slPct ?? 50}% de lo pagado)` };
    }
    return { cerrar: null, detalle: `SPX ${spx.toFixed(2)} -> nivel ${nivel} | ` +
             `spread ${valorCierre.toFixed(2)} (pagado ${s.debito}, P&L ${pnl.toFixed(2)})` };
  }

  // IRON_CONDOR
  const q = (k) => cot[k] || {};
  const costoDeCerrar = ((q(legs.putShortSym).ask ?? 0) - (q(legs.putLongSym).bid ?? 0))
                      + ((q(legs.callShortSym).ask ?? 0) - (q(legs.callLongSym).bid ?? 0));
  const credito = s.credito;
  const pnl = credito - costoDeCerrar;
  const tpUmbral = credito * ((cfg.neutral?.tpPct ?? 30) / 100);
  const slCosto = credito * (cfg.neutral?.slMult ?? 1.5);
  if (pnl >= tpUmbral) {
    return { cerrar: 'TP', detalle: `P&L ${pnl.toFixed(2)} alcanzo el ${cfg.neutral?.tpPct ?? 30}% ` +
             `del credito (${tpUmbral.toFixed(2)})` };
  }
  if (costoDeCerrar >= slCosto) {
    return { cerrar: 'SL', detalle: `cerrar cuesta ${costoDeCerrar.toFixed(2)}, que supera ` +
             `${cfg.neutral?.slMult ?? 1.5}x el credito (${slCosto.toFixed(2)})` };
  }
  return { cerrar: null, detalle: `cerrar cuesta ${costoDeCerrar.toFixed(2)} (credito ${credito}, ` +
           `P&L ${pnl.toFixed(2)})` };
}

async function cerrar(tradier, e, motivo, detalle, spx) {
  const s = e.estructura;
  const qty = e.ejecucion?.contratos || 1;
  try {
    let order;
    if (s.tipo === 'DEBIT_VERTICAL') {
      order = await tradier.closeSpreadOrder({
        strategy: s.sentido === 'CALL' ? 'BULL_CALL_SPREAD' : 'BEAR_PUT_SPREAD',
        underlyingRoot: 'SPXW', expiry: s.expiry,
        shortStrike: s.cortaStrike, longStrike: s.largaStrike, quantity: qty,
      });
    } else {
      order = await tradier.closeIronCondorOrder({
        underlyingRoot: 'SPXW', expiry: s.expiry,
        putShortStrike: s.putCortoStrike, putLongStrike: s.putLargoStrike,
        callShortStrike: s.callCortoStrike, callLongStrike: s.callLargoStrike,
        quantity: qty,
      });
    }
    e.salida = { motivo, detalle, spxAlCerrar: spx, orderId: order.orderId ?? null,
                 status: order.status ?? null, cerradaEn: new Date().toISOString(),
                 horaET: horaET() };
    console.log(`[${motivo}] cerrado — ${detalle}   orden ${order.orderId ?? '?'}`);
    logEstrategia({ stage: `CIERRE_${motivo}`, passed: true, etTime: horaET(),
                    reason: detalle, snapshot: { spxPrice: spx, estructura: s } });
  } catch (err) {
    e.salida = { motivo, detalle, spxAlCerrar: spx, error: err.message,
                 cerradaEn: new Date().toISOString(), horaET: horaET() };
    console.error(`[${motivo}] FALLO al cerrar: ${err.message}`);
    logEstrategia({ stage: `CIERRE_FALLO`, passed: false, etTime: horaET(),
                    reason: `${motivo}: ${err.message}`, snapshot: { spxPrice: spx } });
  }
}

async function pasada(tradier, cfg) {
  const reg = leerJSON(REGISTRO, []);
  const e = reg.find(r => r.fecha === hoyET() && r.operar && r.estructura
                          && r.ejecucion && !r.ejecucion.error && !r.salida);
  if (!e) { console.log(`[${horaET()}] sin posicion abierta que vigilar`); return false; }

  const spx = await spxAhora();
  if (spx == null) { console.log('[monitor] sin precio de SPX'); return true; }

  const legs = e.ejecucion.legs || {};
  const syms = Object.values(legs).filter(Boolean);
  const cot = syms.length ? await cotizar(tradier, syms) : {};

  const r = evaluarSalida(e, spx, cot, cfg);
  console.log(`[${horaET()}] ${e.estructura.tipo}${e.estructura.sentido ? ' ' + e.estructura.sentido : ''} — ${r.detalle}`);

  if (r.cerrar) {
    await cerrar(tradier, e, r.cerrar, r.detalle, spx);
    guardar(REGISTRO, reg);
    return false;
  }

  // Cierre forzado por hora, si esta configurado.
  const cf = cfg.cierreForzadoET;
  if (cf) {
    const [h, m] = String(cf).split(':').map(Number);
    if (horaDecET() >= h + (m || 0) / 60) {
      await cerrar(tradier, e, 'HORA', `cierre forzado a las ${cf} ET`, spx);
      guardar(REGISTRO, reg);
      return false;
    }
  }
  return true;
}

(async () => {
  const cfg = (leerJSON(CFG_PATH, {}).trading || {}).premercado || {};
  const tradier = new TradierClient({
    accessToken: process.env.TRADIER_ACCESS_TOKEN,
    accountNumber: process.env.TRADIER_ACCOUNT_NUMBER,
    baseUrl: process.env.TRADIER_BASE_URL,
  });

  if (!LOOP) { await pasada(tradier, cfg); return; }

  const cada = (cfg.monitorIntervaloSeg || 60) * 1000;
  console.log(`[monitor] vigilando cada ${cada / 1000}s hasta las 16:00 ET`);
  while (horaDecET() < 16.0) {
    let sigue = true;
    try { sigue = await pasada(tradier, cfg); }
    catch (e) { console.error('[monitor]', e.message); }
    if (!sigue) { console.log('[monitor] nada mas que vigilar, saliendo'); break; }
    await dormir(cada);
  }
  console.log('[monitor] fin');
})().catch(e => { console.error('[FALLO]', e.message); process.exit(1); });
