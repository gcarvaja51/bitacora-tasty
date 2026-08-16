// Crea un layout NUEVO a partir de la ventana cuyo simbolo coincida, manejando el
// dialogo "Guardar como" por codigo. NO borra nada: saveChartAs crea una copia.
// Uso: node _save_as_layout.mjs <regexSimbolo> <nombreNuevo>
import CDP from 'chrome-remote-interface';
const CDP_PORT = 9223;
const [ , , simRe, nombre ] = process.argv;
if (!simRe || !nombre) { console.log('uso: node _save_as_layout.mjs <regexSimbolo> <nombre>'); process.exit(1); }

const resp = await fetch(`http://localhost:${CDP_PORT}/json/list`);
const targets = (await resp.json()).filter(t => t.type==='page' && /tradingview\.com\/chart/i.test(t.url));

for (const t of targets) {
  const client = await CDP({ port: CDP_PORT, target: t.id });
  await client.Runtime.enable();
  const ev = async (e, aw=false) => {
    const r = await client.Runtime.evaluate({ expression: e, returnByValue: true, awaitPromise: aw });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  const sym = await ev(`(function(){try{return window.TradingViewApi._chartWidgetCollection.getAll().map(function(c){try{return c.model().mainSeries().symbol();}catch(e){return '?';}}).join(',');}catch(e){return '';}})()`);
  if (!new RegExp(simRe, 'i').test(sym || '')) { await client.close(); continue; }

  const antes = await ev(`(function(){var a=window.TradingViewApi; return {name:a.layoutName(), id:a._saveChartService.layoutId()};})()`);
  console.log(`ventana ${t.id.slice(0,8)} | simbolos=${sym} | layout actual=${JSON.stringify(antes)}`);

  await ev(`window.TradingViewApi._saveChartService.saveChartAs(); 'ok'`);
  await new Promise(r => setTimeout(r, 1800));

  const res = await ev(`
    (function(){
      var inputs = [...document.querySelectorAll('input[type="text"], input:not([type])')]
        .filter(function(i){ return i.offsetParent !== null; });
      if (!inputs.length) return { ok:false, error:'no aparecio el campo de nombre' };
      var inp = inputs[inputs.length-1];
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(inp, ${JSON.stringify(nombre)});
      inp.dispatchEvent(new Event('input', {bubbles:true}));
      inp.dispatchEvent(new Event('change', {bubbles:true}));
      var btns = [...document.querySelectorAll('button')].filter(function(b){ return b.offsetParent !== null; });
      var save = btns.find(function(b){ return /^(save|guardar)$/i.test(b.textContent.trim()); });
      if (!save) return { ok:false, error:'no aparecio el boton Guardar', botones: btns.map(function(b){return b.textContent.trim();}).slice(0,12) };
      save.click();
      return { ok:true };
    })()
  `);
  console.log('dialogo:', JSON.stringify(res));

  if (!res.ok) {
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 'escape'`);
    console.log('-> dialogo cerrado con Escape, no se cambio nada');
    await client.close();
    process.exit(2);
  }

  await new Promise(r => setTimeout(r, 3000));
  const despues = await ev(`(function(){var a=window.TradingViewApi; return {name:a.layoutName(), id:a._saveChartService.layoutId(), url:location.href};})()`);
  console.log('layout despues =', JSON.stringify(despues));
  await client.close();
  process.exit(0);
}
console.log('no encontre ninguna ventana con ese simbolo');
