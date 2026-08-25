/**
 * Captura la cadena 0DTE real de SPX (bid/ask/mark/IV/greeks) desde TastyTrade
 * y la guarda como snapshot, para medir la PRIMA DE VARIANZA efectiva -- es
 * decir, cuanto paga de verdad el mercado por encima del valor teorico.
 *
 * POR QUE EXISTE (2026-08-25)
 * ---------------------------
 * `comparar_neutrales.py` demostro que el veredicto Iron Condor vs Iron
 * Butterfly depende ENTERAMENTE de esa prima: con precios justos gana el
 * condor por poco, y a partir de un 5% de prima gana el butterfly y la
 * distancia se dispara. Pero ese script valora con Black-Scholes, no con
 * precios reales -- identifica el punto de quiebre sin poder decir de que lado
 * estamos. Este capturador es lo que cierra esa pregunta.
 *
 * SOLO LECTURA -- IMPORTANTE
 * --------------------------
 * Tastytrade es la cuenta REAL de Guillermo. Este script llama UNICAMENTE a
 * dos endpoints de consulta:
 *     GET /option-chains/SPX/nested
 *     GET /market-data?symbols[]=...
 * No coloca, modifica ni cancela ninguna orden, y no toca posiciones. Si
 * alguna vez hace falta ampliarlo, mantener esa frontera: cualquier cosa que
 * escriba en el broker va en otro archivo, no en este.
 *
 * No levanta el servidor de produccion a proposito: `server.js` arranca ademas
 * el robot que opera, y para leer una cadena no hace falta nada de eso.
 *
 * Uso:
 *   node capturar_cadena_0dte.js [--expiry YYYY-MM-DD] [--rango 60]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { TastytradeClient } = require('../src/tastytrade');

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function hoyET() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return f.format(new Date());
}

function selloET() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}

(async () => {
  const expiry = arg('expiry', hoyET());
  const rango = parseFloat(arg('rango', '60'));   // +-N puntos alrededor del spot

  const tt = new TastytradeClient({
    clientSecret: process.env.TT_CLIENT_SECRET,
    refreshToken: process.env.TT_REFRESH_TOKEN,
    sessionToken: process.env.TT_SESSION_TOKEN,
    accountNumber: process.env.TT_ACCOUNT_NUMBER,
  });
  await tt.authenticate();
  console.log(`[auth] ok`);

  // Spot desde Yahoo (mismo patron que ya usa server.js)
  let spot = 0;
  try {
    const r = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=1d',
      { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const j = await r.json();
    spot = parseFloat(j.chart?.result?.[0]?.meta?.regularMarketPrice || 0);
  } catch (e) { /* se sigue con spot 0, el filtro de rango se desactiva */ }
  console.log(`[spot] SPX ${spot}`);

  const chain = await tt._req('/option-chains/SPX/nested');
  const exps = chain.data?.items?.[0]?.expirations || [];
  const exp = exps.find(e => e['expiration-date'] === expiry);
  if (!exp) {
    console.error(`[FALLO] no hay vencimiento ${expiry}. Disponibles: ` +
      exps.slice(0, 8).map(e => e['expiration-date']).join(', '));
    process.exit(2);
  }

  // Solo strikes cerca del dinero: es donde se arman las neutrales y evita
  // pedir cientos de simbolos ilíquidos que solo ensucian la medicion.
  const strikes = (exp.strikes || []).filter(s => {
    const k = parseFloat(s['strike-price']);
    return !spot || Math.abs(k - spot) <= rango;
  });
  const syms = [];
  for (const s of strikes) { if (s.call) syms.push(s.call); if (s.put) syms.push(s.put); }
  console.log(`[cadena] ${expiry}: ${strikes.length} strikes en +-${rango} pts (${syms.length} simbolos)`);

  const px = {};
  const BATCH = 50;
  for (let i = 0; i < syms.length; i += BATCH) {
    const b = syms.slice(i, i + BATCH);
    const q = b.map(s => `symbols[]=${encodeURIComponent(s)}`).join('&');
    try {
      const d = await tt._req(`/market-data?${q}`);
      for (const it of (d.data?.items || [])) {
        px[it.symbol] = {
          bid: parseFloat(it.bid || 0),
          ask: parseFloat(it.ask || 0),
          mark: parseFloat(it.mark || it.mid || 0),
          iv: parseFloat(it.volatility || 0),
          delta: parseFloat(it.delta || 0),
          gamma: parseFloat(it.gamma || 0),
          theta: parseFloat(it.theta || 0),
          oi: parseInt(it['open-interest'] || 0),
          vol: parseInt(it.volume || 0),
        };
      }
    } catch (e) { console.error(`[lote ${i}] ${e.message}`); }
  }

  const filas = strikes.map(s => {
    const k = parseFloat(s['strike-price']);
    return { strike: k, call: px[s.call] || null, put: px[s.put] || null };
  }).filter(f => f.call || f.put).sort((a, b) => a.strike - b.strike);

  const conPrecio = filas.filter(f =>
    (f.call && f.call.ask > 0) || (f.put && f.put.ask > 0)).length;

  const out = {
    capturadoEn: new Date().toISOString(),
    horaET: selloET(),
    fechaET: hoyET(),
    expiry, spot, rango,
    strikes: filas.length,
    strikesConPrecio: conPrecio,
    filas,
  };

  const dir = path.join(__dirname, '..', '..',
    'Documents', 'CARPETA PERSONAL', '01. guillermo carvajal', '01_Sigma',
    'mentoria alejandro', 'premercados alejandro', 'control premercado',
    'neutrales', 'cadenas');
  fs.mkdirSync(dir, { recursive: true });
  const fn = path.join(dir, `spx_0dte_${expiry.replace(/-/g, '')}_${selloET().replace(':', '')}.json`);
  fs.writeFileSync(fn, JSON.stringify(out, null, 1));
  console.log(`[done] ${conPrecio}/${filas.length} strikes con precio -> ${fn}`);
})().catch(e => { console.error('[FALLO]', e.message); process.exit(1); });
