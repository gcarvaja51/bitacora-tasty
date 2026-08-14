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
      (function(){
        var out = {};
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          var s = chart.getShapeById('pCVkiH');
          out.encontrada = !!s;
          if (s) {
            try { out.puntos = s.getPoints(); } catch(e){ out.puntosErr = e.message; }
            try { out.props = s.getProperties ? Object.keys(s.getProperties()) : null; } catch(e){}
          }
          out.totalShapes = chart.getAllShapes().length;
          try { out.syncFlag = !!chart._canUseLineToolsSynchronizer; } catch(e){}
          try { out.syncObj = chart.lineToolsSynchronizer ? typeof chart.lineToolsSynchronizer : 'no'; } catch(e){ out.syncObjErr = e.message; }
        } catch(e){ out.error = e.message; }
        return out;
      })()
    `);
    console.log(JSON.stringify(res, null, 2));
    await client.close();
    break;
  } catch (e) { console.log('err', e.message); if (client) { try { await client.close(); } catch {} } }
}
