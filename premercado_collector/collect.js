// Recolector de datos para el skill premercado-spx.
//
// Por que existe: la redaccion del informe (Claude, via /premercado-spx) necesita datos
// de TradingView (captura del chart de 30min + valores de estudios como POC) y de Sigma
// Terminal (Call Wall/Put Wall/Gamma Flip/MVS/GEX). Pelear con la conexion CDP/Chrome EN
// VIVO mientras se redacta el informe es lo que ha fallado repetidamente (puerto CDP
// desalineado, extension de Chrome desconectada, ventanas duplicadas). Este script separa
// esa parte mecanica -- conectarse, capturar, leer numeros -- de la parte que si necesita
// criterio (escribir el analisis). Corre ANTES (via Tarea Programada, o a mano), deja todo
// en disco, y el skill simplemente lee el bundle mas reciente si existe.
//
// Reutiliza la logica de conexion ya probada en gamma_daemon/tv.js en vez de
// reimplementarla -- mismo patron de "probar cada ventana candidata, verificar el simbolo"
// que ya resolvio el bug de deriva SPY/SPX del daemon de Gamma.
//
// Para Sigma Terminal NO se lanza un Puppeteer propio (a diferencia de tv.js, que si
// se reutiliza) -- gamma_daemon/sigma.js usa un Chrome dedicado con perfil persistente
// (sigma_profile/) que el propio gamma_daemon mantiene abierto de forma continua (no lo
// cierra entre ciclos). Intentar lanzar una SEGUNDA instancia de Puppeteer contra el
// mismo userDataDir revienta con "Failed to launch the browser process!" (bug real
// encontrado 2026-08-01) porque el profile ya esta en uso. En vez de competir por esa
// misma instancia, este colector lee directamente gamma_daemon/status.json -- el propio
// daemon ya persiste ahi su ultima lectura exitosa (lastLevels/lastSuccessAt) cada vez
// que corre un ciclo dentro de horario de mercado, que es exactamente el dato que hace
// falta ("el ultimo disponible") sin necesidad de tocar el navegador para nada.
import { connectToSpxWindow } from '../gamma_daemon/tv.js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAMMA_STATUS_PATH = path.join(__dirname, '..', 'gamma_daemon', 'status.json');
const OUT_ROOT = 'C:\\Users\\gcarv\\Documents\\CARPETA PERSONAL\\01. guillermo carvajal\\01_Sigma\\mentoria alejandro\\premercados alejandro\\control premercado\\data_collector';
const LOG_PATH = path.join(OUT_ROOT, 'collector.log');

// Presupuesto de tiempo para TODA la parte de TradingView. Incidente real 19 y 20 de
// agosto de 2026: connectToSpxWindow() se colgo ~9 minutos. CDP no tiene timeout propio
// -- si una ventana de TradingView no responde a Runtime.enable()/evaluate(), el await
// no vuelve NUNCA. Y mientras este proceso esperaba, el gamma_daemon (que es el dueño
// real de esa ventana, ver CLAUDE.md) relanzo TradingView por debajo y le mato el
// WebSocket. Por eso en collector.log los dos sintomas aparecian siempre juntos:
// "no se pudo restaurar la resolucion ... readyState 3 (CLOSED)" y "FALLO: WebSocket
// connection closed". El gate, del otro lado, mataba el proceso por timeout y anotaba
// "se colgo antes de siquiera empezar" -- diagnostico equivocado: si habia empezado, lo
// que no tenia era techo. Ahora cada paso tiene el suyo y el bloque entero tambien: si
// TradingView no coopera en 2 minutos se abandona esa parte y se escribe igual el bundle
// con los datos de Sigma, que son los que de verdad usa el informe.
// OJO -- el techo va PASO POR PASO, nunca envolviendo el bloque entero. Promise.race
// no cancela nada: si se le pone un limite global a collectFromTradingView(), la carrera
// rechaza pero la cadena de adentro SIGUE corriendo, y puede ejecutar setResolution('30')
// justo mientras main() va camino al process.exit(). Resultado: el chart del SPX queda
// clavado en 30 minutos sin que nadie restaure la resolucion original -- y el usuario
// opera el SPX en 15 min (ver CLAUDE.md). Con el techo por paso, en cambio, el rechazo
// viaja por el camino normal de excepciones y el bloque finally SI corre: se restaura la
// resolucion y se cierra el cliente. Peor caso sumando todos los pasos: ~220s, por debajo
// del watchdog interno de 300s.
const TV_STEP_MS = Number(process.env.TV_STEP_MS || 20000);
const TV_CONNECT_MS = Number(process.env.TV_CONNECT_MS || 60000);
// Cinturon final: pase lo que pase, este proceso no vive mas de 5 minutos. unref() para
// que este temporizador no sea lo que mantenga vivo el event loop cuando todo salio bien.
const HARD_KILL_MS = Number(process.env.COLLECTOR_HARD_KILL_MS || 300000);

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout de ${Math.round(ms / 1000)}s en ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function todayStamp() {
  // MMDDAAAA, mismo formato que ya usa el resto del skill para nombrar archivos.
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}${dd}${d.getFullYear()}`;
}

function log(line) {
  mkdirSync(OUT_ROOT, { recursive: true });
  const ts = new Date().toISOString();
  writeFileSync(LOG_PATH, `${ts}\t${line}\n`, { flag: 'a' });
  console.log(line);
}

async function evalOn(client, expression) {
  const result = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: false });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'CDP eval error');
  }
  return result.result?.value;
}

async function focusPane(client, paneIndex) {
  await evalOn(client, `
    (function() {
      var all = window.TradingViewApi._chartWidgetCollection.getAll();
      var w = all[${paneIndex}];
      if (w && w._mainDiv) w._mainDiv.click();
      return true;
    })()
  `);
  await new Promise((r) => setTimeout(r, 300));
}

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

async function getResolution(client) {
  return evalOn(client, `${CHART_API}.resolution()`);
}

async function setResolution(client, timeframe) {
  await evalOn(client, `${CHART_API}.setResolution(${JSON.stringify(timeframe)}, {})`);
  await new Promise((r) => setTimeout(r, 1500));
}

async function setVisibleRangeDays(client, days) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86400;
  await evalOn(client, `
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${from} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${to}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise((r) => setTimeout(r, 800));
}

