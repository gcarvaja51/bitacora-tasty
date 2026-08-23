'use strict';
// Analisis del Max Pain: que tan determinado esta el minimo, y de donde puede
// salir la diferencia de 5 puntos contra Sigma Terminal.
require('dotenv').config();
const { TastytradeClient } = require('./src/tastytrade');
const tt = new TastytradeClient({
  clientSecret: process.env.TT_CLIENT_SECRET, refreshToken: process.env.TT_REFRESH_TOKEN,
  sessionToken: process.env.TT_SESSION_TOKEN, accountNumber: process.env.TT_ACCOUNT_NUMBER });

async function filasDe(root, exp) {
  const d = await tt._req('/option-chains/SPX/nested');
  const item = (d.data?.items ?? []).find(i => i['root-symbol'] === root);
  const e = (item?.expirations ?? []).find(x => x['expiration-date'] === exp);
  if (!e) return [];
  const syms=[]; (e.strikes||[]).forEach(k=>{ if(k.call)syms.push(k.call); if(k.put)syms.push(k.put); });
  const oi={};
  for(let i=0;i<syms.length;i+=50){
    const p=syms.slice(i,i+50).map(s=>`symbols[]=${encodeURIComponent(s)}`).join('&');
    const r=await tt._req(`/market-data?${p}`);
    (r.data?.items??[]).forEach(it=>{oi[it.symbol]=parseInt(it['open-interest']||0,10);});
  }
  return (e.strikes||[]).map(k=>({strike:+k['strike-price'],c:oi[k.call]||0,p:oi[k.put]||0})).filter(x=>x.c+x.p>0);
}
const pago = (f,K) => f.reduce((a,x)=>a+(K>x.strike?x.c*(K-x.strike):0)+(x.strike>K?x.p*(x.strike-K):0),0);

function analizar(nombre, filas) {
  if (!filas.length) { console.log(nombre + ': sin datos'); return; }
  const curva = filas.map(f => ({K:f.strike, g:pago(filas,f.strike)})).sort((a,b)=>a.g-b.g);
  const min = curva[0];
  console.log(`\n=== ${nombre} ===`);
  console.log(`  strikes con OI: ${filas.length}  |  OI total: ${filas.reduce((a,x)=>a+x.c+x.p,0).toLocaleString()}`);
  console.log(`  MAX PAIN (argmin): ${min.K}   pago ${(min.g/1e9).toFixed(4)} B`);
  for (const tol of [0.001, 0.005, 0.01]) {
    const dentro = curva.filter(c => c.g <= min.g*(1+tol)).map(c=>c.K).sort((a,b)=>a-b);
    console.log(`  strikes a <=${(tol*100).toFixed(1)}% del minimo: ${dentro.length}  ->  ${dentro[0]} a ${dentro[dentro.length-1]}  (ancho ${dentro[dentro.length-1]-dentro[0]} pts)`);
  }
}

(async () => {
  const spxw = await filasDe('SPXW','2026-08-21');
  const spx  = await filasDe('SPX','2026-08-21');
  const sep  = await filasDe('SPX','2026-09-18');
  analizar('SPXW 21-ago (la que muestra Sigma)', spxw);
  analizar('SPX 21-ago (mensual AM, ya liquidada)', spx);
  analizar('SPX 18-sep (tu condor)', sep);

  // Hipotesis: Sigma suma las dos raices del mismo vencimiento
  const mapa = new Map();
  [...spxw, ...spx].forEach(f => {
    const e = mapa.get(f.strike) || {strike:f.strike,c:0,p:0};
    e.c += f.c; e.p += f.p; mapa.set(f.strike, e);
  });
  analizar('HIPOTESIS: SPX + SPXW combinados (21-ago)', [...mapa.values()]);
})().catch(e=>{console.error('ERROR: '+e.message);process.exit(1);});
