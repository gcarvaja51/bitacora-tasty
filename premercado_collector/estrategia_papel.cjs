/**
 * ESTRATEGIA PREMERCADO -- MODO PAPEL
 * ===================================
 *
 * Corre el pipeline completo (decision + seleccion de strikes) con datos y
 * precios REALES, pero NO manda nada al broker: escribe la operacion en un
 * registro y despues del cierre la liquida contra el cierre real del SPX.
 *
 * Es el paso obligatorio antes de encender `tradierAutoExecute`. Hoy la
 * estrategia no tiene ni una sola observacion; encenderla ahora seria operar a
 * ciegas. Con este modo se acumula muestra sin arriesgar un peso, y con los
 * mismos precios que habria pagado de verdad (bid/ask de la cadena, no marks).
 *
 * Uso:
 *   node estrategia_papel.cjs decidir     # en la ventana 10:00-11:00 ET
 *   node estrategia_papel.cjs liquidar    # despues del cierre
 *   node estrategia_papel.cjs resumen     # como va la muestra
 *
 * SPX es europeo y liquida en efectivo, asi que para liquidar basta el cierre:
 * no hace falta seguir la posicion intradia ni simular stops. Eso hace que el
 * registro en papel sea fiel y no una aproximacion.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { decidir, validarEscenarios } = require('../src/estrategia_premercado.js');
const { seleccionarStrikes } = require('../src/premercado_strikes.js');

const BASE = path.join('C:', 'Users', 'gcarv', 'Documents', 'CARPETA PERSONAL',
  '01. guillermo carvajal', '01_Sigma', 'mentoria alejandro',
  'premercados alejandro', 'control premercado');
const LOG_PREMERCADO = path.join(BASE, 'premercado_hipotesis_log.json');
const DIR_CADENAS = path.join(BASE, 'neutrales', 'cadenas');
const REGISTRO = path.join(BASE, 'estrategia_premercado_papel.json');
const CFG_PATH = path.join(__dirname, '..', 'spx_config.json');

const fmtET = (o) => new Intl.DateTimeFormat('en-GB',
  { timeZone: 'America/New_York', hour12: false, ...o }).format(new Date());
const hoyET = () => new Intl.DateTimeFormat('en-CA',
  { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date());
const horaDecimalET = () => {
  const [h, m] = fmtET({ hour: '2-digit', minute: '2-digit' }).split(':').map(Number);
  return h + m / 60;
};

const leerJSON = (p, def) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return def; }
};
const guardar = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 1));

/** Velas de 15m de hoy desde Yahoo. Solo se marcan como cerradas las completas. */
async function velas15m() {
  const r = await fetch(
    'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=15m&range=1d',
    { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await r.json();
  const res = j.chart?.result?.[0];
  const ts = res?.timestamp || [];
  const q = res?.indicators?.quote?.[0] || {};
  const ahora = Date.now() / 1000;
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null) continue;
    const et = new Intl.DateTimeFormat('en-GB',
      { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false })
      .format(new Date(ts[i] * 1000));
    // Una vela de 15m esta cerrada cuando ya pasaron sus 900 segundos. Sin esta
    // comprobacion se decidiria con la vela en curso, que es exactamente la
    // "mecha" que la estrategia quiere evitar.
    out.push({ t: et, close: q.close[i], cerrada: (ahora - ts[i]) >= 900 });
  }
  return { velas: out, precio: res?.meta?.regularMarketPrice ?? null };
}

/** Niveles de gamma del daemon (mismo archivo que usa el premercado). */
function gammaVivo() {
  const st = leerJSON(path.join(__dirname, '..', 'gamma_daemon', 'status.json'), null);
  return st?.lastLevels || {};
}