async function captureChartPng(client, paneIndex, outPath) {
  // El contenedor `.chart-widget` (referencia _mainDiv del pane) incluye TODAS las
  // sub-panes (precio + indicadores como MACD/volumen), el eje de precio Y el eje de
  // tiempo de abajo -- a diferencia de recortar solo al canvas de precio
  // (`[data-name="pane-canvas"]`), que deja fuera el eje de tiempo y hace imposible ver
  // donde empieza y termina el movimiento del dia (pedido explicito del usuario,
  // 2026-08-01: "asegurate que se vea... el eje x del tiempo").
  const bounds = await evalOn(client, `
    (function() {
      var all = window.TradingViewApi._chartWidgetCollection.getAll();
      var w = all[${paneIndex}];
      if (!w || !w._mainDiv) return null;
      var rect = w._mainDiv.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()
  `);
  // Page.captureScreenshot SOLO devuelve algo si la ventana esta realmente visible:
  // sin frames del compositor (ventana tapada o minimizada) la llamada no vuelve nunca.
  // Medido el 21-ago-2026 sobre las 5 ventanas de TradingView abiertas: la unica al frente
  // capturo en 0,6s y las otras CUATRO se colgaron indefinidamente, la del SPX incluida.
  // Ese, y no "TradingView no responde", era el cuelgue que se comia 9-12 minutos del
  // premercado. Tambien explica por que esto funciono hasta el 12-ago y despues no: la
  // ventana dejo de estar al frente, nada mas. Con bringToFront() la misma captura tarda
  // 0,8s. Cuesta levantar la ventana del SPX un instante a las 7:30am, antes de la
  // apertura -- es el precio de tener la captura, y es la unica forma de obtenerla.
  await client.Page.enable();
  await client.Page.bringToFront();
  await new Promise((r) => setTimeout(r, 1200));   // que el compositor pinte al menos un frame
  const params = { format: 'png' };
  if (bounds) params.clip = { ...bounds, scale: 1 };
  const { data } = await client.Page.captureScreenshot(params);
  writeFileSync(outPath, Buffer.from(data, 'base64'));
}

async function getStudyValues(client) {
  const data = await evalOn(client, `
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          var values = {};
          try {
            var dwv = s.dataWindowView();
            if (dwv) {
              var items = dwv.items();
              if (items) {
                for (var i = 0; i < items.length; i++) {
                  var item = items[i];
                  if (item._value && item._value !== '\u2205' && item._title) values[item._title] = item._value;
                }
              }
            }
          } catch(e) {}
          if (Object.keys(values).length > 0) results.push({ name: name, values: values });
        } catch(e) {}
      }
      return results;
    })()
  `);
  return data || [];
}

