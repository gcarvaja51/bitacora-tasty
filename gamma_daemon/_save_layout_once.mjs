// Guarda UNA vez el layout de la ventana SPCFD:SPX (equivalente a Ctrl+S).
// Antes reporta si el autoguardado estaba activo y si habia cambios pendientes.
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

    const antes = await evalOn(client, `
      (function(){
        var svc = window.TradingViewApi._saveChartService, out = {};
        try { var a = svc.autoSaveEnabled(); out.autoSave = (a && a.value) ? a.value() : a; } catch(e){ out.autoSaveErr = e.message; }
        try { out.hasChanges = svc.hasChanges(); } catch(e){ out.hasChangesErr = e.message; }
        try { out.layoutId = svc.layoutId(); } catch(e){}
        return out;
      })()
    `);
    console.log('ANTES:', JSON.stringify(antes));

    const res = await evalOn(client, `
      (async function(){
        try {
          var svc = window.TradingViewApi._saveChartService;
          var r = await svc.saveChartSilently();
          return { ok: true, resultado: (r === undefined ? 'undefined' : String(r)) };
        } catch(e){ return { ok: false, error: e.message }; }
      })()
    `, true);
    console.log('GUARDADO:', JSON.stringify(res));

    const despues = await evalOn(client, `
      (function(){
        var svc = window.TradingViewApi._saveChartService, out = {};
        try { out.hasChanges = svc.hasChanges(); } catch(e){}
        return out;
      })()
    `);
    console.log('DESPUES:', JSON.stringify(despues));
    await client.close();
    break;
  } catch (e) { console.log('err', e.message); if (client) { try { await client.close(); } catch {} } }
}
