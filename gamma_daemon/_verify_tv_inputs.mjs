// Verificacion de punta a punta: lee los inputs REALES que tiene ahora mismo el
// estudio CIARG en TradingView, para confirmar que el daemon efectivamente los
// esta escribiendo (no solo que "no dio error").
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
    if (!panes.some((p) => p.symbol && /^SPCFD:SPX$/i.test(p.symbol))) {
      console.log(`${t.id.slice(0,8)}: sin SPCFD:SPX (${panes.map(p=>p.symbol).join(', ')}) — se salta`);
      await client.close(); continue;
    }

    for (const p of panes) {
      if (p.error) continue;
      await ev(`(function(){ var w = window.TradingViewApi._chartWidgetCollection.getAll()[${p.index}]; if (w && w._mainDiv) w._mainDiv.click(); return true; })()`);
      await new Promise((r) => setTimeout(r, 300));
      const out = await ev(`
        (function(){
          try {
            var chart = window.TradingViewApi._activeChartWidgetWV.value();
            var studies = chart.getAllStudies();
            for (var i = 0; i < studies.length; i++) {
              var name = studies[i].name || studies[i].title || '';
              if (/CIARG_V\\d/i.test(name)) {
                var study = chart.getStudyById(studies[i].id);
                var vals = study.getInputValues();
                var wanted = ['in_20','in_21','in_22','in_23','in_24','in_25','in_27','in_29'];
                var res = { estudio: name };
                for (var j = 0; j < vals.length; j++) {
                  if (wanted.indexOf(vals[j].id) !== -1) res[vals[j].id] = vals[j].value;
                }
                return JSON.stringify(res);
              }
            }
            return JSON.stringify({ error: 'CIARG no encontrado' });
          } catch (e) { return JSON.stringify({ error: e.message }); }
        })()
      `);
      const v = JSON.parse(out);
      console.log(`\n${t.id.slice(0,8)} pane ${p.index} (${p.symbol}) — ${v.estudio || v.error}`);
      if (!v.error) {
        console.log(`  activado (in_20) : ${v.in_20}`);
        console.log(`  Call Wall (in_21): ${v.in_21}`);
        console.log(`  Put Wall  (in_22): ${v.in_22}`);
        console.log(`  Gamma Flip(in_23): ${v.in_23}`);
        console.log(`  MVS       (in_24): ${v.in_24}`);
        console.log(`  Net GEX   (in_25): ${v.in_25}`);
        console.log(`  Net DEX   (in_27): ${v.in_27}`);
        console.log(`  Net Vanna (in_29): ${v.in_29}`);
      }
    }
    await client.close();
  } catch (e) {
    console.error(`${t.id.slice(0,8)}: ERROR`, e.message);
    if (client) { try { await client.close(); } catch {} }
  }
}
