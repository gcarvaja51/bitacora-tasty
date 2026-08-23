// Abre el editor Pine en la ventana SPX y CARGA el script CIARG que esta en el
// chart, luego vuelca su fuente a live_source.txt.
//
// Por que no basta activateScriptEditorTab() (que era lo que hacia antes):
// el 2026-08-22 esa llamada devolvia "ok" pero el editor abria EN BLANCO, y
// getSource() daba 0 caracteres. Faltaban dos cosas que TradingView cambio:
//   1. setWidgetAvailability('scripteditor', true) -- sin esto el widget nunca
//      se inicializa (enabledWidgets() sale {}) y Monaco no llega a montarse.
//   2. facade.openScript({scriptIdPart: <pineId>}) -- activar la pestaña abre
//      un documento vacio; hay que pedir explicitamente el script del estudio.
// El pineId NO se escribe a mano: se lee del propio estudio del chart, asi que
// esto sigue funcionando si el script se renombra o se recrea.
//
// Escribir y guardar van aparte: _aplicar_pine.mjs y _guardar_pine.mjs.
import CDP from 'chrome-remote-interface';
import { getSource } from './pine_edit.js';
import { writeFileSync } from 'fs';

const PORT = Number(process.env.TV_CDP_PORT || 9223);
const MONACO = `document.querySelector('.monaco-editor.pine-editor-monaco') !== null`;

const resp = await fetch(`http://localhost:${PORT}/json/list`);
const targets = (await resp.json()).filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));

for (const t of targets) {
  const client = await CDP({ port: PORT, target: t.id });
  await client.Runtime.enable();
  const ev = async (e, aw = false) => {
    const r = await client.Runtime.evaluate({ expression: e, returnByValue: true, awaitPromise: aw });
    return r.exceptionDetails ? 'EXC ' + (r.exceptionDetails.exception?.description || '').split('\n')[0] : r.result?.value;
  };

  const sym = await ev(`(function(){try{return window.TradingViewApi._chartWidgetCollection.getAll()
    .map(function(c){return c.model().mainSeries().symbol()}).join(',')}catch(e){return '?'}})()`);
  if (!/SPCFD:SPX/i.test(sym || '')) { await client.close(); continue; }
  console.log('ventana SPX:', t.id.slice(0, 8));

  // pineId del estudio CIARG que esta puesto en el chart
  const pineId = await ev(`(function(){
    var ch = window.TradingViewApi._activeChartWidgetWV.value();
    var ss = ch.getAllStudies();
    for (var i=0;i<ss.length;i++){
      if(!/CIARG/i.test(ss[i].name||'')) continue;
      var v = ch.getStudyById(ss[i].id).getInputValues();
      for (var k=0;k<v.length;k++) if (v[k].id==='pineId') return v[k].value;
    }
    return null; })()`);
  if (!pineId) { console.log('  no encontre el estudio CIARG en este chart'); await client.close(); continue; }
  console.log('  pineId:', pineId);

  const B = `window.TradingView.bottomWidgetBar`;
  await ev(`${B}.waitForWidgetsInitialized().then(function(){return 'ok'})`, true);
  await ev(`${B}.setWidgetAvailability('scripteditor', true)`);
  await ev(`${B}.showWidget('scripteditor')`);
  await ev(`${B}.activateWidget('scripteditor')`);

  let listo = false;
  for (let i = 0; i < 60 && !listo; i++) { await new Promise(r => setTimeout(r, 400)); listo = await ev(MONACO); }
  console.log('  Monaco montado:', listo);
  if (!listo) { await client.close(); process.exit(1); }

  const F = `${B}.getWidgetByName('scripteditor').getFacade()`;
  console.log('  openScript:', await ev(`${F}.openScript({scriptIdPart:${JSON.stringify(pineId)}})
    .then(function(){return 'ok'},function(e){return 'rechazo: '+(e&&e.message)})`, true));

  let src = '';
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    src = await getSource(client);
    if (src.length > 100) break;
  }
  if (src.length <= 100) { console.log('  el editor quedo vacio'); await client.close(); process.exit(1); }

  console.log('  version cargada:', await ev(`JSON.stringify(${F}.getScriptIdVersion())`));
  writeFileSync('live_source.txt', src, 'utf8');
  console.log('  FUENTE VIVA ->', src.split('\n').length, 'lineas en gamma_daemon/live_source.txt');
  console.log('  ', (src.split('\n').find(l => /indicator\(/.test(l)) || '(sin indicator())').trim().slice(0, 90));
  await client.close();
  break;
}