/** Cadena 0DTE: reusa la captura mas reciente de hoy, o lanza una nueva. */
function cadenaDeHoy(maxEdadMin = 10) {
  const hoy = hoyET();
  const tag = hoy.replace(/-/g, '');
  let mejor = null;
  try {
    for (const f of fs.readdirSync(DIR_CADENAS)) {
      if (!f.startsWith(`spx_0dte_${tag}`)) continue;
      const p = path.join(DIR_CADENAS, f);
      const st = fs.statSync(p);
      if (!mejor || st.mtimeMs > mejor.mtimeMs) mejor = { p, mtimeMs: st.mtimeMs };
    }
  } catch (e) { /* carpeta aun no existe */ }

  const edadMin = mejor ? (Date.now() - mejor.mtimeMs) / 60000 : Infinity;
  if (!mejor || edadMin > maxEdadMin) {
    console.log(`[cadena] ${mejor ? `la ultima tiene ${edadMin.toFixed(0)} min` : 'no hay captura de hoy'}; capturando...`);
    execFileSync(process.execPath, [path.join(__dirname, 'capturar_cadena_0dte.cjs')],
      { stdio: 'inherit' });
    return cadenaDeHoy(999);
  }
  console.log(`[cadena] usando ${path.basename(mejor.p)} (${edadMin.toFixed(1)} min)`);
  const snap = leerJSON(mejor.p, null);
  return snap && {
    expiry: snap.expiry, spot: snap.spot, horaET: snap.horaET,
    strikes: snap.filas.map(f => ({ strike: f.strike, call: f.call, put: f.put })),
  };
}

async function cmdDecidir() {
  const hoy = hoyET();
  const reg = leerJSON(REGISTRO, []);
  if (reg.some(r => r.fecha === hoy)) {
    console.log(`[skip] ya hay una entrada de papel para ${hoy}. Un trade por dia.`);
    return;
  }

  const pre = (leerJSON(LOG_PREMERCADO, []) || []).find(e => e.fecha === hoy);
  if (!pre) { console.log(`[FALLO] no hay premercado para ${hoy}`); process.exit(2); }
  const v = validarEscenarios(pre);
  if (!v.ok) {
    console.log('[FALLO] los escenarios de hoy no validan:');
    v.errores.forEach(e => console.log('   ', e));
    process.exit(2);
  }

  const cfg = (leerJSON(CFG_PATH, {}).trading || {}).premercado || {};
  const { velas, precio } = await velas15m();
  const g = gammaVivo();
  const mercado = {
    horaET: horaDecimalET(), precio,
    velas15m: velas, gamma: g, yaOperadoHoy: false,
  };

  console.log(`[estado] ${hoy} ${fmtET({ hour: '2-digit', minute: '2-digit' })} ET  ` +
              `SPX ${precio}  velas cerradas ${velas.filter(x => x.cerrada).length}  ` +
              `gamma ${g.regime || '?'}`);

  const dec = decidir(pre, mercado, cfg);
  const entrada = {
    fecha: hoy, horaET: fmtET({ hour: '2-digit', minute: '2-digit' }),
    spot: precio, stage: dec.stage, operar: !!dec.operar,
    direccion: dec.direccion || null, escenario: dec.escenario?.nombre || null,
    reason: dec.reason, motivos: dec.motivos || [],
    gamma: { regime: g.regime, gammaFlip: g.gammaFlip, callWall: g.callWall,
             putWall: g.putWall, maxPain: g.maxPain },
    estructura: null, resultado: null,
  };

  if (!dec.operar) {
    console.log(`[decision] SIN TRADE -- ${dec.stage}: ${dec.reason}`);
  } else {
    const exp = cadenaDeHoy();
    if (!exp) { console.log('[FALLO] sin cadena'); process.exit(2); }
    const sel = seleccionarStrikes(dec, exp, precio, cfg.strikes || {});
    if (!sel.ok) {
      entrada.operar = false;
      entrada.stage = 'STRIKES_RECHAZADOS';
      entrada.reason = sel.motivo;
      console.log(`[decision] ${dec.direccion} pero el selector RECHAZO: ${sel.motivo}`);
    } else {
      entrada.estructura = sel;
      console.log(`[decision] ${dec.direccion} -> ${sel.tipo}${sel.sentido ? ' ' + sel.sentido : ''}`);
      console.log(`           ${sel.razon}`);
      console.log(`           limite ${sel.limite}  maxGan ${sel.maxGanancia}  ` +
                  `maxPerd ${sel.maxPerdida}  R:R 1:${sel.rr}`);
    }
  }

  reg.push(entrada);
  reg.sort((a, b) => a.fecha.localeCompare(b.fecha));
  guardar(REGISTRO, reg);
  console.log(`[papel] registrado en ${REGISTRO}`);
}

