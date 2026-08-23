// Guarda el script que esta abierto en el editor Pine y verifica que el estudio
// del chart quede en la version nueva.
//
// Orden que importa: PRIMERO se guarda el Pine, DESPUES se empuja el input
// nuevo desde index.js. Los ids son posicionales (in_NN) y un input que todavia
// no existe en el estudio no se puede escribir.
//
// Aborta si el compilador devuelve errores (los warnings de severidad 4 --
// "v5 outdated", "transp deprecated" -- son preexistentes y no bloquean).
import CDP from 'chrome-remote-interface';

const PORT = Number(process.env.TV_CDP_PORT || 9223);
const resp = await fetch(`http://localhost:${PORT}/json/list`);
const targets = (await resp.json()).filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));

for (const t of targets) {
  const client = await CDP({ port: PORT, target: t.id });
  await client.Runtime.enable();
  const ev = async (e, aw = false) => {
    const r = await client.Runtime.evaluate({ expression: e, returnByValue: true, awaitPromise: aw });
    return r.exceptionDetails ? 'EXC ' + (r.exceptionDetails.exception?.description || '').split('\n')[0] : r.result?.value;
  };
  if (!(await ev(`document.querySelector('.monaco-editor.pine-editor-monaco') !== null`))) { await client.close(); continue; }

  const F = `window.TradingView.bottomWidgetBar.getWidgetByName('scripteditor').getFacade()`;
  console.log('ventana:', t.id.slice(0, 8), '| antes:', await ev(`JSON.stringify(${F}.getScriptIdVersion())`));
  if (!(await ev(`String(${F}.isModified())`)) || (await ev(`String(${F}.isModified())`)) === 'false') {
    console.log('el editor no tiene cambios sin guardar — nada que hacer');
    await client.close(); process.exit(0);
  }

  const raw = await ev(`${F}.saveScript().then(
    function(x){return JSON.stringify({ok:true,errores:(x&&x.compileErrors&&x.compileErrors.errors)||[]})},
    function(e){return JSON.stringify({ok:false,error:e&&e.message})})`, true);
  const r = JSON.parse(raw);
  if (!r.ok) { console.error('FALLO al guardar:', r.error); await client.close(); process.exit(1); }
  if (r.errores.length) {
    console.error('ERRORES DE COMPILACION — no se aplico:', JSON.stringify(r.errores));
    await client.close(); process.exit(1);
  }
  console.log('guardado sin errores de compilacion');

  await new Promise(r => setTimeout(r, 3000));
  console.log('version del script:', await ev(`JSON.stringify(${F}.getScriptIdVersion())`));
  console.log('estudio en el chart:', await ev(`(function(){
    var ch = window.TradingViewApi._activeChartWidgetWV.value();
    var ss = ch.getAllStudies();
    for (var i=0;i<ss.length;i++){
      if(!/CIARG/i.test(ss[i].name||'')) continue;
      var v = ch.getStudyById(ss[i].id).getInputValues(), o = {};
      v.forEach(function(x){ if(x.id==='pineVersion') o.version = x.value; });
      o.inputs = v.filter(function(x){ return /^in_[0-9]+$/.test(x.id) }).length;
      o.ultimo = v.filter(function(x){ return /^in_[0-9]+$/.test(x.id) }).pop().id;
      return JSON.stringify(o);
    } return 'sin CIARG'; })()`));
  await client.close();
  break;
}
