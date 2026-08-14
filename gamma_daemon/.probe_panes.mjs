// Sonda de diagnostico: lista los panes reales de cada ventana de TradingView con
// su simbolo y resolucion, y cual quedo activo. Sirve para entender el error
// "se pidio el pane N (X) pero quedo activo el de Y" del daemon.
import CDP from 'chrome-remote-interface';

const P = 9223;
const EXPR = [
  'JSON.stringify((function(){',
  '  var api = window.TradingViewApi;',
  '  var all = api._chartWidgetCollection.getAll();',
  '  var act = null;',
  '  try { act = String(api._activeChartWidgetWV.value().resolution()); } catch(e) {}',
  '  return { activa: act, panes: all.map(function(w, i) {',
  '    var o = { i: i };',
  '    try { o.sym = w.model().mainSeries().symbol(); } catch(e) { o.sym = "?"; }',
  '    try { o.res = String(w.model().mainSeries().interval()); } catch(e) { o.res = "?"; }',
  '    return o;',
  '  })};',
  '})())',
].join('\n');

const targets = (await (await fetch('http://localhost:' + P + '/json/list')).json())
  .filter((t) => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));

for (const t of targets) {
  let c;
  try {
    c = await CDP({ port: P, target: t.id });
    await c.Runtime.enable();
    const r = await c.Runtime.evaluate({ expression: EXPR, returnByValue: true });
    const info = JSON.parse(r.result.value);
    console.log('\n' + t.id.slice(0, 8) + '  resolucion activa: ' + info.activa);
    info.panes.forEach((p) => console.log('   pane ' + p.i + ': ' + p.sym + '  res=' + p.res));
    await c.close();
  } catch (e) {
    console.log(t.id.slice(0, 8), 'ERROR', e.message);
    if (c) { try { await c.close(); } catch {} }
  }
}
