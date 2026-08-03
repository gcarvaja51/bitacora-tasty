// Inspeccion puntual: que simbolo y que estudios tiene cada ventana/pane de
// TradingView ahora mismo. Replica exactamente la logica de tv.js
// (findStudyOnFocusedPane): hay que hacer click en el pane para activarlo y
// leer los estudios via _activeChartWidgetWV, no desde el widget del collection.
import CDP from 'chrome-remote-interface';

const resp = await fetch('http://localhost:9223/json/list');
const targets = (await resp.json()).filter(
  (t) => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url)
);
console.log('Ventanas de chart:', targets.length);

for (const t of targets) {
  const client = await CDP({ port: 9223, target: t.id });
  await client.Runtime.enable();

  const ev = async (expression) => {
    const r = await client.Runtime.evaluate({ expression, returnByValue: true });
    return r.result?.value;
  };

  const panes = await ev(`
    (function() {
      try {
        var all = window.TradingViewApi._chartWidgetCollection.getAll();
        return JSON.stringify(all.map(function(c, i) {
          try { return { index: i, symbol: c.model().mainSeries().symbol() }; }
          catch (e) { return { index: i, error: e.message }; }
        }));
      } catch(e) { return 'ERR: ' + e.message; }
    })()
  `);
  console.log('\n' + t.id.slice(0, 8), 'panes:', panes);

  const parsed = (() => { try { return JSON.parse(panes); } catch { return []; } })();
  for (const p of parsed) {
    if (p.error) continue;
    // activar el pane (mismo click que hace tv.js)
    await ev(`
      (function() {
        var all = window.TradingViewApi._chartWidgetCollection.getAll();
        var w = all[${p.index}];
        if (w && w._mainDiv) w._mainDiv.click();
        return true;
      })()
    `);
    await new Promise((r) => setTimeout(r, 300));
    const studies = await ev(`
      (function() {
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          return JSON.stringify(chart.getAllStudies().map(function(s){ return s.name || s.title || ''; }));
        } catch (e) { return 'ERR: ' + e.message; }
      })()
    `);
    console.log(`   pane ${p.index} (${p.symbol}) estudios:`, studies);
  }

  await client.close();
}
