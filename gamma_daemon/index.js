// Reemplaza a run_gamma_refresh.ps1 (que invocaba un agente de Claude nuevo, en frio,
// cada 2 min). Este es un proceso de vida larga: mantiene su propio estado entre ciclos
// (contador de fallos consecutivos, modo degradado), y solo usa codigo determinista --
// ningun LLM en el loop caliente. Ver notas de diseño en CLAUDE.md / conversacion del
// 2026-07-30.
import * as sigma from './sigma.js';
import * as tv from './tv.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATUS_PATH = path.join(__dirname, 'status.json');
const HISTORY_PATH = path.join(__dirname, 'history.json');
// Con el ciclo en 30s hacen falta ~12 entradas para cubrir los 6 min que mira
// la tabla del indicador; 60 deja ~30 min de margen.
const HISTORY_CAP = 60;
const LOOKBACK_MS = 6 * 60 * 1000;   // "hace ~6 min" de la tabla de GEX/DEX/Vanna

const PROD_BASE = 'https://web-production-23473.up.railway.app';
const NTFY_TOPIC = 'bitacora_gcarvaja51'; // mismo topic que ya usa server.js

// Ciclo de PRECIO: 30s desde el 2026-08-08. Antes eran 2 min, y esa cadencia
// era la unica fuente de atraso que le quedaba al sistema una vez que Sigma paso
// a ser la fuente por defecto del spot — el dato de Sigma cambia en el 99% de
// las lecturas, o sea que se actualiza mas rapido de lo que se le preguntaba.
// Medido sobre el 07-ago: con ciclo de 2 min el precio llegaba con ~60s de
// antiguedad tipica y ~0.63 pts de desvio; a 30s eso baja a ~15s y ~0.16 pts.
// Un ciclo cuesta ~3s (la pagina de Sigma se mantiene abierta, solo se lee el
// DOM), asi que 30s es holgado.
const CYCLE_MS_NORMAL = 30 * 1000;
const CYCLE_MS_DEGRADED = 2 * 60 * 1000;   // al degradarse vuelve a la cadencia vieja

// El push a TradingView NO sigue el ciclo de precio: se queda en 2 min. Si el
// push falla, pushToTradingViewWithRetry MATA Y RELANZA TradingView — a 30s eso
// cuadruplicaria los relanzamientos, y dejar al usuario sin poder operar es
// justo el incidente que este daemon ya provoco el 2026-08-06. El grafico es
// una ayuda visual; el que decide es el servidor.
const TV_PUSH_EVERY_MS = 2 * 60 * 1000;
const FAILURE_THRESHOLD = 3;

let consecutiveFailures = 0;   // fallos que dejan al SERVIDOR sin precio (Sigma o POST)
let tvFailures = 0;            // fallos del push a TradingView — solo afectan al grafico
let tvAlerted = false;
let lastTvPushAt = 0;
let alerted = false;
let mode = 'normal';
let stopped = false;

function loadStatus() {
  try {
    return existsSync(STATUS_PATH) ? JSON.parse(readFileSync(STATUS_PATH, 'utf8')) : {};
  } catch {
    return {};
  }
}

function saveStatus(patch) {
  const current = loadStatus();
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  writeFileSync(STATUS_PATH, JSON.stringify(next, null, 2));
}

function loadHistory() {
  try {
    return existsSync(HISTORY_PATH) ? JSON.parse(readFileSync(HISTORY_PATH, 'utf8')) : [];
  } catch {
    return [];
  }
}

// Guarda la lectura actual al FRENTE del historial (mas reciente primero) y devuelve
// el valor "de hace 3 ciclos" (~6 min, ya que el ciclo normal es cada 2 min) para
// GEX/DEX/Vanna -- posicional, no por timestamp real, tal como pidio el usuario
// ("puede ser el reporte de 3 periodos antes"). Si todavia no hay 3 lecturas previas
// (recien arranco el daemon, o hubo fallos en el medio), usa la mas vieja disponible
// en vez de fallar -- mejor una comparacion con menos de 6 min de separacion que
// ninguna comparacion.
function recordAndGetPrevious(levels) {
  const history = loadHistory();
  // Antes era history[2] — "3 ciclos atras", que con el ciclo de 2 min daban
  // los ~6 min que rotula la tabla del indicador. Con el ciclo en 30s esa
  // cuenta posicional pasaria a ser 90s y la tabla mentiria. Ahora se busca por
  // TIEMPO: la lectura mas reciente con al menos LOOKBACK_MS de antiguedad, y
  // si el historial no llega tan atras, la mas vieja que haya.
  const corte = Date.now() - LOOKBACK_MS;
  const prevEntry = history.find(h => h.ts && new Date(h.ts).getTime() <= corte)
    || history[history.length - 1] || null;

  const updated = [{ ts: new Date().toISOString(), netGex: levels.netGex, netDex: levels.netDex, netVanna: levels.netVanna }, ...history].slice(0, HISTORY_CAP);
  writeFileSync(HISTORY_PATH, JSON.stringify(updated, null, 2));

  return {
    netGex: prevEntry ? prevEntry.netGex : levels.netGex,
    netDex: prevEntry ? prevEntry.netDex : levels.netDex,
    netVanna: prevEntry ? prevEntry.netVanna : levels.netVanna,
  };
}

