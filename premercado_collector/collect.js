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
import { connectToSpxWindow, launch as launchTv } from '../gamma_daemon/tv.js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAMMA_STATUS_PATH = path.join(__dirname, '..', 'gamma_daemon', 'status.json');
const OUT_ROOT = 'C:\\Users\\gcarv\\Documents\\CARPETA PERSONAL\\01. guillermo carvajal\\01_Sigma\\mentoria alejandro\\premercados alejandro\\control premercado\\data_collector';
const LOG_PATH = path.join(OUT_ROOT, 'collector.log');

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
  let conn;
  try {
    conn = await connectToSpxWindow();
  } catch (e) {
    log(`[tv] conexion inicial fallo (${e.message}), relanzando TradingView...`);
    await launchTv({ killExisting: true });
    await new Promise((r) => setTimeout(r, 15000));
    conn = await connectToSpxWindow();
  }

  const { client, panes } = conn;
  const paneIndex = panes.find((p) => !p.error)?.index ?? 0;
  const originalResolution = await getResolution(client).catch(() => null);

  try {
    await focusPane(client, paneIndex);
    await setResolution(client, '30');
    await setVisibleRangeDays(client, 3);
    await captureChartPng(client, paneIndex, path.join(outDir, 'chart_30m.png'));
    const studyValues = await getStudyValues(client);
    return { success: true, paneIndex, studyValues };
  } finally {
    try {
      if (originalResolution) {
        await setResolution(client, originalResolution);
      }
    } catch (e) {
      log(`[tv] no se pudo restaurar la resolucion original del pane ${paneIndex}: ${e.message}`);
    }
    await client.close();
  }
}

async function main() {
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