/** P&L al vencimiento de la estructura contra el cierre real. */
function liquidarEstructura(e, cierre) {
  if (e.tipo === 'DEBIT_VERTICAL') {
    const esCall = e.sentido === 'CALL';
    const intr = (k) => esCall ? Math.max(cierre - k, 0) : Math.max(k - cierre, 0);
    const valor = intr(e.largaStrike) - intr(e.cortaStrike);
    return +(valor - e.debito).toFixed(2);
  }
  if (e.tipo === 'IRON_CONDOR') {
    const p = (k) => Math.max(k - cierre, 0);
    const c = (k) => Math.max(cierre - k, 0);
    const valor = -p(e.putCortoStrike) + p(e.putLargoStrike)
                  - c(e.callCortoStrike) + c(e.callLargoStrike);
    return +(e.credito + valor).toFixed(2);
  }
  return null;
}

async function cmdLiquidar() {
  const reg = leerJSON(REGISTRO, []);
  const pend = reg.filter(r => r.operar && r.estructura && !r.resultado);
  if (!pend.length) { console.log('[liquidar] nada pendiente'); return; }

  const r = await fetch(
    'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=1mo',
    { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await r.json();
  const res = j.chart?.result?.[0];
  const cierres = {};
  (res?.timestamp || []).forEach((t, i) => {
    const d = new Intl.DateTimeFormat('en-CA',
      { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(t * 1000));
    const c = res.indicators.quote[0].close[i];
    if (c != null) cierres[d] = c;
  });

  for (const e of pend) {
    const cierre = cierres[e.fecha];
    if (cierre == null) { console.log(`  ${e.fecha}: aun sin cierre`); continue; }
    const pnl = liquidarEstructura(e.estructura, cierre);
    e.resultado = { cierre_real: +cierre.toFixed(2), pnl_pts: pnl, gano: pnl > 0 };
    console.log(`  ${e.fecha}: cierre ${cierre.toFixed(2)}  P&L ${pnl > 0 ? '+' : ''}${pnl} pts  ` +
                `${pnl > 0 ? 'GANA' : 'pierde'}`);
  }
  guardar(REGISTRO, reg);
}

function cmdResumen() {
  const reg = leerJSON(REGISTRO, []);
  if (!reg.length) { console.log('registro vacio'); return; }
  const conTrade = reg.filter(r => r.operar && r.estructura);
  const liq = conTrade.filter(r => r.resultado);
  console.log(`ESTRATEGIA PREMERCADO -- muestra en papel`);
  console.log(`  dias registrados : ${reg.length}`);
  console.log(`  con trade        : ${conTrade.length}  (${reg.length - conTrade.length} sin operar)`);
  console.log(`  liquidados       : ${liq.length}`);
  if (!liq.length) { console.log('\n  todavia sin resultados'); return; }
  const p = liq.map(r => r.resultado.pnl_pts);
  const g = p.filter(x => x > 0).length;
  const tot = p.reduce((a, b) => a + b, 0);
  console.log(`\n  P&L total  : ${tot > 0 ? '+' : ''}${tot.toFixed(2)} pts`);
  console.log(`  P&L medio  : ${(tot / p.length > 0 ? '+' : '')}${(tot / p.length).toFixed(2)} pts`);
  console.log(`  aciertos   : ${g}/${p.length} (${(100 * g / p.length).toFixed(0)}%)`);
  console.log(`  mejor/peor : +${Math.max(...p).toFixed(2)} / ${Math.min(...p).toFixed(2)}`);
  console.log('\n  fecha        dir        estructura              P&L');
  for (const r of liq) {
    const e = r.estructura;
    const et = e.tipo === 'DEBIT_VERTICAL'
      ? `${e.sentido} ${e.largaStrike}/${e.cortaStrike}`
      : `IC ${e.putCortoStrike}/${e.callCortoStrike}`;
    console.log(`  ${r.fecha}  ${(r.direccion || '').padEnd(9)} ${et.padEnd(22)} ` +
                `${r.resultado.pnl_pts > 0 ? '+' : ''}${r.resultado.pnl_pts}`);
  }
  console.log(`\n  Nota: ${conTrade.length} trades es muestra insuficiente para decidir nada. ` +
              `No encender la ejecucion real hasta tener al menos 20-30 observaciones.`);
}

const cmd = process.argv[2];
const rutas = { decidir: cmdDecidir, liquidar: cmdLiquidar, resumen: cmdResumen };
if (!rutas[cmd]) {
  console.log('uso: node estrategia_papel.cjs <decidir|liquidar|resumen>');
  process.exit(1);
}
Promise.resolve(rutas[cmd]()).catch(e => { console.error('[FALLO]', e.message); process.exit(1); });
