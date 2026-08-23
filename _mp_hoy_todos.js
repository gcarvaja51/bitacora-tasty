'use strict';
require('dotenv').config();
const { TastytradeClient } = require('./src/tastytrade');
const tt = new TastytradeClient({
  clientSecret: process.env.TT_CLIENT_SECRET, refreshToken: process.env.TT_REFRESH_TOKEN,
  sessionToken: process.env.TT_SESSION_TOKEN, accountNumber: process.env.TT_ACCOUNT_NUMBER });
const EXP = '2026-08-21';
const SUBS = ['SPX','ADBE','BA','BE','GAP','IBIT','JBLU','NFLX','NIO','NU','SOFI'];
const mp = (f) => { let b=null; for (const {strike:K} of f) {
  const g=f.reduce((a,x)=>a+(K>x.strike?x.c*(K-x.strike):0)+(x.strike>K?x.p*(x.strike-K):0),0);
  if(!b||g<b.g) b={K,g}; } return b; };
(async () => {
  const out=[];
  for (const sym of SUBS) {
    try {
      const sq = ((await tt._req(`/market-data?symbols[]=${encodeURIComponent(sym)}`)).data?.items??[])[0];
      const spot = parseFloat(sq.mark||sq.last||0);
      const d = await tt._req(`/option-chains/${encodeURIComponent(sym)}/nested`);
      for (const item of (d.data?.items ?? [])) {
        const root = item['root-symbol'];
        const e = (item.expirations ?? []).find(x => x['expiration-date'] === EXP);
        if (!e) continue;
        const syms=[]; (e.strikes||[]).forEach(k=>{ if(k.call)syms.push(k.call); if(k.put)syms.push(k.put); });
        const oi={};
        for(let i=0;i<syms.length;i+=50){
          const p=syms.slice(i,i+50).map(s=>`symbols[]=${encodeURIComponent(s)}`).join('&');
          const r=await tt._req(`/market-data?${p}`);
          (r.data?.items??[]).forEach(it=>{oi[it.symbol]=parseInt(it['open-interest']||0,10);});
        }
        const filas=(e.strikes||[]).map(k=>({strike:+k['strike-price'],c:oi[k.call]||0,p:oi[k.put]||0})).filter(x=>x.c+x.p>0);
        if(!filas.length) continue;
        const r=mp(filas), tot=filas.reduce((a,x)=>a+x.c+x.p,0);
        out.push({sym,root,spot,maxPain:r.K,dist:spot-r.K,oi:tot,strikes:filas.length,settle:e['settlement-type']});
        console.log(`${sym.padEnd(5)} ${root.padEnd(5)} ${String(e['settlement-type']).padEnd(3)} spot ${String(spot.toFixed(2)).padStart(9)}  MAX PAIN ${String(r.K).padStart(8)}  dist ${((spot-r.K>=0?'+':'')+(spot-r.K).toFixed(2)).padStart(9)}  (OI ${tot.toLocaleString()})`);
      }
    } catch(e){ console.log(`${sym}: ERROR ${e.message}`); }
  }
  require('fs').writeFileSync('_mp_hoy_todos.json', JSON.stringify(out,null,2));
})().catch(e=>{console.error('ERROR: '+e.message);process.exit(1);});
