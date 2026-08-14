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
    const esSpx = await evalOn(client, `(function(){try{return window.TradingViewApi._chartWidgetCollection.getAll().some(function(c){try{return /^SPCFD:SPX$/i.test(c.model().mainSeries().symbol());}catch(e){return false;}});}catch(e){return false;}})()`);
    if (!esSpx) { await client.close(); continue; }
    const res = await evalOn(client, `
      (function(){
        var out = {};
        var svc = window.TradingViewApi._saveChartService;
        if (!svc) return { error: 'sin _saveChartService' };
        var props = [];
        var o = svc;
        while (o) { Object.getOwnPropertyNames(o).forEach(function(k){ if (props.indexOf(k) < 0) props.push(k); }); o = Object.getPrototypeOf(o); }
        out.metodos = props.filter(function(k){ return typeof svc[k] === 'function'; });
        out.campos  = props.filter(function(k){ return typeof svc[k] !== 'function'; });
        // ¿autoguardado activo?
        try {
          var api = window.TradingViewApi;
          out.autoSaveKeys = Object.keys(api).filter(function(k){ return /auto/i.test(k); });
        } catch(e){}
        return out;
      })()
    `);
    console.log(JSON.stringify(res, null, 2));
    await client.close();
    break;
  } catch (e) { console.log('err', e.message); if (client) { try { await client.close(); } catch {} } }
}
