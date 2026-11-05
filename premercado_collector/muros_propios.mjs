// Muros propios del 0DTE para el premercado (2026-11-05).
//
// POR QUE EXISTE. El 5-nov el usuario deja Sigma Terminal. Hasta ahi el bundle
// traia los muros de gamma_daemon/status.json (lo que el daemon leia de Sigma).
// Ahora salen de NUESTRO calculo con la regla de Sigma (murosReglaSigma en
// src/spx.js: ahi estan la regla y su validacion, 142 pares, ~92% exacto).
//
// DOS CAMINOS, MISMA FUNCION:
//   1. GET /api/spx/muros-propios de produccion (usa precioSPXFresco para el spot).
//   2. Si el endpoint no esta (no desplegado, caido), se calcula aqui mismo con
//      la cadena de produccion (/api/option-chain/SPX, que ya existe) y la MISMA
//      murosReglaSigma. El spot: el cierre que este recolector acaba de leer en
//      TradingView (TVC:SPX) y, si no, Yahoo. La cadena trae underlyingPrice 0
//      para SPX (conocido desde el 8-sep), por eso no se usa.
//
// SOLO LECTURA: dos GET a nuestro servidor y uno a Yahoo. No toca el broker.
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { murosReglaSigma, VALIDACION_MUROS_SIGMA } = require('../src/spx.js');

const BASE = process.env.BITACORA_URL || 'https://web-production-23473.up.railway.app';

const hoyET = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

async function getJson(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    const txt = await r.text();
    try { return { status: r.status, json: JSON.parse(txt) }; }
    catch { return { status: r.status, json: null }; }
  } finally { clearTimeout(t); }
}

async function spotYahoo() {
  const { json } = await getJson('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=1d', 15000);
  const m = json?.chart?.result?.[0]?.meta;
  return m?.regularMarketPrice > 1000
    ? { price: m.regularMarketPrice, fuente: 'yahoo', edadSeg: Math.round(Date.now() / 1000 - (m.regularMarketTime || 0)) }
    : null;
}

// Devuelve el objeto con los MISMOS nombres de campo que traia la lectura de
// Sigma (spxPrice, callWall, putWall, gammaFlip, maxPain, mvs, netGex, expiry,
// symbol...), para que el gate, el chart y el skill no tengan que cambiar de forma.
export async function obtenerMurosPropios({ spotTV = null, log = () => {} } = {}) {
  const hoy = hoyET();

  // 1. Endpoint de produccion.
  try {
    const { status, json } = await getJson(`${BASE}/api/spx/muros-propios`, 90000);
    if (json?.ok && json.expiry === hoy) {
      return { ...json, via: 'endpoint' };
    }
    log(`[muros] endpoint no disponible (HTTP ${status}${json?.error ? `: ${json.error}` : ''}), se calcula local`);
  } catch (e) {
    log(`[muros] endpoint fallo (${e.message}), se calcula local`);
  }

  // 2. Local, misma funcion.
  const { json: chain } = await getJson(`${BASE}/api/option-chain/SPX`, 90000);
  const exps = chain?.expirations || [];
  const exp = exps.find(e => e.expiry === hoy);
  if (!exp) throw new Error(`la cadena no trae el vencimiento de hoy (${hoy}); trae ${exps.map(e => e.expiry).slice(0, 4).join(', ') || 'nada'}`);

  let spot = null;
  if (spotTV > 1000) spot = { price: spotTV, fuente: 'tradingview', edadSeg: null };
  if (!spot) spot = await spotYahoo().catch(() => null);
  if (!spot) throw new Error('sin spot del SPX (ni TradingView ni Yahoo)');

  const strikes = (exp.strikes || []).map(s => ({
    strike: s.strike,
    call: { delta: s.call?.delta || 0, gamma: s.call?.gamma || 0, oi: s.call?.oi || 0, iv: s.call?.iv || 0 },
    put:  { delta: s.put?.delta  || 0, gamma: s.put?.gamma  || 0, oi: s.put?.oi  || 0, iv: s.put?.iv  || 0 },
  }));
  const m = murosReglaSigma(strikes, spot.price, exp.expiry);
  if (!m) throw new Error('la rejilla 0DTE salio vacia (sin gamma u OI)');

  return {
    ok: true, fuente: 'propio_regla_sigma', symbol: 'SPX',
    expiry: exp.expiry, dte: exp.dte ?? 0, esHoy: true,
    spxPrice: spot.price, spotFuente: spot.fuente, spotEdadSeg: spot.edadSeg,
    ...m,
    calculadoEn: new Date().toISOString(),
    validacion: VALIDACION_MUROS_SIGMA,
    via: 'local',
  };
}
