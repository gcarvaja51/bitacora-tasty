'use strict';
require('dotenv').config();
const { TastytradeClient } = require('./src/tastytrade');
const tt = new TastytradeClient({
  clientSecret: process.env.TT_CLIENT_SECRET, refreshToken: process.env.TT_REFRESH_TOKEN,
  sessionToken: process.env.TT_SESSION_TOKEN, accountNumber: process.env.TT_ACCOUNT_NUMBER });
const EXP='2026-08-21';
const pago=(f,K)=>f.reduce((a,x)=>a+(K>x.strike?x.c*(K-x.strike):0)+(x.strike>K?x.p*(x.strike-K):0),0);

(async()=>{
 for (const sym of ['SPY','QQQ','NDX']) {
  try {
   const sq=((await tt._req(`/market-data?symbols[]=${sym}`)).data?.items??[])[0];
   const spot=parseFloat(sq.mark||sq.last||0);
   const d=await tt._req(`/option-chains/${sym}/nested`);
   for (const item of (d.data?.items??[])) {
    const root=item['root-symbol'];
    const e=(item.expirations??[]).find(x=>x['expiration-date']===EXP);
    if(!e) continue;
    const syms=[]; (e.strikes||[]).forEach(k=>{if(k.call)syms.push(k.call);if(k.put)syms.push(k.put);});
    const oi={};
    for(let i=0;i<syms.length;i+=50){
      const p=syms.slice(i,i+50).map(s=>`symbols[]=${encodeURIComponent(s)}`).join('&');
      const r=await tt._req(`/market-data?${p}`);
      (r.data?.items??[]).forEach(it=>{oi[it.symbol]=parseInt(it['open-interest']||0,10);});
    }
    const filas=(e.strikes||[]).map(k=>({strike:+k['strike-price'],c:oi[k.call]||0,p:oi[k.put]||0})).filter(x=>x.c+x.p>0);
    if(!filas.length) continue;
    const curva=filas.map(f=>({K:f.strike,g:pago(filas,f.strike)})).sort((a,b)=>a.g-b.g);
    const min=curva[0];
    const banda=(tol)=>{const d2=curva.filter(c=>c.g<=min.g*(1+tol)).map(c=>c.K).sort((a,b)=>a-b);
                        return `${d2[0]}-${d2[d2.length-1]} (${(d2[d2.length-1]-d2[0]).toFixed(2)} de ancho, ${d2.length} strikes)`;};
    console.log(`\n=== ${sym} (${root}, ${e['settlement-type']}) ${EXP} ===`);
    console.log(`  spot ${spot.toFixed(2)}  |  strikes con OI ${filas.length}  |  OI ${filas.reduce((a,x)=>a+x.c+x.p,0).toLocaleString()}`);
    console.log(`  MAX PAIN: ${min.K}   (dist ${(spot-min.K>=0?'+':'')+(spot-min.K).toFixed(2)})`);
    console.log(`  piso <=0.1% : ${banda(0.001)}`);
    console.log(`  piso <=0.5% : ${banda(0.005)}`);
    console.log(`  piso <=1.0% : ${banda(0.01)}`);
   }
  } catch(e){ console.log(`${sym}: ERROR ${e.message}`); }
 }
})().catch(e=>{console.error('ERROR: '+e.message);process.exit(1);});
