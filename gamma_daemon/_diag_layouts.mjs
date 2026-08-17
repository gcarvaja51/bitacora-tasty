// SOLO LECTURA: lista los layouts guardados via TradingViewApi.getSavedCharts()
import CDP from 'chrome-remote-interface';
const PORT = Number(process.env.TV_CDP_PORT || 9223);
const resp = await fetch(`http://localhost:${PORT}/json/list`);
const targets = (await resp.json()).filter(t => t.type==='page' && /tradingview\.com\/chart/i.test(t.url));
const client = await CDP({ port: PORT, target: targets[0].id });
await client.Runtime.enable();
const r = await client.Runtime.evaluate({ returnByValue: true, awaitPromise: true, expression: `
  new Promise(function(resolve){
    try {
      window.TradingViewApi.getSavedCharts(function(charts){
        if (!charts || !Array.isArray(charts)) { resolve({error:'getSavedCharts sin datos'}); return; }
        resolve(charts.map(function(c){ return {
          id: c.id || c.chartId || null,
          name: c.name || c.title || '(sin nombre)',
          symbol: c.symbol || null,
          modified: c.timestamp || c.modified || null
        };}));
      });
      setTimeout(function(){ resolve({error:'timeout'}); }, 8000);
    } catch(e){ resolve({error:e.message}); }
  })
` });
const v = r.result?.value;
if (Array.isArray(v)) {
  console.log(`LAYOUTS EN LA CUENTA: ${v.length}`);
  for (const l of v) {
    const d = String(l.modified ?? "?");
    console.log(`  ${String(l.id).padEnd(12)} ${String(l.name).padEnd(28)} ${String(l.symbol||'').padEnd(16)} mod:${d}`);
  }
} else console.log(JSON.stringify(v));
await client.close();
