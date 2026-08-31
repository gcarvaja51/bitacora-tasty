/**
 * ESTRATEGIA PREMERCADO -- corrida diaria (papel + ejecucion en Tradier)
 * =====================================================================
 *
 * Una sola pasada que hace las dos cosas:
 *   1. SIEMPRE deja el registro en papel (decision, strikes, precios reales).
 *   2. Si `trading.premercado.tradierAutoExecute` esta en true, ademas manda la
 *      orden a Tradier.
 *
 * Que el papel se escriba SIEMPRE, tambien cuando se ejecuta, es deliberado:
 * asi la muestra para analizar no depende de que la ejecucion funcione, y se
 * puede comparar lo que la estrategia QUISO hacer contra lo que el broker
 * realmente lleno. Si algun dia divergen, la diferencia esta registrada.
 *
 * Tradier es la cuenta SANDBOX/DEMO (ver CLAUDE.md). Aqui no se arriesga dinero
 * real -- la cuenta real es Tastytrade y este archivo no la toca.
 *
 * Uso:
 *   node estrategia_ejecutar.cjs            # corrida normal
 *   node estrategia_ejecutar.cjs --dry      # decide y registra, nunca ejecuta
 *
 * Pensado para dispararse una vez al dia dentro de la ventana 10:00-11:00 ET.
 * Fuera de esa ventana el propio motor devuelve FUERA_DE_VENTANA y no hace nada.
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { decidir, validarEscenarios } = require('../src/estrategia_premercado.js');
const { seleccionarStrikes } = require('../src/premercado_strikes.js');
const senalesH = require('../src/senales_horizontal.js');
const { TradierClient } = require('../src/tradier.js');

const BASE = path.join('C:', 'Users', 'gcarv', 'Documents', 'CARPETA PERSONAL',
  '01. guillermo carvajal', '01_Sigma', 'mentoria alejandro',
  'premercados alejandro', 'control premercado');
const LOG_PREMERCADO = path.join(BASE, 'premercado_hipotesis_log.json');
const DIR_CADENAS = path.join(BASE, 'neutrales', 'cadenas');
const REGISTRO = path.join(BASE, 'estrategia_premercado_papel.json');
const RAIZ = path.join(__dirname, '..');
const CFG_PATH = path.join(RAIZ, 'spx_config.json');
const STRATEGY_LOG = path.join(RAIZ, 'spx_strategy_log.json');

const DRY = process.argv.includes('--dry');

const leerJSON = (p, def) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return def; } };
const guardar = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 1));
const hoyET = () => new Intl.DateTimeFormat('en-CA',
  { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const horaET = () => new Intl.DateTimeFormat('en-GB',
  { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
const horaDecET = () => { const [h, m] = horaET().split(':').map(Number); return h + m / 60; };

/** Escribe en el MISMO log que usan TENDENCIA/REVERSION/NEUTRAL. */
function logEstrategia(entry) {
  try {
    const log = leerJSON(STRATEGY_LOG, []);
    log.unshift({ timestamp: new Date().toISOString(), strategyFamily: 'PREMERCADO', ...entry });
    guardar(STRATEGY_LOG, log.slice(0, 5000));
  } catch (e) { console.error('[log]', e.message); }
}

/**
 * Guarda la entrada del dia SIN duplicar.
 * La Tarea Programada dispara dos veces (una por temporada de horario de
 * verano) y solo una cae dentro de la ventana ET; la otra devuelve
 * FUERA_DE_VENTANA. Sin esto quedarian dos filas por dia y la muestra saldria
 * inflada con dias que en realidad son uno. Gana siempre la entrada que SI
 * decidio algo.
 */
function registrar(reg, entrada) {
  const i = reg.findIndex(r => r.fecha === entrada.fecha);
  if (i === -1) reg.push(entrada);
  else if (!reg[i].operar) reg[i] = entrada;      // la nueva manda si la vieja no opero
  else return guardar(REGISTRO, reg);             // ya habia trade: no se pisa
  reg.sort((a, b) => a.fecha.localeCompare(b.fecha));
  guardar(REGISTRO, reg);
}

async function velas15m() {
  const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=15m&range=1d',
    { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await r.json();
  const res = j.chart?.result?.[0];
  const ts = res?.timestamp || [], q = res?.indicators?.quote?.[0] || {};
  const ahora = Date.now() / 1000, out = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null) continue;
    const et = new Intl.DateTimeFormat('en-GB',
      { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false })
      .format(new Date(ts[i] * 1000));
    out.push({ t: et, close: q.close[i], cerrada: (ahora - ts[i]) >= 900 });
  }
  return { velas: out, precio: res?.meta?.regularMarketPrice ?? null };
}

