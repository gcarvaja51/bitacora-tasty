// Revisión puntual (23-nov-2026): ¿Emerson juntó las 2 transmisiones (Classic + State) en el stage gexbot? Solo lectura, sin entrar al stage.
import path from 'path';
import { createRequire } from 'module';
const require = createRequire('C:/Users/gcarv/bitacora-tasty/gamma_daemon/package.json');
const puppeteer = require('puppeteer');
const BASE = process.argv[2];
const b = await puppeteer.launch({ headless: 'new', userDataDir: path.join(BASE, 'discord_profile'), defaultViewport: { width: 1600, height: 1400 }, args: ['--mute-audio'] });
try {
  const p = await b.newPage();
  for (const [n, c] of [['gexbot', '1487119644769779783'], ['gexbot_state', '1490706593896202291']]) {
    await p.goto(`https://discord.com/channels/1247978347665948673/${c}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await new Promise(r => setTimeout(r, 12000));
    const info = await p.evaluate((c) => {
      const it = document.querySelector(`[data-list-item-id="channels___${c}"]`);
      const cont = it ? it.closest('li') : null;
      return { sidebar: cont ? cont.innerText.replace(/\n+/g, ' | ') : null,
               main: (document.querySelector('main') || document.body).innerText.replace(/\n+/g, ' | ').slice(0, 400) };
    }, c);
    console.log(n, JSON.stringify(info));
    await p.screenshot({ path: path.join(BASE, 'capturas', 'sondeos', `stage_${n}_${new Date().toISOString().slice(0,16).replace(':','')}.png`) });
  }
} finally { await b.close(); }
