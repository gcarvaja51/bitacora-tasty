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
  browser = await puppeteer.launch({
    headless: false,
    userDataDir: PROFILE_DIR,
    args: ['--start-maximized'],
    defaultViewport: null,
  });
  const pages = await browser.pages();
  page = pages[0] || (await browser.newPage());
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

  const raw = await readRawMetrics(p);
  const missing = Object.keys(LABEL_MAP).filter((k) => !(k in raw));
  if (missing.length > 0) {
    throw new Error(`Sigma Terminal: faltan metricas esperadas (${missing.join(', ')}) -- posible sesion expirada o cambio de UI`);
  }

  const levels = {};
  for (const [label, key] of Object.entries(LABEL_MAP)) {
    levels[key] = parseMoney(raw[label]);
  }
  levels.regime = levels.netGex > 0 ? 'POSITIVO' : 'NEGATIVO';
  return levels;
}

export async function close() {
  if (browser) {
    try { await browser.close(); } catch { /* noop */ }
    browser = null;
    page = null;
  }
}
