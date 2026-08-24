// Quita UNA instancia concreta de CIARG (por id) del pane indicado de la ventana
// SPCFD:SPX. Nace el 2026-08-24: al reaplicar el indicador a mano quedaron dos
// CIARG en el pane de 2m y divergieron — el daemon escribe solo en la primera que
// encuentra (eXjHUy) y la otra (TuQnC8) quedo congelada en los valores de las
// 09:35, dibujando un segundo gamma flip, un segundo call wall y un segundo MVS
// encima de los buenos.
//
// Peor que el sintoma: el orden de getAllStudies() no esta garantizado. Si tras un
// reinicio devuelve la congelada primero, el daemon pasa a escribir ahi y la que
// se ve bien se queda vieja, con tvFailures en 0 y sin un solo error.
//
// Apunta por ID EXACTO a proposito, no por "la segunda": si el orden cambia entre
// el diagnostico y la ejecucion, esto no borra la que no era.
//
//   node _quitar_ciarg_duplicado.mjs                 -> simulacro, no toca nada
//   node _quitar_ciarg_duplicado.mjs --aplicar       -> lo quita de verdad
import CDP from 'chrome-remote-interface';

const TV_PORT   = 9223;
const PANE      = 1;
const ID_QUITAR = process.env.ID_QUITAR || 'TuQnC8';
const APLICAR   = process.argv.includes('--aplicar');

const resp = await fetch(`http://localhost:${TV_PORT}/json/list`);
const targets = (await resp.json()).filter(
  (t) => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url)
);

let hecho = false;
for (const t of targets) {
  let client;
  try {
    client = await CDP({ port: TV_PORT, target: t.id });
    await client.Runtime.enable();
    const ev = async (e) => (await client.Runtime.evaluate({ expression: e, returnByValue: true })).result?.value;

    const panes = JSON.parse(await ev(`
      JSON.stringify(window.TradingViewApi._chartWidgetCollection.getAll().map(function(c,i){
        try { return {index:i, symbol:c.model().mainSeries().symbol(), tf:String(c.model().mainSeries().interval())}; }
        catch(e){ return {index:i, error:1}; }
      }))`));
    if (!panes.some((p) => /^SPCFD:SPX$/i.test(p.symbol || ''))) { await client.close(); continue; }

    const pane = panes.find((p) => p.index === PANE);
    console.log(`ventana ${t.id.slice(0,8)} — pane ${PANE} (${pane?.symbol}, tf ${pane?.tf})`);

    await ev(`(function(){ try{ window.TradingViewApi.setActiveChart(${PANE}); return 1;}catch(e){return 0;} })()`);
    await new Promise((r) => setTimeout(r, 350));

    const antes = JSON.parse(await ev(`
      (function(){
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var ss = chart.getAllStudies(), out = [];
        for (var i=0;i<ss.length;i++){
          var n = ss[i].name || ss[i].title || '';
          if (/CIARG_V\\d/i.test(n)) out.push(String(ss[i].id));
        }
        return JSON.stringify({ ciarg: out, metodos: ['removeEntity','removeStudy','remove'].filter(function(m){ return typeof chart[m] === 'function'; }) });
      })()`));
    console.log('  CIARG presentes :', antes.ciarg.join(', '));
    console.log('  metodos de la API:', antes.metodos.join(', ') || '(ninguno de los esperados)');

    if (!antes.ciarg.includes(ID_QUITAR)) {
      console.log(`  ${ID_QUITAR} ya no esta en este pane — nada que hacer.`);
      await client.close(); hecho = true; break;
    }
    if (antes.ciarg.length < 2) {
      console.log('  ABORTA: solo hay una instancia. No se quita la unica que dibuja.');
      await client.close(); hecho = true; break;
    }
    if (!APLICAR) {
      console.log(`\n  SIMULACRO — quitaria ${ID_QUITAR} y dejaria ${antes.ciarg.filter(x=>x!==ID_QUITAR).join(', ')}`);
      console.log('  Volve a correrlo con --aplicar para hacerlo de verdad.');
      await client.close(); hecho = true; break;
    }

    const res = await ev(`
      (function(){
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          if (typeof chart.removeEntity === 'function') { chart.removeEntity('${ID_QUITAR}'); return 'removeEntity'; }
          var ss = chart.getAllStudies();
          for (var i=0;i<ss.length;i++){
            if (String(ss[i].id) !== '${ID_QUITAR}') continue;
            var st = chart.getStudyById(ss[i].id);
            if (st && typeof st.remove === 'function') { st.remove(); return 'study.remove'; }
          }
          return 'sin metodo';
        } catch(e){ return 'ERROR ' + e.message; }
      })()`);
    console.log('  remocion via:', res);
    await new Promise((r) => setTimeout(r, 700));

    const despues = JSON.parse(await ev(`
      (function(){
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var ss = chart.getAllStudies(), out = [];
        for (var i=0;i<ss.length;i++){
          var n = ss[i].name || ss[i].title || '';
          if (/CIARG_V\\d/i.test(n)) out.push(String(ss[i].id));
        }
        return JSON.stringify(out);
      })()`));
    console.log('  CIARG despues   :', despues.join(', '));
    console.log(despues.includes(ID_QUITAR) ? '  >>> NO se quito' : '  >>> QUITADO OK');
    await client.close(); hecho = true; break;
  } catch (e) {
    console.error(`${t.id.slice(0,8)}: ERROR`, e.message);
    if (client) { try { await client.close(); } catch {} }
  }
}
if (!hecho) console.log('No se encontro la ventana SPCFD:SPX.');
