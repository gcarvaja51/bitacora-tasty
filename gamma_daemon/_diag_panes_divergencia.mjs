// SOLO LECTURA. Para la ventana SPCFD:SPX: temporalidad de cada pane y los muros
// de CADA instancia de CIARG que tenga (no solo la primera). Sirve para ver si
// dos instancias en el mismo pane divergieron — el daemon escribe solo en la
// primera que encuentra y la otra queda congelada.
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
        try {
          return { index:i, symbol:c.model().mainSeries().symbol(),
                   tf: String(c.model().mainSeries().interval()) };
        } catch(e){ return {index:i, error:1}; }
      }))`));
    if (!panes.some((p) => /^SPCFD:SPX$/i.test(p.symbol || ''))) { await client.close(); continue; }

    console.log(`\n=== ventana ${t.id.slice(0,8)} (SPCFD:SPX)  ${new Date().toISOString()}`);
    for (const p of panes) {
      if (p.error) continue;
      // setActiveChart, el mecanismo propio de TV (mismo que usa tv.js)
      await ev(`(function(){ try{ window.TradingViewApi.setActiveChart(${p.index}); return 1;}catch(e){return 0;} })()`);
      await new Promise((r) => setTimeout(r, 350));
      const out = await ev(`
        (function(){
          try {
            var chart = window.TradingViewApi._activeChartWidgetWV.value();
            var studies = chart.getAllStudies();
            var res = [];
            for (var i=0;i<studies.length;i++){
              var name = studies[i].name || studies[i].title || '';
              if (!/CIARG_V\\d/i.test(name)) continue;
              var vals = chart.getStudyById(studies[i].id).getInputValues();
              var o = { id:String(studies[i].id) };
              for (var j=0;j<vals.length;j++){
                if (['in_21','in_22','in_23','in_24','in_25','in_31'].indexOf(vals[j].id)!==-1) o[vals[j].id]=vals[j].value;
              }
              res.push(o);
            }
            return JSON.stringify(res);
          } catch(e){ return JSON.stringify([{error:e.message}]); }
        })()`);
      const arr = JSON.parse(out);
      console.log(`\n  pane ${p.index}  timeframe ${p.tf}  -> ${arr.length} instancia(s) de CIARG`);
      arr.forEach((v, n) => {
        if (v.error) { console.log(`     [${n}] ERROR ${v.error}`); return; }
        console.log(`     [${n}] id=${v.id}  callWall=${v.in_21}  putWall=${v.in_22}  flip=${v.in_23}  mvs=${v.in_24}  maxPain=${v.in_31}  gex=${v.in_25}`);
      });
      if (arr.length > 1) {
        const dif = ['in_21','in_22','in_23','in_24','in_31'].filter((k) => new Set(arr.map((a) => a[k])).size > 1);
        console.log(dif.length
          ? `     >>> LAS INSTANCIAS DIVERGEN en: ${dif.join(', ')}`
          : `     >>> duplicado presente pero todavia con los mismos valores`);
      }
    }
    await client.close();
    break;
  } catch (e) {
    console.error(`${t.id.slice(0,8)}: ERROR`, e.message);
    if (client) { try { await client.close(); } catch {} }
  }
}
