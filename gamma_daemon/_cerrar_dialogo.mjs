// Cierra un dialogo modal que haya quedado abierto en una ventana de TradingView.
// Uso: node _cerrar_dialogo.mjs <regexSimbolo>
import CDP from 'chrome-remote-interface';
const CDP_PORT = 9223;
const simRe = process.argv[2] || '.';

const resp = await fetch(`http://localhost:${CDP_PORT}/json/list`);
const targets = (await resp.json()).filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));

for (const t of targets) {
  const client = await CDP({ port: CDP_PORT, target: t.id });
  await client.Runtime.enable();
  try { await client.Input.enable(); } catch {}
  const ev = async (e) => {
    const r = await client.Runtime.evaluate({ expression: e, returnByValue: true });
    return r.result?.value;
  };

  const sym = await ev(`(function(){try{return window.TradingViewApi._chartWidgetCollection.getAll().map(function(c){try{return c.model().mainSeries().symbol();}catch(e){return '?';}}).join(',');}catch(e){return '';}})()`);
  if (!new RegExp(simRe, 'i').test(sym || '')) { await client.close(); continue; }

  const hay = await ev(`!!document.querySelector('[data-dialog-name], [class*=dialog][role=dialog]')`);
  if (!hay) { console.log(`${t.id.slice(0,8)} (${sym}): sin dialogo abierto`); await client.close(); continue; }

  const r1 = await ev(`
    (function(){
      var d = document.querySelector('[data-dialog-name], [class*=dialog][role=dialog]');
      if (!d) return 'sin dialogo';
      var btn = d.querySelector('[data-name="close"], button[aria-label*="lose"], button[aria-label*="errar"], span[data-name="close"]');
      if (btn) { btn.click(); return 'click en cerrar'; }
      var cancel = [].slice.call(d.querySelectorAll('button')).filter(function(b){ return /cancel|cancelar/i.test(b.textContent); })[0];
      if (cancel) { cancel.click(); return 'click en cancelar'; }
      return 'sin boton; botones=' + [].slice.call(d.querySelectorAll('button')).map(function(b){ return b.textContent.trim(); }).join('|');
    })()
  `);
  console.log(`${t.id.slice(0,8)} (${sym}) -> ${r1}`);

  try {
    await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await client.Input.dispatchKeyEvent({ type: 'keyUp',   key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  } catch (e) { console.log('  (Escape por CDP fallo:', e.message, ')'); }

  await new Promise(r => setTimeout(r, 1500));
  const fin = await ev(`(function(){ return { modal: !!document.querySelector('[data-dialog-name], [class*=dialog][role=dialog]'), layout: window.TradingViewApi.layoutName() }; })()`);
  console.log('  estado final:', JSON.stringify(fin));
  await client.close();
}
