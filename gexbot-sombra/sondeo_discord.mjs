// Sondeo de SOLO LECTURA (21-nov): ¿qué publica Discord fuera de la sesión de NY (fines de semana / noche)?
// No entra a ningún stage ni hace clic: abre cada canal, anota si hay transmisión en vivo y los últimos mensajes con su hora.
// Uso: node sondeo_discord.mjs   → agrega una línea a sondeos_discord.jsonl y guarda capturas en capturas/sondeos/<sello>/
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire('C:/Users/gcarv/bitacora-tasty/gamma_daemon/package.json');
const puppeteer = require('puppeteer');

const BASE = path.dirname(fileURLToPath(import.meta.url));
const GUILD = '1247978347665948673';
const CANALES = [
  ['bola8', '1249695905133887561'], ['gexbot_classic', '1487119644769779783'], ['hiro', '1487125390119141486'],
  ['gexbot_state', '1490706593896202291'], ['option_flow', '1572620174639763526'], ['tradytics', '1487125311098458283'],
];
const sello = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.join(BASE, 'capturas', 'sondeos', sello);
fs.mkdirSync(dir, { recursive: true });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await puppeteer.launch({ headless: 'new', userDataDir: path.join(BASE, 'discord_profile'), defaultViewport: { width: 1600, height: 950 }, args: ['--mute-audio'] });
const salida = { at: new Date().toISOString(), canales: {} };
try {
  const page = await b.newPage();
  // canales de texto informativos: se buscan por nombre en la barra lateral (no se conocen sus números)
  await page.goto(`https://discord.com/channels/${GUILD}/${CANALES[0][1]}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await esperar(12000);
  // todos los canales de texto del servidor (la barra lateral no expone el nombre: se toma del título de la pestaña)
  const extra = await page.evaluate(() => [...document.querySelectorAll('[data-list-item-id^="channels___"]')]
    .filter((e) => /^Text/.test((e.innerText || '').trim())).map((e) => e.getAttribute('data-list-item-id').replace('channels___', '')));
  for (const id of extra) if (!CANALES.some(([, c]) => c === id)) CANALES.push([null, id]);
  for (let [clave, canal] of CANALES) {
    try {
      if (!clave) clave = canal;
      await page.goto(`https://discord.com/channels/${GUILD}/${canal}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForFunction(() => document.querySelector('[id^="chat-messages"]') || /Join Stage|Listen In|Watch Stream/i.test(document.body.innerText), { timeout: 25000 }).catch(() => {});
      await esperar(4000);
      const r = await page.evaluate(() => {
        const txt = document.body.innerText || '';
        const li = [...document.querySelectorAll('[id^="chat-messages"]')];
        let hora = null;
        const msgs = li.map((l) => { const t = l.querySelector('time'); if (t) hora = t.getAttribute('datetime');
          return { hora, texto: (l.innerText || '').replace(/\s+/g, ' ').slice(0, 160), imgs: [...l.querySelectorAll('img')].filter((i) => i.naturalWidth > 300).length }; });
        const stage = /Join Stage|Listen In/.test(txt);   // canal de escenario: en vivo si alguien transmite
        return { stage, enVivo: stage ? !/No one is currently speaking/i.test(txt) : null, ultimos: msgs.slice(-5) };
      });
      r.nombre = (await page.title()).split('|')[0].trim();
      await page.screenshot({ path: path.join(dir, `${clave}.png`) });
      salida.canales[clave] = r;
    } catch (e) { salida.canales[clave] = { error: String(e.message || e).slice(0, 200) }; }
  }
} finally { await b.close(); }
fs.appendFileSync(path.join(BASE, 'sondeos_discord.jsonl'), JSON.stringify(salida) + '\n');
console.log(JSON.stringify(salida, null, 1));