/**
 * Cierres de 15m de las ULTIMAS SESIONES, solo velas ya cerradas.
 *
 * Vive aparte de velas15m() a proposito (2026-08-26). Las señales de mercado
 * horizontal piden 50 velas de 15m y se calibraron tomando la señal a las 10:30
 * ET sobre 58 sesiones: o sea, sobre una serie CONTINUA multi-sesion.
 * Alimentarlas con `range=1d` era imposible de satisfacer -- una sesion RTH
 * entera tiene 26 velas de 15m y a las 10:30 hay 4 -- asi que `evaluar()`
 * devolvia siempre "sin velas suficientes", `decidir()` lo leia como "no es
 * horizontal", y la pata NEUTRAL quedaba bloqueada TODOS los dias, sin
 * excepcion. No fallaba a veces: no podia dispararse nunca.
 * Encontrado el 26-ago corriendo el motor en seco: paso el escenario, paso el
 * gamma, paso la distancia al pin, y murio en NEUTRAL_NO_HORIZONTAL con 5 velas.
 *
 * Las dos series NO se pueden unificar: velas15m() alimenta la evaluacion de los
 * escenarios (dentro_corredor, cierre_15m_sobre/bajo), y meter ahi velas de
 * sesiones anteriores haria que el motor validara roturas de AYER como si
 * fueran de hoy.
 *
 * Misma construccion que `vigilante_gex.cjs`, que ya consumia esta señal bien.
 */
async function cierres15mHistorico() {
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
  return out;
}

function cadenaDeHoy(maxEdadMin = 10) {
  const tag = hoyET().replace(/-/g, '');
  let mejor = null;
  try {
    for (const f of fs.readdirSync(DIR_CADENAS)) {
      if (!f.startsWith(`spx_0dte_${tag}`)) continue;
      const p = path.join(DIR_CADENAS, f), st = fs.statSync(p);
      if (!mejor || st.mtimeMs > mejor.mtimeMs) mejor = { p, mtimeMs: st.mtimeMs };
    }
  } catch (e) { /* aun no existe */ }
  const edad = mejor ? (Date.now() - mejor.mtimeMs) / 60000 : Infinity;
  if (!mejor || edad > maxEdadMin) {
    console.log('[cadena] capturando cadena fresca...');
    execFileSync(process.execPath, [path.join(__dirname, 'capturar_cadena_0dte.cjs')], { stdio: 'inherit' });
    return cadenaDeHoy(999);
  }
  console.log(`[cadena] ${path.basename(mejor.p)} (${edad.toFixed(1)} min)`);
  const s = leerJSON(mejor.p, null);
  return s && { expiry: s.expiry, spot: s.spot, horaET: s.horaET,
                strikes: s.filas.map(f => ({ strike: f.strike, call: f.call, put: f.put })) };
}

/** Nombre de estrategia que entiende placeSpreadOrder. */
function nombreVertical(sel) {
  // Ambas son de DEBITO: se paga por entrar.
  //   CALL: compra la baja, vende la alta  -> BULL_CALL_SPREAD
  //   PUT : compra la alta, vende la baja  -> BEAR_PUT_SPREAD
  return sel.sentido === 'CALL' ? 'BULL_CALL_SPREAD' : 'BEAR_PUT_SPREAD';
}

