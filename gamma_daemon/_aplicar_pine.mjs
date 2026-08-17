import CDP from 'chrome-remote-interface';
import { getSource, setSource, getErrors } from './pine_edit.js';
import { readFileSync } from 'fs';
const PORT = 9223;
const nuevo = readFileSync('live_source.txt', 'utf8');
const resp = await fetch(`http://localhost:${PORT}/json/list`);
const targets = (await resp.json()).filter(t => t.type==='page' && /tradingview\.com\/chart/i.test(t.url));
for (const t of targets) {
  const client = await CDP({ port: PORT, target: t.id });
  await client.Runtime.enable();
  const ev = async e => (await client.Runtime.evaluate({ expression: e, returnByValue: true })).result?.value;
  if (!(await ev(`document.querySelector('.monaco-editor.pine-editor-monaco') !== null`))) { await client.close(); continue; }
  const antes = await getSource(client);
  console.log('editor encontrado en', t.id.slice(0,8), '| lineas antes:', antes.split('\n').length);
  await setSource(client, nuevo);
  await new Promise(r => setTimeout(r, 2500));
  const ahora = await getSource(client);
  console.log('lineas despues de escribir:', ahora.split('\n').length);
  console.log('coincide con lo que quise escribir:', ahora.trim() === nuevo.trim());
  const errs = await getErrors(client);
  console.log('ERRORES DE COMPILACION:', JSON.stringify(errs));
  await client.close();
  break;
}
