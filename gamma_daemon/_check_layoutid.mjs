import CDP from 'chrome-remote-interface';
const CDP_PORT = 9223;
async function evalOn(client, expr) {
  const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true });
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
    const res = await evalOn(client, `
      (function(){
        var out = {};
        try {
          var api = window.TradingViewApi;
          try { out.layoutName = api.layoutName(); } catch(e){}
          // id del layout guardado: probar accesores conocidos
          ['chartsLayoutId','layoutId','getSavedChartId','_saveChartService'].forEach(function(k){
            try {
              var v = api[k];
              if (typeof v === 'function') { try { out[k] = v.call(api); } catch(e){} }
              else if (v && typeof v === 'object') {
                var sub = {};
                ['_chartId','chartId','_layoutId','layoutId','_name','id'].forEach(function(j){
                  try { var w = v[j]; if (typeof w === 'function') w = w.call(v); if (w && w.value) w = w.value(); if (w != null && typeof w !== 'object') sub[j] = w; } catch(e){}
                });
                out[k] = sub;
              } else if (v != null) out[k] = v;
            } catch(e){}
          });
          try { out.url = location.href; } catch(e){}
          try { out.symbols = api._chartWidgetCollection.getAll().map(function(c){ try { return c.model().mainSeries().symbol(); } catch(e){ return '?'; } }); } catch(e){}
        } catch(e){ out.error = e.message; }
        return out;
      })()
    `);
    console.log(`--- ${t.id.slice(0,8)} ---`);
    console.log(JSON.stringify(res));
    console.log('');
    await client.close();
  } catch (e) { console.log('err', e.message); if (client) { try { await client.close(); } catch {} } }
}
