// Push puntual de los niveles YA GUARDADOS (no relee Sigma Terminal) al estudio
// CIARG de TradingView. Existe porque el mercado esta cerrado (domingo) y el
// perfil de Chromium esta ocupado por el daemon -- push_gdv_now.js no puede
// lanzar su propio Puppeteer mientras el daemon corre. Los niveles vienen del
// servidor (ultimo valor real, cierre del viernes), asi que el resultado es
// identico a lo que Sigma Terminal mostraria ahora mismo.
import CDP from 'chrome-remote-interface';

const CDP_PORT = 9223;

const resp0 = await fetch('https://web-production-23473.up.railway.app/api/spx/sigma-levels');
const levels = await resp0.json();
console.log('Niveles guardados (servidor):', JSON.stringify({
  callWall: levels.callWall, putWall: levels.putWall, gammaFlip: levels.gammaFlip,
  mvs: levels.mvs, netGex: levels.netGex, netDex: levels.netDex,
  regime: levels.regime, updatedAt: levels.updatedAt,
}, null, 2));

// netVanna no lo expone el endpoint del servidor -- se toma del status.json del
// daemon (misma lectura de Sigma Terminal, guardada localmente).
const fs = await import('fs');
let netVanna = 0;
try {
  const st = JSON.parse(fs.readFileSync('./status.json', 'utf8'));
  netVanna = st?.lastLevels?.netVanna ?? 0;
} catch { /* queda en 0 */ }
console.log('netVanna (status.json del daemon):', netVanna);

const inputs = {
  in_20: true,
  in_21: levels.callWall,
  in_22: levels.putWall,
  in_23: levels.gammaFlip,
  in_24: levels.mvs,
  in_25: levels.netGex,
  in_26: levels.netGex,
  in_27: levels.netDex,
  in_28: levels.netDex,
  in_29: netVanna,
  in_30: netVanna,
};

async function evalOn(client, expression) {
  const result = await client.Runtime.evaluate({ expression, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

const resp = await fetch(`http://localhost:${CDP_PORT}/json/list`);
const targets = (await resp.json()).filter(
  (t) => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url)
);

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
    if (!hasSpx) {
      console.log(`${t.id.slice(0,8)}: sin SPCFD:SPX (${panes.map(p=>p.symbol).join(', ')}) — se salta`);
      await client.close();
      continue;
    }

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
      await new Promise((r) => setTimeout(r, 300));

      const entityId = await evalOn(client, `
        (function() {
          try {
            var chart = window.TradingViewApi._activeChartWidgetWV.value();
            var studies = chart.getAllStudies();
            for (var i = 0; i < studies.length; i++) {
              var name = studies[i].name || studies[i].title || '';
              if (/CIARG_V\\d/i.test(name)) return studies[i].id;
            }
            return null;
          } catch (e) { return null; }
        })()
      `);
      if (!entityId) { console.log(`${t.id.slice(0,8)} pane ${p.index}: CIARG no encontrado`); continue; }

      const schemaCheck = await evalOn(client, `
        (function() {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          var study = chart.getStudyById(${JSON.stringify(entityId)});
          var ids = study.getInputValues().map(function(i){ return i.id; });
          return ids.indexOf('in_27') !== -1;
        })()
      `);
      if (!schemaCheck) { console.log(`${t.id.slice(0,8)} pane ${p.index}: schema vieja (sin in_27), se salta`); continue; }

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
      console.log(`${t.id.slice(0,8)} pane ${p.index} (${p.symbol}): ✅ actualizado`, JSON.stringify(result));
    }
    await client.close();
  } catch (e) {
    console.error(`${t.id.slice(0,8)}: ERROR`, e.message);
    if (client) { try { await client.close(); } catch {} }
  }
}
