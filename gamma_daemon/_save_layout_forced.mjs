// Marca el layout como modificado y lo guarda. Reporta hasChanges en cada paso
// para verificar que el guardado hizo trabajo real (y no un no-op silencioso).
import CDP from 'chrome-remote-interface';
const CDP_PORT = 9223;
async function evalOn(client, expr, awaitPromise = false) {
  const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}
const resp = await fetch(`http://localhost:${CDP_PORT}/json/list`);
const targets = (await resp.json()).filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
for (const t of targets) {
  let client;
  try {
    client = await CDP({ port: CDP_PORT, target: t.id });
    await client.Runtime.enable();
    const esSpx = await evalOn(client, `(function(){try{return window.TradingViewApi._chartWidgetCollection.getAll().some(function(c){try{return /^SPCFD:SPX$/i.test(c.model().mainSeries().symbol());}catch(e){return false;}});}catch(e){return false;}})()`);
    if (!esSpx) { await client.close(); continue; }

    const res = await evalOn(client, `
      (async function(){
        var out = {};
        try {
          var svc = window.TradingViewApi._saveChartService;
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          // Valores actuales del CIARG en este chart, para dejar constancia de QUE se guarda
          try {
            var studies = chart.getAllStudies();
            for (var i = 0; i < studies.length; i++) {
              if (!/CIARG/i.test(studies[i].name || '')) continue;
              var vals = chart.getStudyById(studies[i].id).getInputValues();
              var m = {};
              vals.forEach(function(v){ if (['in_21','in_22','in_23','in_24'].indexOf(v.id) >= 0) m[v.id] = v.value; });
              out.inputs = m;
              break;
            }
          } catch(e){ out.inputsErr = e.message; }

          out.antes = svc.hasChanges();
          svc.markContentAsChanged();
          out.trasMarcar = svc.hasChanges();
          await svc.saveChartSilently();
          out.trasGuardar = svc.hasChanges();
          out.ok = true;
        } catch(e){ out.ok = false; out.error = e.message; }
        return out;
      })()
    `, true);
    console.log(JSON.stringify(res, null, 2));
    await client.close();
    break;
  } catch (e) { console.log('err', e.message); if (client) { try { await client.close(); } catch {} } }
}
