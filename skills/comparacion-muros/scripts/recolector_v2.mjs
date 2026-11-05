// Comparacion v2 (2026-11-05): Sigma Terminal vs murosReglaSigma con la cadena 0DTE
// COMPLETA, cada 2 min. La v1 (julio) comparaba contra calcGEX de 4 vencimientos;
// la rejilla historica solo guarda 12 strikes. Esto guarda la rejilla entera
// (+-200 pts del spot) para poder probar despues gammaFlip, maxPain y netGex.
// SOLO LECTURA: GET a produccion. No toca TradingView ni el broker.
//   node recolector_v2.mjs [hastaHHMM_ET=1605] [salida.jsonl]
import { createRequire } from 'module';
import { appendFileSync } from 'fs';
const require = createRequire(import.meta.url);
const { murosReglaSigma } = require('../../../src/spx.js');

const BASE = 'https://web-production-23473.up.railway.app';
const HASTA = Number(process.argv[2] || 1605);
const OUT = process.argv[3] || 'C:\\Users\\gcarv\\bitacora-tasty\\comparacion_muros_v2.jsonl';
const PASO_MS = 120000;

const etHHMM = () => Number(new Date().toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }).replace(':', ''));
const hoyET = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const get = async (u) => (await fetch(u, { signal: AbortSignal.timeout(90000) })).json();

let ultimoSello = null;
async function ciclo() {
  const s = await get(`${BASE}/api/spx/sigma-levels`);
  if (!s?.ok || !s.fresh || s.capturadoEn === ultimoSello || s.expiry !== hoyET()) {
    return `sigma no fresco/repetido (fresh=${s?.fresh}, vto ${s?.expiry})`;
  }
  const c = await get(`${BASE}/api/option-chain/SPX`);
  const exp = (c.expirations || []).find(e => e.expiry === s.expiry);
  if (!exp) return 'sin vencimiento de hoy en la cadena';
  const strikes = exp.strikes.map(x => ({
    strike: x.strike,
    call: { delta: x.call?.delta || 0, gamma: x.call?.gamma || 0, oi: x.call?.oi || 0, iv: x.call?.iv || 0, vol: x.call?.volume || 0 },
    put:  { delta: x.put?.delta  || 0, gamma: x.put?.gamma  || 0, oi: x.put?.oi  || 0, iv: x.put?.iv  || 0, vol: x.put?.volume || 0 },
  }));
  const conSpotSigma = murosReglaSigma(strikes, s.spxPrice, exp.expiry);
  ultimoSello = s.capturadoEn;
  const fila = {
    at: new Date().toISOString(), etHHMM: etHHMM(),
    sigma: { capturadoEn: s.capturadoEn, spxPrice: s.spxPrice, callWall: s.callWall, putWall: s.putWall, mvs: s.mvs,
             gammaFlip: s.gammaFlip, maxPain: s.maxPain, netGex: s.netGex, netDex: s.netDex, totalGamma: s.totalGamma, regime: s.regime },
    propio: conSpotSigma,
    rejilla: strikes.filter(x => Math.abs(x.strike - s.spxPrice) <= 200),
  };
  appendFileSync(OUT, JSON.stringify(fila) + '\n');
  const p = conSpotSigma || {};
  return `ok spot ${s.spxPrice} | CW S ${s.callWall}/P ${p.callWall} | PW S ${s.putWall}/P ${p.putWall} | MVS S ${s.mvs}/P ${p.mvs} | GF S ${s.gammaFlip}/P ${p.gammaFlip} | MP S ${s.maxPain}/P ${p.maxPain}`;
}

while (etHHMM() < HASTA) {
  try { console.log(new Date().toISOString(), await ciclo()); }
  catch (e) { console.log(new Date().toISOString(), 'error', e.message); }
  await new Promise(r => setTimeout(r, PASO_MS));
}
console.log('fin de la ventana');
