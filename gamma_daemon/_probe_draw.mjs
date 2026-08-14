// SOLO LECTURA. Lista que metodos de dibujo expone el chart widget de la ventana
// SPCFD:SPX, para saber con que API crear/borrar lineas horizontales antes de
// tocar nada. NO dibuja, NO borra, NO activa panes.
import CDP from 'chrome-remote-interface';

const CDP_PORT = Number(process.env.TV_CDP_PORT || 9223);

async function evalOn(client, expression) {
  const r = await client.Runtime.evaluate({ expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}

const resp = await fetch(`http://localhost:${CDP_PORT}/json/list`);
const targets = (await resp.json()).filter((t) => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));

for (const t of targets) {
  let client;
  try {
    client = await CDP({ port: CDP_PORT, target: t.id });
    await client.Runtime.enable();

    const esSpx = await evalOn(client, `
      (function() {
        try {
          var all = window.TradingViewApi._chartWidgetCollection.getAll();
          return all.some(function(c) {
            try { return /^SPCFD:SPX$/i.test(c.model().mainSeries().symbol()); } catch (e) { return false; }
          });
        } catch (e) { return false; }
      })()
    `);
    if (!esSpx) { await client.close(); continue; }

    const info = await evalOn(client, `
      (function() {
        var out = { widgetMetodos: [], apiMetodos: [], shapesActuales: null };
        var api = window.TradingViewApi;
        try {
          var props = [];
          for (var k in api) props.push(k);
          out.apiMetodos = props.filter(function(k) { return /shape|draw|line|study/i.test(k); });
        } catch (e) {}
        try {
          var chart = api._activeChartWidgetWV.value();
          var props2 = [];
          var o = chart;
          while (o) {
            Object.getOwnPropertyNames(o).forEach(function(k) { if (props2.indexOf(k) < 0) props2.push(k); });
            o = Object.getPrototypeOf(o);
          }
          out.widgetMetodos = props2.filter(function(k) { return /shape|draw|line/i.test(k); });
          try { out.shapesActuales = chart.getAllShapes ? chart.getAllShapes().length : 'sin getAllShapes'; } catch (e) { out.shapesError = e.message; }
        } catch (e) { out.error = e.message; }
        return out;
      })()
    `);

    console.log(`=== ventana SPX: target ${t.id.slice(0, 8)} ===`);
    console.log(`  TradingViewApi.*  : ${JSON.stringify(info.apiMetodos)}`);
    console.log(`  chartWidget.*     : ${JSON.stringify(info.widgetMetodos)}`);
    console.log(`  shapes actuales   : ${JSON.stringify(info.shapesActuales)}`);
    if (info.shapesError) console.log(`  shapesError       : ${info.shapesError}`);
    if (info.error) console.log(`  error             : ${info.error}`);
    await client.close();
    break;
  } catch (e) {
    console.log(`target ${t.id.slice(0, 8)}: ${e.message}`);
    if (client) { try { await client.close(); } catch {} }
  }
}
