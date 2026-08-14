// SOLO LECTURA. Averigua, para cada ventana de TradingView Desktop: el nombre/id
// del layout cargado, el simbolo de cada pane, y que APIs de guardado expone la
// app. Sirve para decidir si el layout del celular es el mismo que el del PC.
// NO escribe, NO guarda, NO activa panes, NO relanza nada.
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

    const info = await evalOn(client, `
      (function() {
        var out = { titulo: document.title, url: location.href, layout: {}, panes: [], apisGuardado: [] };
        var api = window.TradingViewApi;
        if (!api) { out.error = 'sin TradingViewApi'; return out; }

        // Nombre / id del layout, probando los accesores conocidos
        var candidatos = ['layoutName', 'chartsLayoutName', 'getSavedChartName', 'name'];
        for (var i = 0; i < candidatos.length; i++) {
          var k = candidatos[i];
          try {
            if (typeof api[k] === 'function') out.layout[k] = api[k]();
            else if (api[k] != null) out.layout[k] = api[k];
          } catch (e) {}
        }
        try { if (api._chartWidgetCollection) {
          var col = api._chartWidgetCollection;
          ['layoutName', 'name', 'id', 'metaInfo'].forEach(function(k) {
            try {
              var v = col[k];
              if (typeof v === 'function') v = v.call(col);
              if (v && typeof v === 'object' && v.value) v = v.value();
              if (v != null && typeof v !== 'object') out.layout['collection.' + k] = v;
            } catch (e) {}
          });
        }} catch (e) {}

        // Simbolo por pane
        try {
          var all = api._chartWidgetCollection.getAll();
          out.panes = all.map(function(c, i) {
            var o = { index: i, symbol: null, resolution: null };
            try { o.symbol = c.model().mainSeries().symbol(); } catch (e) { o.symbolError = e.message; }
            try { o.resolution = c.model().mainSeries().interval(); } catch (e) {}
            return o;
          });
        } catch (e) { out.panesError = e.message; }

        // Que metodos de guardado existen (solo se listan, NO se llaman)
        try {
          var props = [];
          for (var k in api) { props.push(k); }
          out.apisGuardado = props.filter(function(k) { return /save|persist|store/i.test(k); });
        } catch (e) {}

        return out;
      })()
    `);

    console.log(`=== target ${t.id.slice(0, 8)} ===`);
    console.log(`  titulo : ${info.titulo}`);
    console.log(`  layout : ${JSON.stringify(info.layout)}`);
    console.log(`  panes  : ${JSON.stringify(info.panes)}`);
    console.log(`  save.. : ${JSON.stringify(info.apisGuardado)}`);
    if (info.error) console.log(`  error  : ${info.error}`);
    console.log('');
    await client.close();
  } catch (e) {
    console.log(`target ${t.id.slice(0, 8)}: ${e.message}\n`);
    if (client) { try { await client.close(); } catch {} }
  }
}
