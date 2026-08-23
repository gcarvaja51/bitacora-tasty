'use strict';
require('dotenv').config();
const { TastytradeClient } = require('./src/tastytrade');
const tt = new TastytradeClient({
  clientSecret: process.env.TT_CLIENT_SECRET, refreshToken: process.env.TT_REFRESH_TOKEN,
  sessionToken: process.env.TT_SESSION_TOKEN, accountNumber: process.env.TT_ACCOUNT_NUMBER });
const EXP = '2026-08-21';
const mp = (filas) => { let best=null; for (const {strike:K} of filas) {
  const pago = filas.reduce((a,f)=>a+(K>f.strike?f.c*(K-f.strike):0)+(f.strike>K?f.p*(f.strike-K):0),0);
  if(!best||pago<best.pago) best={K,pago}; } return best; };
(async () => {
  const spot = parseFloat(((await tt._req('/market-data?symbols[]=SPX')).data?.items??[])[0].mark);
  console.log('spot SPX ahora: ' + spot);
  const d = await tt._req('/option-chains/SPX/nested');
  for (const item of (d.data?.items ?? [])) {
    const root = item['root-symbol'];
    const e = (item.expirations ?? []).find(x => x['expiration-date'] === EXP);
    if (!e) { console.log(`\n${root}: no tiene vencimiento ${EXP}`); continue; }
    const syms=[]; (e.strikes||[]).forEach(k=>{ if(k.call)syms.push(k.call); if(k.put)syms.push(k.put); });
    const oi={};
    for(let i=0;i<syms.length;i+=50){
      const p=syms.slice(i,i+50).map(s=>`symbols[]=${encodeURIComponent(s)}`).join('&');
      const r=await tt._req(`/market-data?${p}`);
      (r.data?.items??[]).forEach(it=>{oi[it.symbol]=parseInt(it['open-interest']||0,10);});
    }
    const filas=(e.strikes||[]).map(k=>({strike:+k['strike-price'],c:oi[k.call]||0,p:oi[k.put]||0})).filter(f=>f.c+f.p>0);
    if(!filas.length){ console.log(`\n${root} ${EXP}: sin OI`); continue; }
    const tot=filas.reduce((a,f)=>a+f.c+f.p,0);
    console.log(`\n--- ${root} ${EXP} (${e['expiration-type']}, settlement ${e['settlement-type']}) ---`);
    console.log(`  strikes con OI: ${filas.length}  |  OI total: ${tot.toLocaleString()}`);
    console.log(`  MAX PAIN cadena completa      -> ${mp(filas).K}`);
    const banda = filas.filter(f=>f.strike>=7610&&f.strike<=7735);
    if (banda.length) console.log(`  MAX PAIN banda 7610-7735 (la del grafico de Sigma) -> ${mp(banda).K}   (${banda.length} strikes)`);
  }
})().catch(e=>{console.error('ERROR: '+e.message);process.exit(1);});
