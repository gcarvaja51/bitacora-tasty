// Salvavidas para el gotcha #9 del CLAUDE.md: al aplicar un cambio de codigo,
// TradingView RESETEA todos los inputs a 0. Como los muros solo se dibujan si
// call_wall_G > 0, el grafico se queda sin muros hasta el siguiente push — y con
// el mercado cerrado eso son dias en blanco. Es lo que paso hace un mes.
//
//   node inputs_dump_restore.mjs dump      -> guarda los in_NN a _inputs_backup.json
//   node inputs_dump_restore.mjs restore   -> los vuelve a escribir en el chart
//   node inputs_dump_restore.mjs check     -> los muestra sin tocar nada
//
// Se usa asi:  dump -> _aplicar_pine -> _guardar_pine -> restore -> check
import CDP from 'chrome-remote-interface';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TV_CDP_PORT || 9223);
const FILE = path.join(__dirname, '_inputs_backup.json');
const modo = process.argv[2] || 'check';

const LEER = `(function(){
  var ch = window.TradingViewApi._activeChartWidgetWV.value();
  var ss = ch.getAllStudies();
  for (var i=0;i<ss.length;i++){
    if(!/CIARG/i.test(ss[i].name||'')) continue;
    var v = ch.getStudyById(ss[i].id).getInputValues();
    var o = {};
    v.forEach(function(x){ if(/^in_[0-9]+$/.test(x.id)) o[x.id] = x.value; });
    var ver = (v.find(function(x){return x.id==='pineVersion';})||{}).value;
    return JSON.stringify({ ok:true, pineVersion: ver, inputs: o });
  }
  return JSON.stringify({ ok:false, error:'sin CIARG' });
})()`;

const ESCRIBIR = (obj) => `(function(){
  var ch = window.TradingViewApi._activeChartWidgetWV.value();
  var ss = ch.getAllStudies();
  var datos = ${JSON.stringify(obj)};
  for (var i=0;i<ss.length;i++){
    if(!/CIARG/i.test(ss[i].name||'')) continue;
    var st = ch.getStudyById(ss[i].id);
    var pares = Object.keys(datos).map(function(k){ return { id:k, value: datos[k] }; });
    st.setInputValues(pares);
    return JSON.stringify({ ok:true, escritos: pares.length });
  }
  return JSON.stringify({ ok:false, error:'sin CIARG' });
})()`;

const resp = await fetch(`http://localhost:${PORT}/json/list`);
const targets = (await resp.json()).filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));

for (const t of targets) {
  const client = await CDP({ port: PORT, target: t.id });
  await client.Runtime.enable();
  const ev = async (e) => {
    const r = await client.Runtime.evaluate({ expression: e, returnByValue: true });
    return r.exceptionDetails ? 'EXC ' + (r.exceptionDetails.exception?.description || '').split('\n')[0] : r.result?.value;
  };
  const sym = await ev(`(function(){try{return window.TradingViewApi._activeChartWidgetWV.value().symbol()}catch(e){return '?'}})()`);
  if (!/SPCFD:SPX/i.test(sym || '')) { await client.close(); continue; }

  if (modo === 'restore') {
    if (!fs.existsSync(FILE)) { console.error('no hay respaldo en', FILE); process.exit(1); }
    const guardado = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    console.log('restaurando', Object.keys(guardado.inputs).length, 'inputs ...');
    console.log(' ', await ev(ESCRIBIR(guardado.inputs)));
    await new Promise(r => setTimeout(r, 2000));
  } else if (modo === 'dump') {
    const raw = await ev(LEER);
    const j = JSON.parse(raw);
    fs.writeFileSync(FILE, JSON.stringify(j, null, 2), 'utf8');
    console.log('respaldados', Object.keys(j.inputs || {}).length, 'inputs (pine', j.pineVersion + ') en', FILE);
  }

  const ahora = JSON.parse(await ev(LEER));
  const ins = ahora.inputs || {};
  const claves = Object.keys(ins).sort((a, b) => +a.slice(3) - +b.slice(3));
  console.log(`\nestado actual — pine ${ahora.pineVersion}, ${claves.length} inputs`);
  console.log('  muros:', ['in_21', 'in_22', 'in_23', 'in_24', 'in_31'].map(k => `${k}=${ins[k]}`).join('  '));
  console.log('  gdv  :', ['in_25', 'in_27', 'in_29'].map(k => `${k}=${ins[k]}`).join('  '));
  console.log('  fuerza:', ['in_32', 'in_33'].map(k => `${k}=${ins[k]}`).join('  '));
  const enCero = claves.filter(k => +k.slice(3) >= 20 && +k.slice(3) <= 31 && !ins[k]);
  if (enCero.length) console.log('  ⚠️  EN CERO (muros perdidos):', enCero.join(', '));

  await client.close();
  break;
}
