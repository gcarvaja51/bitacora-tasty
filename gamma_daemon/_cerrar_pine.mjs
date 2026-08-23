// Cierra el editor Pine y devuelve el chart como estaba. Correr SIEMPRE al
// terminar de editar: el daemon guarda el layout en la nube cada ~5 min y con el
// editor abierto ese estado tambien viajaria al celular.
import CDP from 'chrome-remote-interface';
const PORT = Number(process.env.TV_CDP_PORT || 9223);
const resp = await fetch(`http://localhost:${PORT}/json/list`);
for (const t of (await resp.json()).filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))) {
  const client = await CDP({ port: PORT, target: t.id });
  await client.Runtime.enable();
  const ev = async e => {
    const r = await client.Runtime.evaluate({ expression: e, returnByValue: true });
    return r.exceptionDetails ? 'EXC ' + (r.exceptionDetails.exception?.description || '').split('\n')[0] : r.result?.value;
  };
  if (!(await ev(`document.querySelector('.monaco-editor.pine-editor-monaco') !== null`))) { await client.close(); continue; }
  const B = `window.TradingView.bottomWidgetBar`;
  const sucio = await ev(`String(${B}.getWidgetByName('scripteditor').getFacade().isModified())`);
  if (sucio === 'true') {
    console.error('OJO: el editor tiene cambios SIN GUARDAR. No se cierra.');
    await client.close(); process.exit(1);
  }
  await ev(`${B}.hide()`);
  await ev(`${B}.setWidgetAvailability('scripteditor', false)`);
  await new Promise(r => setTimeout(r, 1500));
  console.log('editor cerrado | barra visible:', await ev(`String(${B}.isVisible().value())`));
  await client.close();
  break;
}
