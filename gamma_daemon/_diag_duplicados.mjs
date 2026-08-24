// SOLO LECTURA. Lista TODAS las instancias de CIARG en cada pane de cada ventana
// (no solo la primera, que es lo que devuelve tv.js/findStudyOnPane) con sus
// muros, para detectar instancias duplicadas que quedan sin datos y tapan a la
// que si los recibe. No escribe nada ni cambia foco de simbolo.
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
    const ev = async (expression) => {
      const r = await client.Runtime.evaluate({ expression, returnByValue: true });
      return r.result?.value;
    };

    const panes = JSON.parse(await ev(`
      JSON.stringify(window.TradingViewApi._chartWidgetCollection.getAll().map(function(c, i) {
        try { return { index: i, symbol: c.model().mainSeries().symbol() }; } catch(e) { return { index: i, error: e.message }; }
      }))
    `));

    const nombre = panes.map((p) => p.symbol).join(', ');
    console.log(`\n===== ventana ${t.id.slice(0, 8)}  [${nombre}]`);

    for (const p of panes) {
      if (p.error) continue;
      await ev(`(function(){ var w = window.TradingViewApi._chartWidgetCollection.getAll()[${p.index}]; if (w && w._mainDiv) w._mainDiv.click(); return true; })()`);
      await new Promise((r) => setTimeout(r, 300));
      const out = await ev(`
        (function(){
          try {
            var chart = window.TradingViewApi._activeChartWidgetWV.value();
            var studies = chart.getAllStudies();
            var res = [];
            for (var i = 0; i < studies.length; i++) {
              var name = studies[i].name || studies[i].title || '';
              if (!/CIARG_V\\d/i.test(name)) continue;
              var vals = window.TradingViewApi._activeChartWidgetWV.value()
                           .getStudyById(studies[i].id).getInputValues();
              var o = { orden: i, id: String(studies[i].id) };
              for (var j = 0; j < vals.length; j++) {
                if (['in_20','in_21','in_22','in_23'].indexOf(vals[j].id) !== -1) o[vals[j].id] = vals[j].value;
              }
              res.push(o);
            }
            return JSON.stringify(res);
          } catch (e) { return JSON.stringify([{ error: e.message }]); }
        })()
      `);
      const arr = JSON.parse(out);
      console.log(`  pane ${p.index} (${p.symbol}) -> ${arr.length} instancia(s) de CIARG`);
      arr.forEach((v, n) => {
        if (v.error) { console.log(`     [${n}] ERROR ${v.error}`); return; }
        const vacio = !v.in_21 || !v.in_22;
        console.log(`     [${n}] id=${v.id} activado=${v.in_20} callWall=${v.in_21} putWall=${v.in_22} flip=${v.in_23}` +
                    (vacio ? '   <<< SIN MUROS' : ''));
      });
    }
    await client.close();
  } catch (e) {
    console.error(`${t.id.slice(0, 8)}: ERROR`, e.message);
    if (client) { try { await client.close(); } catch {} }
  }
}