async function collectFromTradingView(outDir) {
  // NO se relanza TradingView desde aca. Antes, si la conexion inicial fallaba, esto
  // llamaba a launchTv({ killExisting: true }) -- es decir taskkill /F /IM TradingView.exe.
  // Relanzar TradingView es potestad EXCLUSIVA del gamma_daemon (ver CLAUDE.md): hacerlo
  // desde el colector deja al usuario sin poder operar en plena preapertura y ademas
  // levanta una ventana que puede quedar en otro layout o simbolo, con la que despues
  // pelea el daemon. Si no hay ventana usable, este colector se resigna y devuelve el
  // error: el informe ya tiene fallback para el chart (datos de Yahoo + niveles).
  const conn = await withTimeout(connectToSpxWindow(), TV_CONNECT_MS, 'connectToSpxWindow');

  const { client, panes } = conn;
  const paneIndex = panes.find((p) => !p.error)?.index ?? 0;
  const originalResolution = await withTimeout(getResolution(client), TV_STEP_MS, 'getResolution').catch(() => null);

  try {
    await withTimeout(focusPane(client, paneIndex), TV_STEP_MS, 'focusPane');
    await withTimeout(setResolution(client, '30'), TV_STEP_MS, 'setResolution 30');
    await withTimeout(setVisibleRangeDays(client, 3), TV_STEP_MS, 'setVisibleRangeDays');
    await withTimeout(captureChartPng(client, paneIndex, path.join(outDir, 'chart_30m.png')), TV_STEP_MS * 1.5, 'captureChartPng');
    const studyValues = await withTimeout(getStudyValues(client), TV_STEP_MS, 'getStudyValues');
    return { success: true, paneIndex, studyValues };
  } finally {
    // Devolver la resolucion original es cortesia, no requisito: si el socket ya murio
    // no se insiste. Esta linea era el primer sintoma visible del cuelgue.
    try {
      if (originalResolution) {
        await withTimeout(setResolution(client, originalResolution), TV_STEP_MS, 'restaurar resolucion');
      }
    } catch (e) {
      log(`[tv] no se pudo restaurar la resolucion original del pane ${paneIndex}: ${e.message}`);
    }
    try { await withTimeout(client.close(), 10000, 'client.close'); } catch { /* noop */ }
  }
}

async function main() {
  setTimeout(() => {
    log(`[fatal] watchdog interno: ${Math.round(HARD_KILL_MS / 60000)} min sin terminar, saliendo a la fuerza`);
    process.exit(1);
  }, HARD_KILL_MS).unref();

  const stamp = todayStamp();
  const outDir = path.join(OUT_ROOT, stamp);
  mkdirSync(outDir, { recursive: true });

  const bundle = { collectedAt: new Date().toISOString(), tradingview: null, sigma: null, errors: [] };

  try {
    bundle.tradingview = await collectFromTradingView(outDir);
    log(`[tv] OK -- pane ${bundle.tradingview.paneIndex}, ${bundle.tradingview.studyValues.length} estudios leidos, captura guardada`);
  } catch (e) {
    bundle.errors.push(`tradingview: ${e.message}`);
    log(`[tv] FALLO: ${e.message}`);
  }

  try {
    const status = JSON.parse(readFileSync(GAMMA_STATUS_PATH, 'utf8'));
    if (!status.lastLevels) throw new Error('status.json de gamma_daemon no tiene lastLevels todavia');
    bundle.sigma = { ...status.lastLevels, asOf: status.lastSuccessAt };
    log(`[sigma] OK (ultimo dato del gamma_daemon, ${status.lastSuccessAt}) -- Call Wall ${bundle.sigma.callWall}, Put Wall ${bundle.sigma.putWall}, Gamma Flip ${bundle.sigma.gammaFlip}`);
  } catch (e) {
    bundle.errors.push(`sigma: ${e.message}`);
    log(`[sigma] FALLO: ${e.message}`);
  }

  writeFileSync(path.join(outDir, 'bundle.json'), JSON.stringify(bundle, null, 2));
  log(`[done] bundle escrito en ${outDir} (errores: ${bundle.errors.length})`);
  process.exit(bundle.errors.length > 0 && !bundle.tradingview && !bundle.sigma ? 1 : 0);
}

main().catch((e) => {
  log(`[fatal] ${e.stack || e.message}`);
  process.exit(1);
});
