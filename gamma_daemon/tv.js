// Control de TradingView Desktop via CDP crudo, sin pasar por el servidor MCP ni por
// un agente de Claude. La logica de evaluate() esta calcada de C:\Users\gcarv\tradingview-mcp
// (misma libreria que usan las herramientas mcp__tradingview__*) pero la seleccion de
// ventana/target es propia: esa libreria conecta al PRIMER target que matchee
// "tradingview.com/chart", sin verificar el simbolo -- esa es la causa raiz del bug de
// deriva SPY/SPX ya documentado (ventanas duplicadas, cada una con un chart_id distinto,
// y no hay garantia de cual es cual). Aca se prueba cada ventana candidata hasta encontrar
// una que realmente tenga SPX cargado en al menos un pane.
import CDP from 'chrome-remote-interface';
import { execSync, spawn } from 'child_process';

const CDP_PORT = Number(process.env.TV_CDP_PORT || 9223);
// Match exacto al ticker real de SPX en TradingView -- un /SPX/i suelto tambien
// matchea falsos positivos reales como "OANDA:SPX500USD" (CFD de otro broker,
// confirmado en vivo 2026-07-31: aparecio con CIARG_V3 aplicado tras un relanzamiento
// de TradingView y casi recibe los muros por error).
const SYMBOL_MATCH = /^SPCFD:SPX$/i;
// Matchea CUALQUIER version (CIARG_V1, CIARG_V3, etc.) -- las multiples ventanas
// SPX no estan sincronizadas entre si (ver CLAUDE.md) y pueden quedar temporalmente
// con nombres distintos tras renombrar el script hasta que el usuario actualice
// cada una a mano. Con un match fijo a un solo nombre, la busqueda fallaba
// silenciosamente en las ventanas que todavia no se habian actualizado.
const STUDY_NAME_MATCH = /CIARG_V\d/i;

async function evalOn(client, expression) {
  const result = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: false });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'CDP eval error');
  }
  return result.result?.value;
}

