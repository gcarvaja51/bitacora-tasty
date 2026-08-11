// Scraping de Sigma Terminal via un Chromium dedicado con perfil persistente propio
// (login manual una sola vez, sesion guardada en sigma_profile/, gitignored). Selectores
// CSS calibrados en vivo el 2026-07-30 contra la pagina real -- son clases de CSS Modules
// con sufijo hasheado (ej. "greeks_metricCard__GHfHB"), por eso se usa [class*="prefijo__"]
// en vez del nombre completo: sobrevive a que el hash cambie en un redeploy de Sigma
// Terminal, pero si el prefijo mismo cambia (rediseño real de la UI) esto se rompe y hace
// falta recalibrar a mano -- limitacion conocida y aceptada (ver diseño del daemon).
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, 'sigma_profile');
const TERMINAL_URL = 'https://web.sigma.trade/terminal/?tab=greeks';

// El panel de Greeks Exposure expone DOCE metricas; se leian ocho (2026-08-09).
// Las cuatro que faltaban:
//   Total Gamma  — |calls|+|puts|, lo que Luis llama "gama absoluto" y dice
//                  preferir sobre el neto ("el strike con mayor gama total es la
//                  zona de atraccion, el iman del precio").
//   Max Pain     — nivel de maximo dolor, contexto hacia el cierre.
//   P/C (OI)     — put/call ratio por open interest, sesgo del posicionamiento.
//   IV Promedio  — volatilidad implicita ATM de la cadena del SPX. Es la que mas
//                  falta hacia: hoy los spreads se valuan con el VIX, que es del
//                  indice entero y no de la cadena que realmente se opera.
const LABEL_MAP = {
  'Spot SPX': 'spxPrice',
  'Net GEX': 'netGex',
  'Total Gamma': 'totalGamma',
  'Net DEX': 'netDex',
  'Net Vanna': 'netVanna',
  'Gamma Flip': 'gammaFlip',
  'Max Pain': 'maxPain',
  'Put Wall': 'putWall',
  'Call Wall': 'callWall',
  'P/C (OI)': 'putCallOi',
  'MVS': 'mvs',
  'IV Promedio': 'ivPromedio',
};

let browser = null;
let page = null;

