'use strict';
require('dotenv').config();
const { TastytradeClient } = require('./src/tastytrade');
const tt = new TastytradeClient({
  clientSecret: process.env.TT_CLIENT_SECRET, refreshToken: process.env.TT_REFRESH_TOKEN,
  sessionToken: process.env.TT_SESSION_TOKEN, accountNumber: process.env.TT_ACCOUNT_NUMBER });

async function oiCadena(root, exp) {
  const d = await tt._req(`/option-chains/${root}/nested`);
  for (const item of (d.data?.items ?? [])) {
    const e = (item.expirations ?? []).find(x => x['expiration-date'] === exp);
    if (!e) continue;
    const syms = []; (e.strikes||[]).forEach(k => { if(k.call) syms.push(k.call); if(k.put) syms.push(k.put); });
    const oi = {};
    for (let i=0;i<syms.length;i+=50) {
      const p = syms.slice(i,i+50).map(s=>`symbols[]=${encodeURIComponent(s)}`).join('&');
      const r = await tt._req(`/market-data?${p}`);
      (r.data?.items??[]).forEach(it => { oi[it.symbol] = parseInt(it['open-interest']||0,10); });
    }
    return { root: item['root-symbol'], filas: (e.strikes||[]).map(k=>({strike:+k['strike-price'],c:oi[k.call]||0,p:oi[k.put]||0})).filter(f=>f.c+f.p>0) };
  }
  return null;
}
const mp = (filas) => { let best=null; for (const {strike:K} of filas) {
  const pago = filas.reduce((a,f)=>a+(K>f.strike?f.c*(K-f.strike):0)+(f.strike>K?f.p*(f.strike-K):0),0);
  if(!best||pago<best.pago) best={K,pago}; } return best; };

(async () => {
  const spot = parseFloat(((await tt._req('/market-data?symbols[]=SPX')).data?.items??[])[0].mark);
  console.log('spot SPX: ' + spot + '\n');
  const d = await oiCadena('SPX','2026-09-18');
  console.log('--- SPX 2026-09-18 (root ' + d.root + ') ---');
  console.log('  cadena COMPLETA (200-13000)      -> ' + mp(d.filas).K);
  for (const pct of [0.05, 0.10, 0.20]) {
    const f = d.filas.filter(x => x.strike >= spot*(1-pct) && x.strike <= spot*(1+pct));
    console.log(`  solo strikes a +-${(pct*100).toFixed(0)}% del spot -> ${mp(f).K}   (${f.length} strikes)`);
  }
  const sinRedondos = d.filas.filter(x => x.strike % 500 !== 0);
  console.log('  excluyendo strikes multiplo de 500 -> ' + mp(sinRedondos).K);
})().catch(e=>{console.error('ERROR: '+e.message);process.exit(1);});
