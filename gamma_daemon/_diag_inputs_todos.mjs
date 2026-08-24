// SOLO LECTURA. Vuelca TODOS los inputs del CIARG de la ventana SPCFD:SPX, no
// solo los ocho que empuja el daemon. Sirve para encontrar interruptores de
// dibujo que se hayan reseteado al reaplicar el indicador a mano.
import CDP from 'chrome-remote-interface';

const TV_PORT = 9223;
const resp = await fetch(`http://localhost:${TV_PORT}/json/list`);
const targets = (await resp.json()).filter(
  (t) => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url)
);

for (const t of targets) {
  let client;
  try {
    client = await CDP({ port: TV_PORT, target: t.id });
    await client.Runtime.enable();
    const ev = async (e) => (await client.Runtime.evaluate({ expression: e, returnByValue: true })).result?.value;

    const panes = JSON.parse(await ev(`
      JSON.stringify(window.TradingViewApi._chartWidgetCollection.getAll().map(function(c,i){
        try { return {index:i, symbol:c.model().mainSeries().symbol()}; } catch(e){ return {index:i,error:1}; }
      }))`));
    if (!panes.some((p) => /^SPCFD:SPX$/i.test(p.symbol || ''))) { await client.close(); continue; }

    await ev(`(function(){var w=window.TradingViewApi._chartWidgetCollection.getAll()[0]; if(w&&w._mainDiv)w._mainDiv.click(); return 1;})()`);
    await new Promise((r) => setTimeout(r, 300));

    const out = await ev(`
      (function(){
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          var studies = chart.getAllStudies();
          for (var i=0;i<studies.length;i++){
            var name = studies[i].name || studies[i].title || '';
            if (!/CIARG_V\\d/i.test(name)) continue;
            var vals = chart.getStudyById(studies[i].id).getInputValues();
            return JSON.stringify(vals.map(function(v){ return {id:v.id, value:v.value}; }));
          }
          return JSON.stringify([]);
        } catch(e){ return JSON.stringify([{id:'ERROR', value:e.message}]); }
      })()`);

    const vals = JSON.parse(out);
    console.log(`\n=== ventana ${t.id.slice(0,8)} pane 0 (SPCFD:SPX) — ${vals.length} inputs\n`);
    const bools = vals.filter((v) => typeof v.value === 'boolean');
    console.log('--- INTERRUPTORES (booleanos) ---');
    bools.forEach((v) => console.log(`   ${v.id.padEnd(8)} = ${v.value}${v.value === false ? '   <<< APAGADO' : ''}`));
    console.log('\n--- el resto ---');
    vals.filter((v) => typeof v.value !== 'boolean')
        .forEach((v) => console.log(`   ${v.id.padEnd(8)} = ${JSON.stringify(v.value).slice(0, 60)}`));
    await client.close();
    break;
  } catch (e) {
    console.error(`${t.id.slice(0,8)}: ERROR`, e.message);
    if (client) { try { await client.close(); } catch {} }
  }
}
