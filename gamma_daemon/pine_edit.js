// Utilidades para editar el Pine Script de CIARG_V1 directamente, apuntando al target
// especifico donde el usuario ya abrio el editor manualmente (varias ventanas SPX pueden
// estar abiertas a la vez; solo una tiene el Monaco Editor cargado).
import CDP from 'chrome-remote-interface';

const CDP_PORT = 9223;

const FIND_MONACO = `
  (function findMonacoEditor() {
    var container = document.querySelector('.monaco-editor.pine-editor-monaco');
    if (!container) return null;
    var el = container;
    var fiberKey;
    for (var i = 0; i < 20; i++) {
      if (!el) break;
      fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
      if (fiberKey) break;
      el = el.parentElement;
    }
    if (!fiberKey) return null;
    var current = el[fiberKey];
    for (var d = 0; d < 15; d++) {
      if (!current) break;
      if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
        var env = current.memoizedProps.value.monacoEnv;
        if (env.editor && typeof env.editor.getEditors === 'function') {
          var editors = env.editor.getEditors();
          if (editors.length > 0) return { editor: editors[0], env: env };
        }
      }
      current = current.return;
    }
    return null;
  })()
`;

async function evalOn(client, expression, awaitPromise = false) {
  const result = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

export async function findMonacoTarget() {
  const resp = await fetch(`http://localhost:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const candidates = targets.filter((t) => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
  for (const t of candidates) {
    let client;
    try {
      client = await CDP({ port: CDP_PORT, target: t.id });
      await client.Runtime.enable();
      const has = await evalOn(client, `!!document.querySelector('.monaco-editor.pine-editor-monaco')`);
      if (has) return { client, targetId: t.id };
      await client.close();
    } catch (e) {
      if (client) await client.close().catch(() => {});
    }
  }
  throw new Error('Ninguna ventana tiene el Pine Editor abierto -- abrilo manualmente primero.');
}

export async function getSource(client) {
  const source = await evalOn(client, `
    (function() {
      var m = ${FIND_MONACO};
      return m ? m.editor.getValue() : null;
    })()
  `);
  if (source == null) throw new Error('Monaco encontrado pero getValue() devolvio null.');
  return source;
}

export async function setSource(client, source) {
  const ok = await evalOn(client, `
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return false;
      m.editor.setValue(${JSON.stringify(source)});
      return true;
    })()
  `);
  if (!ok) throw new Error('No se pudo escribir el nuevo codigo (setValue fallo).');
}

export async function getErrors(client) {
  return evalOn(client, `
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);
}

export async function clickSaveAndAddToChart(client) {
  return evalOn(client, `
    (function() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/save and add to chart/i.test(text)) { btns[i].click(); return 'Save and add to chart'; }
      }
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/^(Add to chart|Update on chart)$/i.test(text)) { btns[i].click(); return text; }
      }
      return null;
    })()
  `);
}
