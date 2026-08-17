// SOLO LECTURA: estado del servicio de guardado en cada ventana de TradingView.
import CDP from 'chrome-remote-interface';
const PORT = 9223;
const resp = await fetch(`http://localhost:${PORT}/json/list`);
const targets = (await resp.json()).filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
for (const t of targets) {
  let client;
  try {
    client = await CDP({ port: PORT, target: t.id });
    await client.Runtime.enable();
    const r = await client.Runtime.evaluate({ returnByValue: true, expression: `
      (function(){
        var out = {};
        try {
          var api = window.TradingViewApi, svc = api._saveChartService;
          out.symbols = api._chartWidgetCollection.getAll().map(function(c){ try { return c.model().mainSeries().symbol(); } catch(e){ return '?'; } });
          try { out.layoutId = svc.layoutId(); } catch(e){}
          try { out.hasChanges = svc.hasChanges(); } catch(e){ out.hasChangesErr = e.message; }
          try { var a = svc.autoSaveEnabled(); out.autoSave = (a && a.value) ? a.value() : a; } catch(e){ out.autoSaveErr = e.message; }
          try { out.saveKeys = Object.keys(svc).filter(function(k){ return /save|dirty|change|timer|interval/i.test(k); }); } catch(e){}
        } catch(e){ out.error = e.message; }
        return out;
      })()
    ` });
    console.log(t.id.slice(0,8), JSON.stringify(r.result?.value));
    await client.close();
  } catch (e) { console.log('err', e.message); if (client) { try { await client.close(); } catch {} } }
}
