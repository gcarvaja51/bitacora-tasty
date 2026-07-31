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
const HISTORY_CAP = 20; // sobra para "3 ciclos atras" (~6 min); ~40 min de margen total

const PROD_BASE = 'https://web-production-23473.up.railway.app';
const NTFY_TOPIC = 'bitacora_gcarvaja51'; // mismo topic que ya usa server.js

const CYCLE_MS_NORMAL = 2 * 60 * 1000;
const CYCLE_MS_DEGRADED = 5 * 60 * 1000;
const FAILURE_THRESHOLD = 3; // ~ 6 min en modo normal antes de alertar

let consecutiveFailures = 0;
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
  const prevEntry = history[2] || history[history.length - 1] || null;

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

    const tvInputs = {
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
    };

    const tvWindows = await pushToTradingViewWithRetry(tvInputs);
    const anyPaneUpdated = tvWindows.some((w) => w.results?.some((r) => r.updated));
    if (!anyPaneUpdated) {
      throw new Error(`Ninguna ventana/pane de TradingView se actualizo: ${JSON.stringify(tvWindows)}`);
    }

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