// Mata los Chromium que esten reteniendo el perfil del daemon. Solo esos: el
// filtro va contra la ruta del userDataDir, que aparece en la linea de comando.
// Nunca toca el Chrome del usuario ni ninguna otra instancia.
function limpiarChromiumHuerfano() {
  try {
    const ruta = PROFILE_DIR.replace(/\\/g, '\\\\');
    const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" `
      + `| Where-Object { $_.CommandLine -like '*${PROFILE_DIR.split(path.sep).pop()}*' } `
      + `| ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
                 { timeout: 20000, stdio: 'ignore' });
    // SingletonLock/SingletonCookie sobreviven a un kill y bloquean el arranque
    // siguiente igual que el proceso vivo.
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { fs.rmSync(path.join(PROFILE_DIR, f), { force: true }); } catch { /* noop */ }
    }
    // A stderr, no a stdout: hay scripts que consumen la salida de este modulo
    // como JSON puro (ver velas_trade.mjs del skill informe-trade) y un
    // diagnostico en stdout les rompe el parseo.
    console.error('[sigma] perfil liberado antes de lanzar');
  } catch (e) {
    // Que falle la limpieza no puede impedir el intento de lanzar.
    console.warn('[sigma] no se pudo limpiar el perfil (%s) -- se intenta lanzar igual', e.message);
  }
}

// Token del proxy de datos de Sigma (ver readCandles5m). No esta en localStorage
// ni embebido en el bundle: solo viaja en la cabecera `authorization` de las
// llamadas que hace la propia pagina. Se captura al vuelo. Medido el 2026-08-09:
// la pestaña de greeks —la que el daemon deja abierta— lo re-emite sola 8 veces
// en 75s (/health/sources y /gex/snapshot/SPX), asi que no hace falta navegar a
// ningun lado ni cablear la clave en el codigo.
let apiToken = null;
let listenerPuesto = null;   // la pagina a la que ya se le engancho el listener

function engancharCapturaToken(p) {
  if (listenerPuesto === p) return;
  listenerPuesto = p;
  p.on('request', (r) => {
    if (!r.url().includes('opcionsigma.com')) return;
    const a = r.headers()['authorization'];
    if (a) apiToken = a;
  });
}

export async function ensurePage() {
  // isClosed() NO alcanza: una pagina puede quedar con su frame "detached"
  // (renderer recargado/navegado por fuera) y seguir reportando isClosed()
  // === false -- ahi cada evaluate() tira "Attempted to use detached Frame" y
  // el daemon se queda reintentando con la misma referencia rota para siempre.
  // Caso real: 2026-08-03, el daemon acumulo fallos consecutivos toda la
  // apertura sin recuperarse solo. Se prueba la pagina con un evaluate()
  // trivial; si falla, se descarta y se reconstruye.
  if (browser && page && !page.isClosed()) {
    try {
      await page.evaluate(() => true);
      engancharCapturaToken(page);
      return page;
    } catch (e) {
      console.error('[sigma] Pagina cacheada invalida (%s) -- reconstruyendo', e.message);
      try { await page.close(); } catch { /* noop */ }
      page = null;
      // Si el browser sigue vivo, se reusa abriendo una pestaña nueva (mas
      // barato que relanzar Chrome y re-loguear).
      if (browser && browser.connected) {
        try {
          page = await browser.newPage();
          await page.goto(TERMINAL_URL, { waitUntil: 'domcontentloaded' });
          await new Promise((r) => setTimeout(r, 6000));
          engancharCapturaToken(page);
          return page;
        } catch (e2) {
          console.error('[sigma] No se pudo abrir pestaña nueva (%s) -- relanzando browser', e2.message);
          try { await browser.close(); } catch { /* noop */ }
          browser = null;
          page = null;
        }
      } else {
        browser = null;
      }
    }
  }
  // Antes de lanzar: matar cualquier Chromium que este reteniendo ESTE perfil.
  //
  // El 2026-08-10 el daemon perdio el dia entero por esto. A las 09:32
  // puppeteer.launch() supero los 30s esperando el WS endpoint y se dio por
  // vencido — pero el navegador SI habia arrancado. Quedo huerfano tomando el
  // perfil, y los 40 intentos siguientes fallaron todos con el mismo timeout,
  // porque un userDataDir no admite dos instancias. Resultado: cero lecturas de
  // Sigma en toda la sesion, con las tres estrategias corriendo en respaldo.
  //
  // El filtro es por la RUTA DEL PERFIL, no por nombre de proceso: matar
  // "chrome.exe" a secas se llevaria por delante el navegador del usuario.
  limpiarChromiumHuerfano();

  browser = await puppeteer.launch({
    headless: false,
    userDataDir: PROFILE_DIR,
    args: ['--start-maximized'],
    defaultViewport: null,
    // 30s (el default) resulto ser justo cuando el perfil viene de un cierre
    // sucio y Chromium tiene que recuperarlo al arrancar.
    timeout: 90000,
  });
  const pages = await browser.pages();
  page = pages[0] || (await browser.newPage());
  engancharCapturaToken(page);
  await page.goto(TERMINAL_URL, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 6000));
  return page;
}

function parseMoney(str) {
  if (str == null) return null;
  const s = String(str).replace(/,/g, '').trim();
  const m = s.match(/(-)?\$?(-)?([\d.]+)\s*(B|M|K)?/i);
  if (!m) return null;
  const neg = !!(m[1] || m[2]);
  let num = parseFloat(m[3]);
  if (Number.isNaN(num)) return null;
  const suffix = (m[4] || '').toUpperCase();
  if (suffix === 'B') num *= 1e9;
  else if (suffix === 'M') num *= 1e6;
  else if (suffix === 'K') num *= 1e3;
  return neg ? -num : num;
}

async function readSymbol(p) {
  return p.evaluate(() => {
    const el = document.querySelector('[class*="greeks_sym__"]');
    return el ? el.textContent.trim() : null;
  });
}

// El toggle "MVS Neto" / "MVS Abs" (seccion del grafico "Net GEX por strike")
// tambien controla el valor de la tarjeta principal "MVS" -- confirmado en vivo
// el 2026-07-31 (Neto y Abs dieron strikes distintos, 7400 vs 7450). A pedido
// del usuario se usa SIEMPRE el Absoluto -- se fuerza el click en cada lectura
// en vez de confiar en que el toggle haya quedado asi (puede resetear solo en
// un reload de la pagina, o si el usuario clickea el otro modo a mano mirando
// el chart).
async function ensureMvsAbsolute(p) {
  await p.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'MVS Abs');
    if (btn && !btn.className.includes('active')) btn.click();
  });
  await new Promise((r) => setTimeout(r, 500));
}

async function readRawMetrics(p) {
  return p.evaluate(() => {
    const cards = document.querySelectorAll('[class*="greeks_metricCard__"]');
    const out = {};
    for (const card of cards) {
      const labelEl = card.querySelector('[class*="greeks_metricLabel__"]');
      const valueEl = card.querySelector('[class*="greeks_metricValue__"]');
      if (!labelEl || !valueEl) continue;
      const textNode = Array.from(labelEl.childNodes).find((n) => n.nodeType === 3);
      const label = (textNode ? textNode.textContent : labelEl.textContent).trim();
      out[label] = valueEl.textContent.trim();
    }
    return out;
  });
}

// No intenta autocorregir el simbolo (a diferencia del agente viejo, que sabia clickear
// el dropdown de FAVORITOS) -- si el usuario cambio el activo en Sigma Terminal, se
// prefiere fallar con un error claro antes que simular UI a ciegas sin poder confirmar
// visualmente el resultado. Recalibrar/ampliar esto si se vuelve frecuente en la practica.
export async function readLevels() {
  const p = await ensurePage();

  const symbol = await readSymbol(p);
  if (!symbol || !/^SPX$/i.test(symbol)) {
    throw new Error(`Sigma Terminal no esta en SPX (simbolo actual: "${symbol}") -- cambiar a mano y reintentar`);
  }

  await ensureMvsAbsolute(p);

  // Espera ACTIVA a que aparezcan las metricas, en vez de confiar en el timeout
  // fijo de 6s de ensurePage (2026-08-10). Tras un arranque en frio —Chromium
  // recien lanzado, SPA cargando, sesion revalidandose— 6s se quedan cortos y la
  // lectura moria con "faltan metricas esperadas", que es el mismo mensaje que da
  // una sesion caducada o un cambio de UI. Tres causas distintas bajo un solo
  // error, y solo una de ellas necesitaba paciencia.
  //
  // Reproducido: con el perfil recien liberado, el primer intento llega con el
  // panel a medio pintar. Al segundo o tercero ya esta.
  let raw = {}, missing = [];
  for (let intento = 1; intento <= 6; intento++) {
    raw = await readRawMetrics(p);
    missing = Object.keys(LABEL_MAP).filter((k) => !(k in raw));
    if (!missing.length) break;
    if (intento < 6) await new Promise((r) => setTimeout(r, 2500));
  }
  if (missing.length > 0) {
    throw new Error(`Sigma Terminal: faltan metricas esperadas tras 15s de espera (${missing.join(', ')}) -- posible sesion expirada o cambio de UI`);
  }

  const levels = {};
  for (const [label, key] of Object.entries(LABEL_MAP)) {
    levels[key] = parseMoney(raw[label]);
  }
  levels.regime = levels.netGex > 0 ? 'POSITIVO' : 'NEGATIVO';
  return levels;
}

// ── Velas de 5m del SPX, de la misma fuente que el gamma ──────────────────
// De donde sale esto (2026-08-09): el usuario pregunto como hace Sigma Terminal
// para mostrar los indicadores completos en la primera hora, si nosotros
// necesitabamos 45 min de sesion para juntar 8 velas. La respuesta es que Sigma
// NO acumula nada: le pide el historico a Polygon a traves de su propio proxy, y
// lo dibuja entero de una. Nuestra reconstruccion a partir del spot que empuja el
// daemon era una limitacion autoimpuesta.
//
// Verificado contra el endpoint real: /v2/aggs/ticker/I:SPX/range/5/minute/...
// devolvio 159 velas cubriendo 6-ago 09:30 a 7-ago 16:00, o sea el indice de
// verdad (I:SPX, no el ETF) con la reticula alineada a las 09:30 en punto. Con
// eso la SMA8 esta lista en la primera vela del dia.
//
// Es best-effort: si falla, devuelve null y el que llama sigue sin velas. NUNCA
// debe tumbar el push de niveles, que es lo critico.
export async function readCandles5m({ velas = 30, diasAtras = 5, minutos = 5 } = {}) {
  const p = await ensurePage();
  if (!apiToken) return null;              // todavia no se capturo; el proximo ciclo lo tendra

  const hoy = new Date();
  const desde = new Date(hoy.getTime() - diasAtras * 24 * 3600 * 1000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const ruta = `/v2/aggs/ticker/I:SPX/range/${minutos}/minute/${iso(desde)}/${iso(hoy)}`
             + `?adjusted=true&sort=asc&limit=50000`;

  // El fetch va DENTRO de la pagina: el proxy valida el Origin, desde Node daria CORS.
  const bars = await p.evaluate(async (ruta, tok) => {
    try {
      const r = await fetch('https://market.opcionsigma.com/api/v1/polygon-proxy' + ruta,
                            { headers: { authorization: tok } });
      if (!r.ok) return { error: 'HTTP ' + r.status };
      const j = await r.json();
      return { results: j?.results || [] };
    } catch (e) { return { error: String(e).slice(0, 120) }; }
  }, ruta, apiToken);

  if (!bars || bars.error || !bars.results?.length) {
    if (bars?.error === 'HTTP 401') apiToken = null;   // caduco: que lo recapture
    return null;
  }
  // `t` es el ARRANQUE de la vela (misma convencion que Yahoo, que es contra lo
  // que estaba calibrada la reversion). No se re-etiqueta.
  return bars.results.slice(-velas).map((b) => ({
    t: b.t, o: b.o, h: b.h, l: b.l, c: b.c,
  }));
}

// ── VIX y su rango de 52 semanas, del mismo proxy ─────────────────────────
// Directriz del usuario (2026-08-09): "creamosle a sigma terminal y tomemos ese
// dato como opcion 1". El VIX de Sigma y el de Yahoo son el MISMO numero —
// verificado: 14.9 y 14.9, con la misma marca de tiempo al segundo (7-ago
// 16:15:01)— asi que esto no cambia ningun valor. Lo que gana es dejar de
// depender de Yahoo, donde un fallo silencioso dejaba el VIX en 20 fijo.
//
// El rango de 52 semanas se pide una vez por dia: son 257 velas diarias y no se
// mueve entre ciclos. Sirve para calcular el IV Rank sin preguntarle a
// TastyTrade, que es la cuenta REAL y no tiene por que estar en el camino de una
// decision del sandbox.
let vix52Cache = null;   // { dia, high, low }

export async function readVix() {
  const p = await ensurePage();
  if (!apiToken) return null;

  const hoy = new Date();
  const diaET = hoy.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const necesitaRango = !vix52Cache || vix52Cache.dia !== diaET;

  const desde = new Date(hoy.getTime() - 372 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const hasta = hoy.toISOString().slice(0, 10);

  const r = await p.evaluate(async (tok, necesitaRango, desde, hasta) => {
    const base = 'https://market.opcionsigma.com/api/v1/polygon-proxy';
    const get = async (ruta) => {
      const res = await fetch(base + ruta, { headers: { authorization: tok } });
      if (!res.ok) return { error: res.status };
      return res.json();
    };
    const out = {};
    const snap = await get('/v3/snapshot/indices?ticker.any_of=I:VIX');
    out.vix = snap?.results?.[0]?.value ?? null;
    out.err = snap?.error ?? null;
    if (necesitaRango) {
      const d = await get(`/v2/aggs/ticker/I:VIX/range/1/day/${desde}/${hasta}?adjusted=true&sort=asc&limit=1000`);
      out.cierres = (d?.results || []).map((b) => b.c).filter((c) => c != null);
    }
    return out;
  }, apiToken, necesitaRango, desde, hasta);

  if (r?.err === 401) { apiToken = null; return null; }
  if (!r || r.vix == null) return null;

  if (necesitaRango && r.cierres?.length > 200) {
    // Ventana movil de 252 ruedas, que es como se calcula un IV Rank de verdad.
    const ventana = r.cierres.slice(-252);
    vix52Cache = { dia: diaET, high: Math.max(...ventana), low: Math.min(...ventana) };
  }
  return {
    vix: r.vix,
    vix52High: vix52Cache?.high ?? null,
    vix52Low: vix52Cache?.low ?? null,
  };
}

export async function close() {
  if (browser) {
    try { await browser.close(); } catch { /* noop */ }
    browser = null;
    page = null;
  }
}