// Guard de horario duro -- calcula la hora ET real (con DST), mismo criterio que
// run_gamma_refresh.ps1 y el resto del sistema. Ventana: 09:00-16:05 ET, lunes-viernes.
function isMarketWindow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date());

  const get = (type) => parts.find((p) => p.type === type)?.value;
  const weekday = get('weekday');
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  const totalMinutes = hour * 60 + minute;

  const isWeekday = !['Sat', 'Sun'].includes(weekday);
  return isWeekday && totalMinutes >= 9 * 60 && totalMinutes <= 16 * 60 + 5;
}

async function ntfy(message, { priority = 'default', title } = {}) {
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: {
        ...(title ? { Title: title } : {}),
        Priority: priority,
      },
      body: message,
    });
  } catch (e) {
    console.error('[ntfy] error enviando alerta:', e.message);
  }
}

async function postSigmaLevels(levels) {
  const resp = await fetch(`${PROD_BASE}/api/spx/sigma-levels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(levels),
  });
  if (!resp.ok) throw new Error(`POST /api/spx/sigma-levels devolvio ${resp.status}`);
  return resp.json();
}

async function pushToTradingViewWithRetry(inputs) {
  try {
    return await tv.pushGammaLevelsToAllWindows(inputs);
  } catch (e) {
    console.warn('[tv] fallo el push, intentando relanzar TradingView:', e.message);
    await tv.launch({ killExisting: true });
    await new Promise((r) => setTimeout(r, 15000)); // dar tiempo a que cargue el chart
    return tv.pushGammaLevelsToAllWindows(inputs);
  }
}

async function runCycle() {
  if (!isMarketWindow()) {
    saveStatus({ lastSkipReason: 'fuera_de_horario', lastCycleAt: new Date().toISOString() });
    return;
  }

  try {
    const levels = await sigma.readLevels();
    const prev = recordAndGetPrevious(levels);

    // Velas de 5m del SPX, de la misma fuente que el gamma (2026-08-09). Van
    // adjuntas al mismo push para que el servidor decida el alejamiento con la
    // misma serie con la que Sigma dibuja su grafico, en vez de reconstruirla a
    // partir de las lecturas de spot (que no existen en la primera hora).
    // Deliberadamente best-effort y en su propio try: si la API de velas falla,
    // el push de NIVELES —que es lo critico— tiene que salir igual.
    try {
      const velas = await sigma.readCandles5m();
      if (velas?.length) levels.velas5m = velas;
    } catch (e) {
      console.error('[sigma] velas 5m no disponibles (%s) -- se sigue sin ellas', e.message);
    }

    // Velas de 2m: las usa el PIN del Iron Condor (15 velas) y el gatillo de
    // pullback del direccional, que exige 35 barras. Se piden 60 para cubrir a
    // los dos con margen para el chequeo de continuidad.
    try {
      const velas2 = await sigma.readCandles5m({ velas: 60, diasAtras: 3, minutos: 2 });
      if (velas2?.length) levels.velas2m = velas2;
    } catch (e) {
      console.error('[sigma] velas 2m no disponibles (%s) -- se sigue sin ellas', e.message);
    }

    // Velas de 15m: el marco maestro del direccional. calcFase15mSimple exige 21
    // cierres para decidir Fase 2 / Fase 4; se piden 40 con margen.
    try {
      const velas15 = await sigma.readCandles5m({ velas: 40, diasAtras: 12, minutos: 15 });
      if (velas15?.length) levels.velas15m = velas15;
    } catch (e) {
      console.error('[sigma] velas 15m no disponibles (%s) -- se sigue sin ellas', e.message);
    }

    // VIX y su rango de 52 semanas, mismo criterio best-effort.
    try {
      const v = await sigma.readVix();
      if (v?.vix != null) {
        levels.vix = v.vix;
        if (v.vix52High != null) { levels.vix52High = v.vix52High; levels.vix52Low = v.vix52Low; }
      }
    } catch (e) {
      console.error('[sigma] VIX no disponible (%s) -- se sigue sin el', e.message);
    }

    // EL SERVIDOR VA PRIMERO. Antes el POST estaba DESPUES del push a
    // TradingView, y un push fallido lanzaba excepcion antes de llegar aca: con
    // TradingView cerrado o sin SPX cargado, el servidor se quedaba sin precio
    // aunque Sigma se hubiera leido perfecto. Mientras Sigma era solo una
    // referencia de muros eso era molesto; desde que es la fuente por defecto
    // del spot, un problema del GRAFICO dejaria ciego al sistema que OPERA.
    await postSigmaLevels(levels);

    const wasDegraded = mode === 'degraded';
    consecutiveFailures = 0;
    mode = 'normal';
    saveStatus({
      lastCycleAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(),
      consecutiveFailures: 0,
      mode: 'normal',
      lastLevels: levels,
    });

    if (wasDegraded && alerted) {
      await ntfy('El daemon de Gamma se recupero y volvio a empujar valores con normalidad.', {
        title: 'Gamma daemon: recuperado',
      });
      alerted = false;
    }

    // TradingView, en su propia cadencia (2 min) y en su propio try: aunque
    // falle, el precio ya se entrego. Un problema del grafico no puede volver a
    // dejar sin dato al servidor.
    if (Date.now() - lastTvPushAt >= TV_PUSH_EVERY_MS) {
      lastTvPushAt = Date.now();
      try {
        const tvWindows = await pushToTradingViewWithRetry({
          in_20: true,
          in_21: levels.callWall,
          in_22: levels.putWall,
          in_23: levels.gammaFlip,
          in_24: levels.mvs,
          in_25: levels.netGex,
          in_26: prev.netGex,
          in_27: levels.netDex,
          in_28: prev.netDex,
          in_29: levels.netVanna,
          in_30: prev.netVanna,
        });
        const anyPaneUpdated = tvWindows.some((w) => w.results?.some((r) => r.updated));
        if (!anyPaneUpdated) {
          throw new Error(`Ninguna ventana/pane de TradingView se actualizo: ${JSON.stringify(tvWindows)}`);
        }
        if (tvAlerted) {
          await ntfy('El push a TradingView volvio a funcionar.', { title: 'Gamma daemon: TradingView recuperado' });
          tvAlerted = false;
        }
        tvFailures = 0;
        saveStatus({ lastTvPushAt: new Date().toISOString(), tvFailures: 0 });
      } catch (tvErr) {
        tvFailures += 1;
        saveStatus({ tvFailures, lastTvError: tvErr.message });
        console.error(`[tv] fallo #${tvFailures}:`, tvErr.message);
        if (tvFailures >= FAILURE_THRESHOLD && !tvAlerted) {
          tvAlerted = true;
          await ntfy(
            `El push a TradingView lleva ${tvFailures} fallos seguidos (${tvErr.message}). Los muros del grafico estan congelados, pero el servidor SIGUE recibiendo el precio de Sigma.`,
            { title: '⚠️ Gamma daemon: TradingView no actualiza', priority: 'high' }
          );
        }
      }
    }
  } catch (e) {
    consecutiveFailures += 1;
    mode = consecutiveFailures >= FAILURE_THRESHOLD ? 'degraded' : mode;
    saveStatus({
      lastCycleAt: new Date().toISOString(),
      consecutiveFailures,
      mode,
      lastError: e.message,
    });
    console.error(`[ciclo] fallo #${consecutiveFailures}:`, e.message);

    if (consecutiveFailures >= FAILURE_THRESHOLD && !alerted) {
      await ntfy(
        `El daemon de Gamma lleva ${consecutiveFailures} fallos seguidos. Ultimo error: ${e.message}`,
        { title: 'Gamma daemon: fallando', priority: 'high' }
      );
      alerted = true;
    }
  }
}

async function loop() {
  if (stopped) return;
  await runCycle();
  if (stopped) return;
  const delay = mode === 'degraded' ? CYCLE_MS_DEGRADED : CYCLE_MS_NORMAL;
  setTimeout(loop, delay);
}

async function shutdown() {
  stopped = true;
  await sigma.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('gamma_daemon arrancando...');
loop();
