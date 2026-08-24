// SOLO LECTURA. Para cada instancia de CIARG: si esta visible, si tiene error de
// compilacion, y cuantas lineas/labels esta dibujando realmente. Responde la
// pregunta "el dato esta pero no se pinta". No escribe nada.
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
    console.log(`\n===== ventana ${t.id.slice(0, 8)}  [${panes.map(p => p.symbol).join(', ')}]`);

    for (const p of panes) {
      if (p.error) continue;
      await ev(`(function(){ var w = window.TradingViewApi._chartWidgetCollection.getAll()[${p.index}]; if (w && w._mainDiv) w._mainDiv.click(); return true; })()`);
      await new Promise((r) => setTimeout(r, 300));
      const out = await ev(`
        (function(){
          try {
            var wid = window.TradingViewApi._chartWidgetCollection.getAll()[${p.index}];
            var model = wid.model();
            var srcs = model.model ? model.model().dataSources() : model.dataSources();
            var res = [];
            for (var i = 0; i < srcs.length; i++) {
              var s = srcs[i];
              var title = '';
              try { title = s.title ? String(s.title(true)) : ''; } catch (e) {}
              if (!/CIARG/i.test(title)) continue;
              var o = { titulo: title.slice(0, 46) };
              try { o.visible = s.properties().visible.value(); } catch (e) { o.visible = 'n/d'; }
              try { var st = s.status && s.status(); o.status = st ? String(st) : 'ok'; } catch (e) {}
              try { o.error = s.hasError ? !!s.hasError() : false; } catch (e) {}
              // cuantas primitivas dibuja (lineas/labels de Pine)
              try {
                var pr = 0;
                if (s.getPriceAxisViews) pr = s.getPriceAxisViews().length;
                o.ejesPrecio = pr;
              } catch (e) {}
              try { o.graficos = s.graphicsCount ? s.graphicsCount() : (s._graphics ? Object.keys(s._graphics).length : 'n/d'); } catch (e) {}
              res.push(o);
            }
            return JSON.stringify(res);
          } catch (e) { return JSON.stringify([{ error: e.message }]); }
        })()
      `);
      const arr = JSON.parse(out);
      console.log(`  pane ${p.index} (${p.symbol}):`);
      if (!arr.length) console.log('     (ninguna instancia de CIARG encontrada por dataSources)');
      arr.forEach((v, n) => {
        if (v.error) { console.log(`     [${n}] ERROR ${v.error}`); return; }
        const alerta = v.visible === false ? '   <<< OCULTO' : (v.error ? '   <<< CON ERROR' : '');
        console.log(`     [${n}] visible=${v.visible} error=${v.error} status=${v.status} ejesPrecio=${v.ejesPrecio}${alerta}`);
        console.log(`         ${v.titulo}`);
      });
    }
    await client.close();
  } catch (e) {
    console.error(`${t.id.slice(0, 8)}: ERROR`, e.message);
    if (client) { try { await client.close(); } catch {} }
  }
}