async function main() {
  const hoy = hoyET(), hora = horaET();
  const cfg = (leerJSON(CFG_PATH, {}).trading || {}).premercado || {};
  const autoExec = cfg.tradierAutoExecute === true && !DRY;
  const qty = cfg.contratos || 1;

  console.log(`=== ESTRATEGIA PREMERCADO — ${hoy} ${hora} ET ===`);
  console.log(`    ejecucion: ${DRY ? 'DRY-RUN (forzado por --dry)' : autoExec ? 'TRADIER (sandbox)' : 'SOLO PAPEL (interruptor apagado)'}`);

  const reg = leerJSON(REGISTRO, []);
  const yaHoy = reg.find(r => r.fecha === hoy && r.operar);
  if (yaHoy) {
    console.log('[skip] ya hay un trade de PREMERCADO hoy. Uno por dia.');
    return;
  }

  const pre = (leerJSON(LOG_PREMERCADO, []) || []).find(e => e.fecha === hoy);
  if (!pre) {
    console.log(`[FALLO] no hay premercado para ${hoy}`);
    logEstrategia({ stage: 'SIN_PREMERCADO', passed: false, etTime: hora,
                    reason: `No hay entrada de premercado para ${hoy}` });
    process.exit(2);
  }
  const v = validarEscenarios(pre);
  if (!v.ok) {
    console.log('[FALLO] escenarios invalidos:'); v.errores.forEach(e => console.log('   ', e));
    logEstrategia({ stage: 'ESCENARIOS_INVALIDOS', passed: false, etTime: hora,
                    reason: v.errores.join(' | ') });
    process.exit(2);
  }

  const { velas, precio } = await velas15m();
  const gamma = (leerJSON(path.join(RAIZ, 'gamma_daemon', 'status.json'), {}).lastLevels) || {};
  const cerradas = velas.filter(x => x.cerrada).length;
  // Señales de mercado horizontal: solo con velas CERRADAS, para no medir sobre
  // una vela en curso que todavia puede cambiar de forma, y sobre el historial
  // de varias sesiones (ver cierres15mHistorico: con las velas de hoy solas la
  // señal nunca alcanzaba las 50 que necesita).
  const cierresHist = await cierres15mHistorico();
  const sh = senalesH.evaluar(cierresHist, (cfg.neutral || {}));
  console.log(`[estado] SPX ${precio}   velas 15m cerradas ${cerradas}   gamma ${gamma.regime || '?'}`);
  console.log(`[señales] ${sh.ok ? 'HORIZONTAL' : 'NO horizontal'} — ${sh.motivo}`);

  const dec = decidir(pre, { horaET: horaDecET(), precio, velas15m: velas,
                             gamma, senalesHorizontal: sh, yaOperadoHoy: false }, cfg);

  const snapshot = { spxPrice: precio, velas15mCerradas: cerradas,
                     gex: { regime: gamma.regime, callWall: gamma.callWall,
                            putWall: gamma.putWall, gammaFlip: gamma.gammaFlip,
                            maxPain: gamma.maxPain },
                     escenario: dec.escenario?.nombre || null };

  const entrada = { fecha: hoy, horaET: hora, spot: precio, stage: dec.stage,
                    operar: !!dec.operar, direccion: dec.direccion || null,
                    escenario: dec.escenario?.nombre || null, reason: dec.reason,
                    motivos: dec.motivos || [], gamma: snapshot.gex,
                    estructura: null, ejecucion: null, resultado: null };

  if (!dec.operar) {
    console.log(`[decision] SIN TRADE — ${dec.stage}: ${dec.reason}`);
    logEstrategia({ stage: dec.stage, passed: false, etTime: hora, reason: dec.reason, snapshot });
    registrar(reg, entrada);
    return;
  }

  const exp = cadenaDeHoy();
  if (!exp) {
    logEstrategia({ stage: 'SIN_CADENA', passed: false, etTime: hora, reason: 'cadena no disponible', snapshot });
    console.log('[FALLO] sin cadena'); process.exit(2);
  }

  const sel = seleccionarStrikes(dec, exp, precio, cfg.strikes || {});
  if (!sel.ok) {
    console.log(`[decision] ${dec.direccion}, pero el selector RECHAZO: ${sel.motivo}`);
    entrada.operar = false; entrada.stage = 'STRIKES_RECHAZADOS'; entrada.reason = sel.motivo;
    logEstrategia({ stage: 'STRIKES_RECHAZADOS', passed: false, etTime: hora,
                    reason: sel.motivo, snapshot });
    registrar(reg, entrada);
    return;
  }

  entrada.estructura = sel;
  console.log(`[decision] ${dec.direccion} -> ${sel.tipo}${sel.sentido ? ' ' + sel.sentido : ''}`);
  console.log(`           ${sel.razon}`);
  console.log(`           limite ${sel.limite}   maxGan ${sel.maxGanancia}   maxPerd ${sel.maxPerdida}   R:R 1:${sel.rr}`);

  if (!autoExec) {
    console.log('[papel] registrado sin ejecutar.');
    logEstrategia({ stage: 'DECISION_PAPEL', passed: true, etTime: hora,
                    reason: sel.razon, snapshot: { ...snapshot, estructura: sel } });
    registrar(reg, entrada);
    return;
  }

  // ---- Ejecucion en Tradier (sandbox) ----
  const tradier = new TradierClient({
    accessToken: process.env.TRADIER_ACCESS_TOKEN,
    accountNumber: process.env.TRADIER_ACCOUNT_NUMBER,
    baseUrl: process.env.TRADIER_BASE_URL,
  });
  try {
    let order;
    if (sel.tipo === 'DEBIT_VERTICAL') {
      order = await tradier.placeSpreadOrder({
        strategy: nombreVertical(sel),
        underlyingRoot: 'SPXW',
        expiry: sel.expiry,
        shortStrike: sel.cortaStrike,
        longStrike: sel.largaStrike,
        quantity: qty,
        netLimitPrice: sel.limite,
      });
    } else {
      order = await tradier.placeIronCondorOrder({
        underlyingRoot: 'SPXW',
        expiry: sel.expiry,
        putShortStrike: sel.putCortoStrike, putLongStrike: sel.putLargoStrike,
        callShortStrike: sel.callCortoStrike, callLongStrike: sel.callLargoStrike,
        quantity: qty,
        minCreditPrice: sel.limite,
      });
    }
    entrada.ejecucion = { orderId: order.orderId, status: order.status,
                          legs: order.legs, contratos: qty,
                          enviadaEn: new Date().toISOString() };
    console.log(`[Tradier] orden enviada: ${order.orderId} (${order.status})`);
    logEstrategia({ stage: 'EXECUTED', passed: true, etTime: hora,
                    reason: `${sel.tipo} enviado a Tradier: ${order.orderId}`,
                    snapshot: { ...snapshot, estructura: sel, orderId: order.orderId } });
  } catch (e) {
    entrada.ejecucion = { error: e.message, enviadaEn: new Date().toISOString() };
    console.error(`[Tradier] FALLO al enviar: ${e.message}`);
    logEstrategia({ stage: 'EXEC_FALLO', passed: false, etTime: hora,
                    reason: e.message, snapshot: { ...snapshot, estructura: sel } });
  }

  registrar(reg, entrada);
  console.log(`[papel] registrado en ${REGISTRO}`);
}

main().catch(e => { console.error('[FALLO]', e.message); process.exit(1); });
