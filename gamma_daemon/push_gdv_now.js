// Empuje manual, unico: primera carga de datos reales de GEX/DEX/Vanna a la tabla
// nueva (recien agregada), ya que arranca en 0.0 hasta el primer push. Como es la
// primera lectura, "anterior" se deja igual a "actual" (no hay historial todavia).
import CDP from 'chrome-remote-interface';
import * as sigma from './sigma.js';

const CDP_PORT = 9223;

async function evalOn(client, expression) {
  const result = await client.Runtime.evaluate({ expression, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function listSpxTargets() {
  const resp = await fetch(`http://localhost:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  return targets.filter((t) => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
}

const levels = await sigma.readLevels();
console.log('Sigma Terminal:', JSON.stringify(levels, null, 2));

const inputs = {
  in_20: true,
  in_21: levels.callWall,
  in_22: levels.putWall,
  in_23: levels.gammaFlip,
  in_24: levels.mvs,
  in_25: levels.netGex,
  in_26: levels.netGex, // anterior = actual, primera carga
  in_27: levels.netDex,
  in_28: levels.netDex,
  in_29: levels.netVanna,
  in_30: levels.netVanna,
};

const targets = await listSpxTargets();
for (const t of targets) {
  let client;
  try {
    client = await CDP({ port: CDP_PORT, target: t.id });
    await client.Runtime.enable();

    const panes = await evalOn(client, `
      window.TradingViewApi._chartWidgetCollection.getAll().map(function(c, i) {
        try { return { index: i, symbol: c.model().mainSeries().symbol() }; } catch(e) { return { index: i, error: e.message }; }
      })
    `);
    const hasSpx = panes.some((p) => p.symbol && /^SPCFD:SPX$/i.test(p.symbol));
    if (!hasSpx) { await client.close(); continue; }

    for (const p of panes) {
      if (p.error) continue;
      await evalOn(client, `
        (function() {
          var all = window.TradingViewApi._chartWidgetCollection.getAll();
          var w = all[${p.index}];
          if (w && w._mainDiv) w._mainDiv.click();
          return true;
        })()
      `);
      await new Promise((r) => setTimeout(r, 250));

      const entityId = await evalOn(client, `
        (function() {
          try {
            var chart = window.TradingViewApi._activeChartWidgetWV.value();
            var studies = chart.getAllStudies();
            for (var i = 0; i < studies.length; i++) {
              var name = studies[i].name || studies[i].title || '';
              if (/CIARG_V\d/i.test(name)) return studies[i].id;
            }
            return null;
          } catch (e) { return null; }
        })()
      `);
      if (!entityId) { console.log(`${t.id} pane ${p.index}: CIARG_V1 no encontrado`); continue; }

      const schemaCheck = await evalOn(client, `
        (function() {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          var study = chart.getStudyById(${JSON.stringify(entityId)});
          var ids = study.getInputValues().map(function(i){ return i.id; });
          return ids.indexOf('in_27') !== -1;
        })()
      `);
      if (!schemaCheck) { console.log(`${t.id} pane ${p.index}: schema vieja (sin in_27), se salta`); continue; }

      const result = await evalOn(client, `
        (function() {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          var study = chart.getStudyById(${JSON.stringify(entityId)});
          var currentInputs = study.getInputValues();
          var overrides = ${JSON.stringify(inputs)};
          var updated = {};
          for (var i = 0; i < currentInputs.length; i++) {
            if (overrides.hasOwnProperty(currentInputs[i].id)) {
              currentInputs[i].value = overrides[currentInputs[i].id];
              updated[currentInputs[i].id] = overrides[currentInputs[i].id];
            }
          }
          study.setInputValues(currentInputs);
          return updated;
        })()
      `);
      console.log(`${t.id} pane ${p.index}: actualizado`, JSON.stringify(result));
    }
    await client.close();
  } catch (e) {
    console.log(`${t.id}: error`, e.message);
    if (client) await client.close().catch(() => {});
  }
}

await sigma.close();
process.exit(0);
