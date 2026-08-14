// Restaura SPCFD:SPX en las ventanas que quedaron con otro ticker de SPX.
// El daemon exige match exacto /^SPCFD:SPX$/i (tv.js:17); con SP_DLY:SPX no
// encuentra ninguna ventana valida, entra al catch de pushToTradingViewWithRetry
// y hace taskkill + relaunch en cada ciclo.
import CDP from 'chrome-remote-interface';

const PORT = 9223;
const DESTINO = 'SPCFD:SPX';
const CAMBIAR_DESDE = /^SP_DLY:SPX$/i;   // solo estas; no se tocan BE ni VANTAGE

const resp = await fetch(`http://localhost:${PORT}/json/list`);
const targets = (await resp.json()).filter(
  (t) => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url)
);

for (const t of targets) {
  const client = await CDP({ port: PORT, target: t.id });
  await client.Runtime.enable();
  const ev = async (expression) => {
    const r = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
    return r.result?.value;
  };

  const antes = await ev(`
    (function(){
      try {
        return JSON.stringify(window.TradingViewApi._chartWidgetCollection.getAll()
          .map(function(c){ return c.model().mainSeries().symbol(); }));
      } catch(e){ return 'ERR:'+e.message; }
    })()
  `);

  let syms = [];
  try { syms = JSON.parse(antes); } catch { }
  const hayQueCambiar = syms.some((s) => CAMBIAR_DESDE.test(s));

  if (!hayQueCambiar) {
    console.log(`${t.id.slice(0, 8)}  ${antes}  -> sin cambios`);
    await client.close();
    continue;
  }

  const res = await ev(`
    (function(){
      try {
        var n = 0;
        window.TradingViewApi._chartWidgetCollection.getAll().forEach(function(c){
          var s = c.model().mainSeries().symbol();
          if (/^SP_DLY:SPX$/i.test(s)) { c.setSymbol('${DESTINO}'); n++; }
        });
        return 'cambiados ' + n + ' pane(s)';
      } catch(e){ return 'ERR:'+e.message; }
    })()
  `);
  console.log(`${t.id.slice(0, 8)}  ${antes}  -> ${res}`);
  await client.close();
}

// verificacion
await new Promise((r) => setTimeout(r, 4000));
console.log('\n--- verificacion ---');
const r2 = await fetch(`http://localhost:${PORT}/json/list`);
const t2 = (await r2.json()).filter((t) => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
let ok = 0;
for (const t of t2) {
  const client = await CDP({ port: PORT, target: t.id });
  await client.Runtime.enable();
  const r = await client.Runtime.evaluate({
    expression: `JSON.stringify(window.TradingViewApi._chartWidgetCollection.getAll().map(function(c){return c.model().mainSeries().symbol();}))`,
    returnByValue: true,
  });
  const v = r.result?.value;
  if (/SPCFD:SPX/i.test(v || '')) ok++;
  console.log(`${t.id.slice(0, 8)}  ${v}`);
  await client.close();
}
console.log(`\nVentanas que el daemon reconocera como SPX: ${ok}`);
