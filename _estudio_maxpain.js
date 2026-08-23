'use strict';
// ESTUDIO DE MAX PAIN — vencimiento mensual 2026-08-21, corte transversal amplio.
// SOLO LECTURA. Calcula, para cada subyacente: Max Pain de la cadena que vence hoy,
// el ancho del piso plano (que tan determinado esta el minimo) y la distancia del
// precio. Los cierres se agregan despues con _cierres_estudio.js.
require('dotenv').config();
const fs = require('fs');
const { TastytradeClient } = require('./src/tastytrade');

const tt = new TastytradeClient({
  clientSecret: process.env.TT_CLIENT_SECRET, refreshToken: process.env.TT_REFRESH_TOKEN,
  sessionToken: process.env.TT_SESSION_TOKEN, accountNumber: process.env.TT_ACCOUNT_NUMBER });

const EXP = '2026-08-21';

// Universo: indices y ETF de referencia + megacaps + alta actividad de opciones
// + los 11 que el usuario tiene abiertos.
const UNIVERSO = [
  'SPX','SPY','QQQ','NDX','IWM','DIA','RUT','VIX',
  'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','AVGO','AMD','NFLX','ADBE','CRM',
  'INTC','MU','QCOM','TSM','ORCL','CSCO','IBM','PLTR','SMCI','ARM','MRVL','MSTR','COIN',
  'JPM','BAC','WFC','GS','MS','C','V','MA','PYPL','SOFI','SCHW',
  'XOM','CVX','OXY','SLB','COP',
  'JNJ','PFE','MRK','LLY','UNH','ABBV',
  'WMT','COST','HD','LOW','TGT','NKE','SBUX','MCD','DIS','GAP',
  'BA','CAT','GE','F','GM','RIVN','LCID','NIO','UBER','LYFT','ABNB',
  'T','VZ','CMCSA','SNAP','PINS','RBLX','SHOP','SQ','HOOD','DKNG',
  'GLD','SLV','TLT','HYG','XLF','XLE','XLK','EEM','FXI','ARKK','IBIT',
  'JBLU','AAL','DAL','UAL','LUV','CCL','NCLH','RCL',
  'NU','BE','PATH','AFRM','UPST','CHWY','ROKU','ZM','DOCU','TWLO',
];

const pago = (f, K) => f.reduce((a,x) => a + (K>x.strike ? x.c*(K-x.strike) : 0)
                                          + (x.strike>K ? x.p*(x.strike-K) : 0), 0);

async function analizar(sym) {
  const sq = ((await tt._req(`/market-data?symbols[]=${encodeURIComponent(sym)}`)).data?.items ?? [])[0];
  if (!sq) throw new Error('sin cotizacion');
  const spot = parseFloat(sq.mark || sq.last || 0);
  const prev = parseFloat(sq['prev-close'] || 0);
  if (!spot) throw new Error('spot 0');

  const d = await tt._req(`/option-chains/${encodeURIComponent(sym)}/nested`);
  const salidas = [];
  for (const item of (d.data?.items ?? [])) {
    const e = (item.expirations ?? []).find(x => x['expiration-date'] === EXP);
    if (!e) continue;
    const syms = [];
    (e.strikes || []).forEach(k => { if (k.call) syms.push(k.call); if (k.put) syms.push(k.put); });
    if (!syms.length) continue;
    const oi = {};
    for (let i = 0; i < syms.length; i += 50) {
      const p = syms.slice(i, i+50).map(s => `symbols[]=${encodeURIComponent(s)}`).join('&');
      const r = await tt._req(`/market-data?${p}`);
      (r.data?.items ?? []).forEach(it => { oi[it.symbol] = parseInt(it['open-interest'] || 0, 10); });
    }
    const filas = (e.strikes || []).map(k => ({ strike:+k['strike-price'], c:oi[k.call]||0, p:oi[k.put]||0 }))
                                   .filter(x => x.c + x.p > 0);
    if (filas.length < 3) continue;
    const curva = filas.map(f => ({ K:f.strike, g:pago(filas, f.strike) })).sort((a,b) => a.g - b.g);
    const min = curva[0];
    const piso = (tol) => {
      const dd = curva.filter(c => c.g <= min.g*(1+tol)).map(c => c.K).sort((a,b)=>a-b);
      return { lo: dd[0], hi: dd[dd.length-1], n: dd.length, ancho: dd[dd.length-1]-dd[0] };
    };
    salidas.push({
      sym, root: item['root-symbol'], settle: e['settlement-type'],
      spot, prev, maxPain: min.K,
      distPct: (spot - min.K)/min.K*100,
      oi: filas.reduce((a,x)=>a+x.c+x.p,0),
      strikes: filas.length,
      piso01: piso(0.001), piso05: piso(0.005),
      pisoAnchoPct: piso(0.001).ancho / min.K * 100,
    });
  }
  return salidas;
}

(async () => {
  const res = [];
  let i = 0;
  for (const sym of UNIVERSO) {
    i++;
    try {
      const s = await analizar(sym);
      if (!s.length) { console.log(`[${i}/${UNIVERSO.length}] ${sym}: sin cadena del ${EXP}`); continue; }
      s.forEach(x => {
        res.push(x);
        console.log(`[${i}/${UNIVERSO.length}] ${x.sym.padEnd(6)}${x.root !== x.sym ? '('+x.root+')' : '       '} ` +
          `spot ${String(x.spot.toFixed(2)).padStart(10)}  MP ${String(x.maxPain).padStart(9)}  ` +
          `dist ${String(x.distPct.toFixed(2)+'%').padStart(8)}  piso ${x.pisoAnchoPct.toFixed(2)}%  OI ${x.oi.toLocaleString()}`);
      });
    } catch (e) {
      console.log(`[${i}/${UNIVERSO.length}] ${sym}: ${e.message.slice(0,70)}`);
    }
  }
  fs.writeFileSync('_estudio_maxpain.json', JSON.stringify(res, null, 2));
  console.log(`\nlistos: ${res.length} cadenas de ${UNIVERSO.length} simbolos pedidos`);
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
