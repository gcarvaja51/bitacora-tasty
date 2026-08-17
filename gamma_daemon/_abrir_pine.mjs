import CDP from 'chrome-remote-interface';
import { getSource } from './pine_edit.js';
import { writeFileSync } from 'fs';
const PORT = 9223;
const MONACO_OK = `document.querySelector('.monaco-editor.pine-editor-monaco') !== null`;
const resp = await fetch(`http://localhost:${PORT}/json/list`);
const targets = (await resp.json()).filter(t => t.type==='page' && /tradingview\.com\/chart/i.test(t.url));
for (const t of targets) {
  const client = await CDP({ port: PORT, target: t.id });
  await client.Runtime.enable();
  const ev = async e => (await client.Runtime.evaluate({ expression: e, returnByValue: true })).result?.value;
  const sym = await ev(`window.TradingViewApi._chartWidgetCollection.getAll().map(function(c){try{return c.model().mainSeries().symbol()}catch(e){return '?'}}).join(',')`);
  if (!/SPCFD:SPX/i.test(sym||'')) { await client.close(); continue; }
  console.log('ventana SPX:', t.id.slice(0,8));
  console.log('estado inicial:', await ev(`(function(){var b=window.TradingView.bottomWidgetBar;
    return JSON.stringify({visible:b.isVisible&&String(b.isVisible()), activo:b.activeWidgetName&&String(b.activeWidgetName()), habilitados:JSON.stringify(b.enabledWidgets&&b.enabledWidgets()).slice(0,150)});})()`));
  console.log('paso show():', await ev(`(function(){try{window.TradingView.bottomWidgetBar.show();return 'ok'}catch(e){return 'err '+e.message}})()`));
  console.log('paso activateScriptEditorTab():', await ev(`(function(){try{window.TradingView.bottomWidgetBar.activateScriptEditorTab();return 'ok'}catch(e){return 'err '+e.message}})()`));
  let ready=false;
  for (let i=0;i<60;i++){ await new Promise(r=>setTimeout(r,400)); if (await ev(MONACO_OK)) { ready=true; break; } }
  console.log('Monaco cargado:', ready);
  console.log('estado final:', await ev(`(function(){var b=window.TradingView.bottomWidgetBar;
    return JSON.stringify({visible:String(b.isVisible()), activo:String(b.activeWidgetName())});})()`));
  if (ready) {
    try {
      const src = await getSource(client);
      writeFileSync('live_source.txt', src, 'utf8');
      const L = src.split('\n');
      console.log('FUENTE VIVA leida:', L.length, 'lineas -> gamma_daemon/live_source.txt');
      console.log('  ', L.find(l=>/indicator\(/.test(l))?.trim().slice(0,90) || '(sin indicator())');
    } catch(e){ console.log('error leyendo fuente:', e.message); }
  }
  await client.close(); break;
}
