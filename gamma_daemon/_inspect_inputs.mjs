// SOLO LECTURA. Lista los inputs reales del estudio CIARG con su id posicional
// (in_NN) y su valor actual, para verificar que el mapeo in_21..in_30 de index.js
// siga apuntando a los campos correctos tras cada cambio de version del Pine.
//
// Usa el chart widget ACTIVO (window.TradingViewApi._activeChartWidgetWV), igual
// que tv.js: los objetos de _chartWidgetCollection.getAll() NO exponen
// getAllStudies() -- solo tienen .model(). Ese fue el motivo de que la primera
// version de este inspector no encontrara nada.
//
// NO activa panes, NO escribe nada, NO relanza TradingView.
import CDP from 'chrome-remote-interface';

const CDP_PORT = Number(process.env.TV_CDP_PORT || 9223);

async function evalOn(client, expression) {
  const r = await client.Runtime.evaluate({ expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}

const resp = await fetch(`http://localhost:${CDP_PORT}/json/list`);
const targets = (await resp.json()).filter((t) => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));

console.log(`Targets con chart: ${targets.length}\n`);

for (const t of targets) {
  let client;
  try {
    client = await CDP({ port: CDP_PORT, target: t.id });
    await client.Runtime.enable();

    const data = await evalOn(client, `
      (function() {
        var out = { symbol: null, studies: [], error: null };
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          if (!chart) { out.error = 'sin chart activo'; return out; }
          try { out.symbol = chart.model().mainSeries().symbol(); } catch (e) {}
          var studies = chart.getAllStudies();
          out.todos = studies.map(function(s) { return s.name || s.title || '(sin nombre)'; });
          for (var s = 0; s < studies.length; s++) {
            var nm = studies[s].name || studies[s].title || '';
            if (!/CIARG/i.test(nm)) continue;
            var entry = { name: nm, inputs: [] };
            try {
              var st = chart.getStudyById(studies[s].id);
              var vals = st.getInputValues();
              for (var k = 0; k < vals.length; k++) {
                entry.inputs.push({ id: vals[k].id, value: vals[k].value });
              }
            } catch (e) { entry.inputsError = e.message; }
            out.studies.push(entry);
          }
        } catch (e) { out.error = e.message; }
        return out;
      })()
    `);

    if (!data || (data.error && !data.studies.length)) {
      await client.close();
      continue;
    }
    if (!data.studies.length) {
      console.log(`--- target ${t.id.slice(0, 8)} (symbol=${data.symbol}) sin CIARG. Estudios: ${JSON.stringify(data.todos)}`);
      await client.close();
      continue;
    }

    console.log(`=== target ${t.id.slice(0, 8)}  symbol=${data.symbol} ===`);
    for (const st of data.studies) {
      console.log(`  estudio: ${st.name}`);
      if (st.inputsError) { console.log(`    ERROR: ${st.inputsError}`); continue; }
      console.log(`    total inputs: ${st.inputs.length}`);
      for (const inp of st.inputs) {
        const m = /^in_(\d+)$/.exec(inp.id);
        const n = m ? Number(m[1]) : null;
        if (n !== null && n >= 18 && n <= 34) {
          console.log(`    ${inp.id.padEnd(7)} = ${JSON.stringify(inp.value)}`);
        }
      }
    }
    console.log('');
    await client.close();
  } catch (e) {
    console.log(`target ${t.id.slice(0, 8)}: ${e.message}`);
    if (client) { try { await client.close(); } catch {} }
  }
}
