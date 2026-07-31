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

const LABEL_MAP = {
  'Spot SPX': 'spxPrice',
  'Net GEX': 'netGex',
  'Net DEX': 'netDex',
  'Net Vanna': 'netVanna',
  'Gamma Flip': 'gammaFlip',
  'Put Wall': 'putWall',
  'Call Wall': 'callWall',
  'MVS': 'mvs',
};

let browser = null;
let page = null;

export async function ensurePage() {
  if (browser && page && !page.isClosed()) return page;
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
