// SOLO LECTURA: hay alguna ventana con el editor Pine (Monaco) cargado?
import CDP from 'chrome-remote-interface';
const PORT = 9223;
const resp = await fetch(`http://localhost:${PORT}/json/list`);
const targets = (await resp.json()).filter(t => t.type==='page' && /tradingview\.com\/chart/i.test(t.url));
for (const t of targets) {
  const client = await CDP({ port: PORT, target: t.id });
  await client.Runtime.enable();
  const r = await client.Runtime.evaluate({ returnByValue: true, expression: `
    (function(){
      var sym=''; try { sym = window.TradingViewApi._chartWidgetCollection.getAll().map(function(c){try{return c.model().mainSeries().symbol()}catch(e){return '?'}}).join(','); } catch(e){}
      return { sym: sym, monaco: !!document.querySelector('.monaco-editor.pine-editor-monaco') };
    })()
  ` });
  const v = r.result?.value || {};
  console.log(`${t.id.slice(0,8)}  editorPine=${v.monaco ? 'SI' : 'no'}   ${v.sym}`);
  await client.close();
}
