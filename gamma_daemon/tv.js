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

// awaitPromise sigue en false por defecto para no cambiar el comportamiento de
// las llamadas existentes; saveLayout() lo activa porque saveChartSilently()
// devuelve una promesa y sin esto se leeria "[object Promise]" como resultado
// y se daria por bueno un guardado que todavia no ocurrio.
async function evalOn(client, expression, awaitPromise = false) {
  const result = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise });
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

// Activa un pane con la API de TradingView y CONFIRMA donde quedo.
//
// El bug que esto arregla (2026-08-11): antes se hacia w._mainDiv.click() sobre el
// widget del pane, se esperaban 250ms y despues se leia _activeChartWidgetWV.value().
// Son dos objetos distintos y no intercambiables: _chartWidgetCollection.getAll()
// devuelve los widgets INTERNOS (los que tienen .model()) y _activeChartWidgetWV
// devuelve el wrapper PUBLICO, el unico que expone getAllStudies/getStudyById.
// Ni siquiera coinciden por identidad. Si el clic sintetico no cambiaba el foco,
// las dos iteraciones escribian sobre el MISMO chart y el otro pane se quedaba
// congelado con muros viejos.
//
// Asi lo detecto el usuario mirando el grafico: el pane de 2m con los muros al dia
// (7780/7750) y el de 15m en 7750/7700, con GEX y DEX tambien distintos. Nada lo
// delataba desde el daemon — pushToPane devolvia updated:true igual, porque SI
// encontraba un estudio CIARG, solo que el del pane equivocado, y tvFailures se
// quedaba en 0.
//
// setActiveChart(i) es el mecanismo propio de TradingView y toma el indice de la
// coleccion, el mismo con el que se armo `panes`. El chequeo de resolucion es una
// red de seguridad, no el mecanismo: con los dos panes en el mismo timeframe no
// distinguiria nada, pero ahi tampoco habria nada que distinguir.
async function activarPane(client, paneIndex) {
  await evalOn(client, `
    (function() {
      try { window.TradingViewApi.setActiveChart(${paneIndex}); return true; }
      catch (e) { return false; }
    })()
  `);
  await new Promise((r) => setTimeout(r, 300));

  // La resolucion esperada se relee AHORA de la coleccion, no del snapshot tomado
  // al conectar: si el usuario cambia el timeframe entremedio no queremos un error
  // falso que dispare alertas por nada.
  const chequeo = await evalOn(client, `
    (function() {
      try {
        var api = window.TradingViewApi;
        var interno = api._chartWidgetCollection.getAll()[${paneIndex}];
        if (!interno) return { error: 'el pane ${paneIndex} ya no existe' };
        var activo = api._activeChartWidgetWV.value();
        if (!activo) return { error: 'no hay chart activo' };
        var esperada = null, real = null;
        try { esperada = String(interno.model().mainSeries().interval()); } catch (e) {}
        try { real = String(activo.resolution()); } catch (e) {}
        if (esperada && real && esperada !== real) {
          return { error: 'se pidio el pane ${paneIndex} (' + esperada + ') pero quedo activo el de ' + real };
        }
        return { ok: true };
      } catch (e) { return { error: String(e).slice(0, 80) }; }
    })()
  `);
  if (!chequeo || chequeo.error) throw new Error(chequeo?.error || 'no se pudo activar el pane');
}

// Busca el estudio CIARG en el pane indicado. Devuelve el entity_id o null.
async function findStudyOnPane(client, paneIndex) {
  await activarPane(client, paneIndex);
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

// paneIndex es obligatorio por la misma razon: tocar el chart ACTIVO sin haberlo
// activado a proposito es exactamente el bug que dejaba un pane congelado.
async function setStudyInputs(client, entityId, inputs, paneIndex) {
  await activarPane(client, paneIndex);
  const inputsJson = JSON.stringify(inputs);
  const result = await evalOn(client, `
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      if (!chart) return { error: 'no hay chart activo' };
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
  // El fallo al ACTIVAR el pane se reporta tal cual, no como 'study_not_found':
  // son dos problemas distintos y confundirlos fue parte de por que el pane
  // congelado paso desapercibido tanto tiempo.
  let entityId = null;
  try {
    entityId = await findStudyOnPane(client, p.index);
  } catch (e) {
    return { index: p.index, symbol: p.symbol, updated: false, reason: e.message };
  }
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
        const updatedInputs = await setStudyInputs(client, r.entity_id, inputs, p.index);
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
          const updatedInputs = await setStudyInputs(client, r.entity_id, inputs, p.index);
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

// ── Guardar el layout en la nube de TradingView (2026-08-15) ───────────────
//
// POR QUE HACE FALTA. setStudyInputs() escribe los muros en la MEMORIA de la
// ventana del escritorio y nada mas. La app del celular (y cualquier otro
// dispositivo) lee el layout desde la nube, asi que hasta que alguien no guarde,
// alli siguen los valores del ultimo guardado.
//
// Hasta el 2026-08-05 esto funcionaba por efecto colateral: el usuario tocaba el
// chart a mano (mover algo, cambiar temporalidad, dibujar), eso ensuciaba el
// layout, el autoguardado de TradingView --que esta activo-- disparaba, y de paso
// subia los inputs que el daemon habia escrito. Desde el incidente del 2026-08-06
// (el daemon empezo a matar y relanzar TradingView) la ventana se relanza sola,
// el usuario dejo de tocarla, y con eso desaparecio lo unico que guardaba. El
// celular quedo congelado en los muros del 5-ago: Call Wall 7740, Gamma Flip
// 7735, MVS 7730 -- exactamente la tabla del premercado de ese dia.
//
// markContentAsChanged() es imprescindible: sin el, hasChanges() sigue en false y
// saveChartSilently() no tiene nada que subir. Verificado el 2026-08-14 mirando
// el ciclo del flag (false -> true -> false) y confirmando despues, desde otro
// navegador, que la copia en la nube traia ya los valores nuevos.
export async function saveLayout() {
  const { client } = await connectToSpxWindow();
  try {
    const r = await evalOn(client, `
      (async function() {
        try {
          var svc = window.TradingViewApi._saveChartService;
          if (!svc) return { ok: false, error: 'sin _saveChartService' };
          svc.markContentAsChanged();
          await svc.saveChartSilently();
          // quedaSucio es solo informativo y NO indica fallo: hasChanges() se
          // limpia un instante DESPUES de que saveChartSilently() resuelve, asi
          // que leido aca mismo suele salir true aunque el guardado haya ido bien
          // (comprobado el 2026-08-15: true al volver, false dos segundos mas
          // tarde). Lo que decide el exito es que no haya excepcion.
          return {
            ok: true,
            layoutId: (typeof svc.layoutId === 'function') ? svc.layoutId() : null,
            quedaSucio: (typeof svc.hasChanges === 'function') ? svc.hasChanges() : null
          };
        } catch (e) { return { ok: false, error: e.message }; }
      })()
    `, true);
    if (!r || !r.ok) throw new Error(r?.error || 'saveChartSilently no devolvio ok');
    return r;
  } finally {
    await client.close();
  }
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
