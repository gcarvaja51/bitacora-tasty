// Recupera del canal de la Bola 8 los informes de un tramo del día (texto e imágenes), subiendo por el historial.
// Uso: node historial_bola8.mjs AAAA-MM-DD HH:MM HH:MM <carpeta_salida>     (horas de Nueva York)
// Solo lectura: no escribe en Discord. NO correrlo mientras el loop de confluencia usa discord_profile.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire('C:/Users/gcarv/bitacora-tasty/gamma_daemon/package.json');
const puppeteer = require('puppeteer');

const BASE = path.dirname(fileURLToPath(import.meta.url));
const [fecha, desde, hasta, salida] = process.argv.slice(2);
if (!fecha || !desde || !hasta || !salida) { console.error('Uso: node historial_bola8.mjs AAAA-MM-DD HH:MM HH:MM <carpeta>'); process.exit(1); }
fs.mkdirSync(salida, { recursive: true });
const GUILD = '1247978347665948673', BOLA8 = '1249695905133887561';
const aNY = (iso) => new Date(iso).toLocaleString('en-CA', { timeZone: 'America/New_York', hour12: false }).replace(',', '');

const b = await puppeteer.launch({ headless: 'new', userDataDir: path.join(BASE, 'discord_profile'), defaultViewport: { width: 1600, height: 1400 }, args: ['--mute-audio'] });
try {
  const p = await b.newPage();
  await p.goto(`https://discord.com/channels/${GUILD}/${BOLA8}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForFunction(() => document.querySelectorAll('[id^="chat-messages"]').length > 3, { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));
  const vistos = new Map();
  for (let vuelta = 0; vuelta < 160; vuelta++) {
    const lote = await p.evaluate(async () => {
      const li = [...document.querySelectorAll('[id^="chat-messages"]')];
      const out = [];
      let hora = null;
      for (const l of li) {
        const t = l.querySelector('time'); if (t) hora = t.getAttribute('datetime');
        // 23-nov: Discord carga las imágenes solo a la vista; se toman los enlaces de los adjuntos aunque no hayan cargado
        const urls = new Set([...l.querySelectorAll('a[href*="/attachments/"]')].map((x) => x.href)
          .concat([...l.querySelectorAll('img')].map((i) => i.src).filter((u) => /attachments/.test(u))));
        const imgs = [...urls].map((u) => u.replace(/width=\d+&height=\d+&?/, '')).filter((u) => /\.(png|jpe?g|webp)/i.test(u));
        out.push({ id: l.id, hora, texto: (l.innerText || '').slice(0, 1500), imgs });
      }
      return out;
    });
    for (const m of lote) if (m.hora && !vistos.has(m.id)) vistos.set(m.id, m);
    const horas = [...vistos.values()].map((m) => aNY(m.hora)).sort();
    const masVieja = horas[0] || '';
    if (masVieja && masVieja < `${fecha} ${desde}`) break;
    await p.evaluate(() => { const sc = [...document.querySelectorAll('[class*="scroller"]')].find((e) => e.querySelector('[id^="chat-messages"]')); if (sc) sc.scrollTop = Math.max(0, sc.scrollTop - 900); });
    await new Promise((r) => setTimeout(r, 2200));
  }
  const tramo = [...vistos.values()].filter((m) => { const h = aNY(m.hora); return h >= `${fecha} ${desde}` && h <= `${fecha} ${hasta}`; })
    .sort((a, c) => a.hora.localeCompare(c.hora));
  // bajar las imágenes del tramo (desde la página, con su sesión)
  let n = 0; const yaBajadas = new Set();
  for (const m of tramo) {
    m.archivos = [];
    for (const u of m.imgs) {
      const clave = u.split('?')[0]; if (yaBajadas.has(clave)) continue; yaBajadas.add(clave);
      const data = await p.evaluate(async (u) => {
        const x = await new Promise((ok, ko) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => ok(i); i.onerror = ko; i.src = u; });
        const c = document.createElement('canvas'); c.width = x.naturalWidth; c.height = x.naturalHeight; c.getContext('2d').drawImage(x, 0, 0); return c.toDataURL('image/png');
      }, u).catch(() => null);
      if (!data) continue;
      const f = path.join(salida, `bola8_${aNY(m.hora).slice(11, 16).replace(':', '')}_${n++}.png`);
      fs.writeFileSync(f, Buffer.from(data.split(',')[1], 'base64')); m.archivos.push(path.basename(f));
    }
    m.hora_ny = aNY(m.hora); delete m.imgs;
  }
  fs.writeFileSync(path.join(salida, 'bola8_historial.json'), JSON.stringify(tramo, null, 1));
  console.log(`informes: ${tramo.length} · imágenes: ${n} · más viejo visto: ${[...vistos.values()].map((m) => aNY(m.hora)).sort()[0]}`);
} finally { await b.close(); }