async function listChartTargets() {
  const resp = await fetch(`http://localhost:${CDP_PORT}/json/list`);
  if (!resp.ok) throw new Error(`CDP no responde en el puerto ${CDP_PORT} (status ${resp.status})`);
  const targets = await resp.json();
  return targets.filter((t) => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
}

// Devuelve un cliente CDP ya conectado a una ventana que tiene SPX cargado, junto con
// el listado de panes de esa ventana (index, symbol, resolution). El caller es
// responsable de cerrar el client (client.close()) cuando termine.
export async function connectToSpxWindow() {
  const targets = await listChartTargets();
  if (targets.length === 0) {
    throw new Error('No hay ninguna ventana de TradingView con un chart abierto (CDP conectado pero sin targets)');
  }

  let lastError;
  for (const t of targets) {
    let client;
    try {
      client = await CDP({ port: CDP_PORT, target: t.id });
      await client.Runtime.enable();
      const panes = await evalOn(client, `
        (function() {
          var all = window.TradingViewApi._chartWidgetCollection.getAll();
          return all.map(function(c, i) {
            try {
              var ms = c.model().mainSeries();
              return { index: i, symbol: ms.symbol(), resolution: ms.interval() };
            } catch (e) { return { index: i, error: e.message }; }
          });
        })()
      `);
      if (Array.isArray(panes) && panes.some((p) => p.symbol && SYMBOL_MATCH.test(p.symbol))) {
        return { client, targetId: t.id, panes };
      }
      await client.close();
    } catch (e) {
      lastError = e;
      if (client) { try { await client.close(); } catch { /* noop */ } }
    }
  }
  throw new Error(
    `Ninguna de las ${targets.length} ventana(s) de TradingView tiene SPX cargado.` +
    (lastError ? ` Ultimo error: ${lastError.message}` : '')
  );
}

// Foco un pane (equivalente a mcp__tradingview__pane_focus) y busca el estudio CIARG_V1
// en el chart que queda activo. Devuelve el entity_id o null si no aparece en ese pane.
async function findStudyOnFocusedPane(client, paneIndex) {
  await evalOn(client, `
    (function() {
      var all = window.TradingViewApi._chartWidgetCollection.getAll();
      var w = all[${paneIndex}];
      if (w && w._mainDiv) w._mainDiv.click();
      return true;
    })()
  `);
  await new Promise((r) => setTimeout(r, 250));

  return evalOn(client, `
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var studies = chart.getAllStudies();
        for (var i = 0; i < studies.length; i++) {
          var name = studies[i].name || studies[i].title || '';
          if (${STUDY_NAME_MATCH}.test(name)) return studies[i].id;
        }
        return null;
      } catch (e) { return null; }
    })()
  `);
}

async function setStudyInputs(client, entityId, inputs) {
  const inputsJson = JSON.stringify(inputs);
  const result = await evalOn(client, `
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById(${JSON.stringify(entityId)});
      if (!study) return { error: 'Study not found: ' + ${JSON.stringify(entityId)} };
      var currentInputs = study.getInputValues();
      var overrides = ${inputsJson};
      var updatedKeys = {};
      for (var i = 0; i < currentInputs.length; i++) {
        if (overrides.hasOwnProperty(currentInputs[i].id)) {
          currentInputs[i].value = overrides[currentInputs[i].id];
          updatedKeys[currentInputs[i].id] = overrides[currentInputs[i].id];
        }
      }
      study.setInputValues(currentInputs);
      return { updated_inputs: updatedKeys };
    })()
  `);
  if (result && result.error) throw new Error(result.error);
  return result.updated_inputs;
}

// Empuja los inputs a un pane ya enfocado de un client ya conectado. Devuelve el
// resultado de ese pane especifico (nunca lanza por un pane individual fallido).
async function pushToPane(client, p) {
  if (p.error) return { index: p.index, updated: false, reason: p.error };
  const entityId = await findStudyOnFocusedPane(client, p.index).catch(() => null);
  if (!entityId) return { index: p.index, symbol: p.symbol, updated: false, reason: 'study_not_found' };
  return { index: p.index, symbol: p.symbol, updated: true, entity_id: entityId };
}

// Empuja los inputs al estudio CIARG_V1 en cada pane de la PRIMERA ventana SPX
// encontrada unicamente. Se mantiene para compatibilidad/pruebas puntuales -- el
// daemon real usa pushGammaLevelsToAllWindows (ver mas abajo), porque hay mas de una
// ventana SPX abierta a la vez y NO estan sincronizadas entre si (confirmado
// 2026-07-30: cada una puede quedar en una version de script distinta).
export async function pushGammaLevels(inputs) {
  const { client, targetId, panes } = await connectToSpxWindow();
  const results = [];
  try {
    for (const p of panes) {
      const r = await pushToPane(client, p);
      if (r.updated) {
        const updatedInputs = await setStudyInputs(client, r.entity_id, inputs);
        r.updated_inputs = updatedInputs;
      }
      results.push(r);
    }
  } finally {
    await client.close();
  }
  return { targetId, results };
}

// Empuja los inputs a TODAS las ventanas de TradingView que tengan SPX cargado en
// algun pane -- no solo la primera. Necesario porque el usuario puede tener varias
// ventanas SPX abiertas simultaneamente (su plan permite 2 "pantallas") y no hay
// garantia de que compartan la misma instancia del estudio ni la misma version del
// script (confirmado en vivo: una quedo en una version de Pine y la otra en otra
// tras editar el codigo a mano). Pushear a todas evita que alguna se quede
// desactualizada en silencio.
export async function pushGammaLevelsToAllWindows(inputs) {
  const targets = await listChartTargets();
  const windows = [];

  for (const t of targets) {
    let client;
    try {
      client = await CDP({ port: CDP_PORT, target: t.id });
      await client.Runtime.enable();
      const panes = await evalOn(client, `
        (function() {
          var all = window.TradingViewApi._chartWidgetCollection.getAll();
          return all.map(function(c, i) {
            try {
              var ms = c.model().mainSeries();
              return { index: i, symbol: ms.symbol(), resolution: ms.interval() };
            } catch (e) { return { index: i, error: e.message }; }
          });
        })()
      `);
      const hasSpx = Array.isArray(panes) && panes.some((p) => p.symbol && SYMBOL_MATCH.test(p.symbol));
      if (!hasSpx) { await client.close(); continue; }

      const results = [];
      for (const p of panes) {
        const r = await pushToPane(client, p);
        if (r.updated) {
          const updatedInputs = await setStudyInputs(client, r.entity_id, inputs);
          r.updated_inputs = updatedInputs;
        }
        results.push(r);
      }
      windows.push({ targetId: t.id, results });
      await client.close();
    } catch (e) {
      windows.push({ targetId: t.id, error: e.message });
      if (client) { try { await client.close(); } catch { /* noop */ } }
    }
  }

  if (windows.length === 0) {
    throw new Error('Ninguna ventana de TradingView tiene SPX cargado.');
  }
  return windows;
}

export async function healthCheck() {
  const { client, targetId, panes } = await connectToSpxWindow();
  await client.close();
  return { success: true, cdp_connected: true, target_id: targetId, panes };
}

function resolveInstallPath() {
  const out = execSync(
    'powershell -NoProfile -Command "(Get-AppxPackage -Name \'*TradingView*\').InstallLocation"',
    { timeout: 10000 }
  ).toString().trim();
  if (!out) throw new Error('No se encontro el paquete AppX de TradingView (Get-AppxPackage vacio)');
  return `${out}\\TradingView.exe`;
}

// Relanza TradingView con el puerto de depuracion correcto. Mata cualquier instancia
// existente primero (kill_existing !== false) -- esto cierra ventanas que el usuario
// pueda tener abiertas a mano, es una accion disruptiva a proposito documentada.
export async function launch({ killExisting = true } = {}) {
  const exePath = resolveInstallPath();

  if (killExisting) {
    try { execSync('taskkill /F /IM TradingView.exe', { timeout: 5000 }); } catch { /* no estaba corriendo */ }
    await new Promise((r) => setTimeout(r, 1500));
  }

  const child = spawn(exePath, [`--remote-debugging-port=${CDP_PORT}`], { detached: true, stdio: 'ignore' });
  child.unref();

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const resp = await fetch(`http://localhost:${CDP_PORT}/json/version`);
      if (resp.ok) return { success: true, pid: child.pid, cdpReady: true };
    } catch { /* sigue esperando */ }
  }
  return { success: true, pid: child.pid, cdpReady: false, warning: 'CDP no respondio en 20s, puede seguir cargando' };
}
