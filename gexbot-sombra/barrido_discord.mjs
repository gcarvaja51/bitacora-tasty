// Barrido de herramientas del Discord de Iron Balls (19-nov-2026, decisión de Guillermo: "que lo haga todo solo",
// asumiendo el riesgo de automatizar su cuenta de Discord). SOLO LECTURA: entra como oyente a cada escenario,
// copia el cuadro del video y lee la última Bola 8. Nunca escribe, reacciona ni acepta nada.
//
// Usa un Chromium propio (perfil discord_profile/, separado del Chrome normal) con micrófono FALSO
// (--use-fake-device-for-media-stream): aunque Discord pida audio, nunca toca el micrófono real.
//
// Uso:
//   node barrido_discord.mjs --login        abre la ventana para que Guillermo inicie sesión UNA vez (Claude no toca la clave)
//   node barrido_discord.mjs --barrido      un barrido completo y sale
//   node barrido_discord.mjs --loop 180     barre cada 180 s de 9:30 a 16:00 ET en días hábiles
//   node barrido_discord.mjs --continuo     (24-nov) navegador abierto TODO el día, sin recargar Discord: Bola 8 cada
//                                           60 s y escenarios en rotación continua (el más viejo primero). 9:25 → cierre+2 min
//   node barrido_discord.mjs --continuo --prueba   una vuelta por los 5 escenarios + Bola 8 ignorando el horario, y sale
//   node barrido_discord.mjs --continuo --sin-horario 3   el bucle real (rotación, mínimo 60 s) durante 3 min, fuera de horario
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire('C:/Users/gcarv/bitacora-tasty/gamma_daemon/package.json');
const puppeteer = require('puppeteer');

const BASE = path.dirname(fileURLToPath(import.meta.url));
const PERFIL = path.join(BASE, 'discord_profile');
const CAPTURAS = path.join(BASE, 'capturas');
const GUILD = '1247978347665948673';
const ESCENARIOS = [   // 20-nov: HIRO justo después de Classic (iba de penúltimo y el barrido se cortaba antes de llegar)
  { clave: 'gexbot_classic', canal: '1487119644769779783' },
  { clave: 'hiro',           canal: '1487125390119141486' },
  { clave: 'gexbot_state',   canal: '1490706593896202291' },
  { clave: 'option_flow',    canal: '1572620174639763526' },   // flujo de órdenes (Quant Data)
  { clave: 'tradytics',      canal: '1487125311098458283' },
];
const BOLA8 = '1249695905133887561';
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
// Presupuesto del barrido (21-nov): el proceso se corta a los 6 min; un escenario lento puede tardar ~4 min, así que
// el reintento solo se hace si sobra tiempo y los escenarios no empiezan pasados 200 s (la Bola 8 va primero).
let T0 = Date.now();   // se reinicia al empezar cada barrido (modo --loop)
const transcurrido = () => Date.now() - T0;

function horaNY(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}${p.minute}`, hhmmss: `${p.hour}${p.minute}${p.second}`,
    min: (+p.hour) * 60 + (+p.minute), dia: p.weekday };
}

function log(m) {
  const linea = `[${new Date().toISOString()}] ${m}`;
  console.log(linea);
  fs.appendFileSync(path.join(BASE, 'barrido.log'), linea + '\n');
}

async function abrir(headless) {
  const b = await puppeteer.launch({
    headless: headless ? 'new' : false,
    userDataDir: PERFIL,
    defaultViewport: { width: 1600, height: 950 },
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
      '--window-size=1600,1000', '--mute-audio'],
  });
  // 23-nov: en modo oculto Chrome se presenta como "HeadlessChrome", distinto del Chrome normal con que Guillermo inicia
  // sesión. Discord revocó la sesión ese día (9:31): se usa el mismo agente de usuario que la ventana del login.
  if (headless) {
    const ua = (await b.userAgent()).replace('HeadlessChrome', 'Chrome');
    const poner = async (p) => { try { if (p) await p.setUserAgent(ua); } catch {} };
    for (const p of await b.pages()) await poner(p);
    b.on('targetcreated', async (t) => { if (t.type() === 'page') await poner(await t.page()); });
  }
  return b;
}

// ── Sesión caída (23-nov: 4 horas guardando la pantalla de login sin que nadie se enterara) ─────────────────────
async function sesionCaida(page) {
  try {
    if (/discord\.com\/login/.test(page.url())) return true;
    return await page.evaluate(() => /Please log in again|Choose an account|Inicia sesión de nuevo|Elige una cuenta/i.test(document.body?.innerText || ''));
  } catch { return false; }
}
// Aviso por WhatsApp a Guillermo (línea Colombia, chat propio) vía GOWA local; una vez por día (archivo aviso_sesion.txt)
async function avisarSesion(motivo) {
  const hoy = horaNY().fecha, marca = path.join(BASE, 'aviso_sesion.txt');
  try { if (fs.readFileSync(marca, 'utf8').trim() === hoy) return; } catch {}
  const WA = 'C:/Users/gcarv/Documents/CARPETA PERSONAL/whatsapp';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(WA, 'cuentas.json'), 'utf8')).colombia;
    const txt = fs.readFileSync(path.join(WA, 'credenciales.txt'), 'utf8');
    const u = /usuario:\s*(\S+)/.exec(txt)?.[1], pw = /password:\s*(\S+)/.exec(txt)?.[1];
    const r = await fetch('http://127.0.0.1:3001/send/message', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': cfg.device_id, Authorization: 'Basic ' + Buffer.from(`${u}:${pw}`).toString('base64') },
      body: JSON.stringify({ phone: '573186252537@s.whatsapp.net', message:
        `⚠️ Bot Discord (GexBot/Bola 8/HIRO): la sesión está CERRADA (${motivo}, ${h2(horaNY())} ET). ` +
        'Para reloguear en el PC: node gexbot-sombra/barrido_discord.mjs --login → Log in → QR → esperar los servidores → cerrar la ventana.' }) });
    log(`aviso de sesión caída por WhatsApp: ${r.status}`);
    if (r.ok) fs.writeFileSync(marca, hoy);
  } catch (e) { log('aviso de sesión caída: no se pudo enviar (' + e.message + ')'); }
}
const h2 = (h) => `${h.hhmm.slice(0, 2)}:${h.hhmm.slice(2)}`;

async function guardarDataURL(dataURL, archivo) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  // 24-nov: escritura atómica (.tmp + rename): confluencia --continuo vigila la carpeta cada 10 s y no debe leer un PNG a medias
  fs.writeFileSync(archivo + '.tmp', Buffer.from(dataURL.split(',')[1], 'base64'));
  fs.renameSync(archivo + '.tmp', archivo);
}

async function clicPorTexto(page, textos) {
  // Respeta el ORDEN de `textos` (antes tomaba el primero del DOM, y el aviso "Live Now: gexbot" de la barra
  // lateral tiene un "Listen In" que siempre llevaba a GexBot Classic).
  return page.evaluate((textos) => {
    const els = [...document.querySelectorAll('button, [role="button"]')].filter((e) => e.offsetParent);
    for (const t of textos) {
      const b = els.find((e) => (e.innerText || '').trim().toLowerCase() === t.toLowerCase());
      if (b) { b.click(); return t; }
    }
    return null;
  }, textos);
}

async function capturarEscenario(page, esc, carpeta, h) {
  // 20-nov: la página de "option flow" a veces tarda más de 60 s: 90 s y un reintento
  try { await page.goto(`https://discord.com/channels/${GUILD}/${esc.canal}`, { waitUntil: 'domcontentloaded', timeout: 90000 }); }
  catch (e) {
    if (transcurrido() > 150000) throw new Error('la página tardó y no queda tiempo para reintentar');
    log(`${esc.clave}: la página tardó, reintento`); await page.goto(`https://discord.com/channels/${GUILD}/${esc.canal}`, { waitUntil: 'domcontentloaded', timeout: 90000 }); }
  await esperar(4000);
  // Entrar SIEMPRE con clic en "Join Stage" (antes se colgaba del video del escenario anterior).
  // Si quedó conectado a otro, Discord pregunta "You sure?" -> Confirm.
  for (let i = 0; i < 2; i++) {   // 20-nov: 2 intentos (3 alargaban el barrido >7 min cuando un escenario no carga)
    const conectadoAqui = await page.evaluate((canal) => {
      const panel = document.querySelector('[class*="rtcConnectionStatus"], [class*="connection_"]')?.closest('section, div[class*="panels"]');
      const a = panel ? panel.querySelector(`a[href*="${canal}"]`) : null;
      return !!a && [...document.querySelectorAll('video')].some((v) => v.videoWidth > 0);
    }, esc.canal);
    if (conectadoAqui) break;
    const c = await clicPorTexto(page, ['Join Stage', 'Unirse al escenario']);   // NUNCA "Listen In" (es el aviso de la barra lateral)
    await esperar(1500);
    if (c) await page.evaluate(() => {   // 21-nov: solo el diálogo "You sure?" de cambiar de escenario, nunca otro Confirm
      const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => /you sure|are you sure|seguro/i.test(d.innerText || ''));
      const b = dlg && [...dlg.querySelectorAll('button')].find((e) => /^(confirm|confirmar)$/i.test((e.innerText || '').trim()));
      if (b) b.click();
    });
    // 20-nov: el RTC de Discord a veces tarda ("RTC Connecting"): esperar hasta 25 s a que llegue el video en vez de un tiempo fijo
    let llego = false;
    for (let s = 0; s < 25 && !llego; s++) {
      await esperar(1000);
      llego = await page.evaluate(() => [...document.querySelectorAll('video')].some((v) => v.videoWidth > 0 && v.getBoundingClientRect().left > 380));
    }
    if (llego) break;
    if (!c) {
      // Si la transmisión se ve como miniatura, un clic en el recuadro LIVE la agranda.
      await page.evaluate(() => { const t = [...document.querySelectorAll('[class*="tile"], [class*="Tile"]')].find((e) => /LIVE/.test(e.innerText || '')); if (t) t.click(); });
      await esperar(2500);
    }
  }
  await esperar(2500);
  const r = await page.evaluate(() => {
    // Solo el video del área principal: la barra lateral tiene la miniatura de "Live Now: gexbot" (siempre Classic).
    const vs = [...document.querySelectorAll('video')]
      .filter((v) => v.videoWidth > 0 && v.getBoundingClientRect().left > 380)   // la miniatura mide ~290 px en pantalla, pero el video trae 1280x716
      .sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight);
    if (!vs.length) return null;
    const v = vs[0];
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    return { w: v.videoWidth, h: v.videoHeight, data: c.toDataURL('image/png') };
  });
  if (!r) {
    await page.screenshot({ path: path.join(carpeta, `${h.hhmmss}_${esc.clave}_SIN_VIDEO_pagina.png`) }).catch(() => {});
    log(`${esc.clave}: sin video (¿la transmisión no está en vivo?) — foto de la página guardada`);
    await colgar(page);
    return null;
  }
  const archivo = path.join(carpeta, `${h.hhmmss}_${esc.clave}.png`);
  await guardarDataURL(r.data, archivo);
  log(`${esc.clave}: ${r.w}x${r.h} -> ${path.basename(archivo)}`);
  await colgar(page);
  return archivo;
}

async function colgar(page) {
  // Salir del escenario para que el siguiente entre limpio (y no quede el video viejo en pantalla).
  await page.evaluate(() => {
    const b = document.querySelector('button[aria-label="Disconnect"], button[aria-label="Desconectar"], [aria-label="Disconnect"]');
    if (b) b.click();
  });
  await esperar(2000);
}

async function capturarBola8(page, carpeta, rapido = false) {
  // rapido (modo --continuo, 24-nov): se llega al canal sin recargar (irCanal) y solo se miran los mensajes DE ESTE
  // canal (id chat-messages-<canal>-<mensaje>): el chat del escenario anterior podría seguir en el DOM un instante.
  const sel = rapido ? `[id^="chat-messages-${BOLA8}"]` : '[id^="chat-messages"]';
  if (rapido) await irCanal(page, BOLA8);
  else await page.goto(`https://discord.com/channels/${GUILD}/${BOLA8}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // 20-nov: Discord carga lento: esperar hasta 20 s a que aparezca el último informe (texto o imagen)
  await page.waitForFunction((sel) => [...document.querySelectorAll(sel)].some((l) => /Prediction for SPX/.test(l.innerText || '') || l.querySelector('img[src*="attachments"]')), { timeout: 20000, polling: 250 }, sel).catch(() => {});
  if (!rapido) await esperar(1500);
  const r = await page.evaluate(async (sel, rapido) => {
    const sc = [...document.querySelectorAll('[class*="scroller"]')].find((e) => e.querySelector(sel));
    if (sc) sc.scrollTop = sc.scrollHeight;
    await new Promise((ok) => setTimeout(ok, rapido ? 700 : 2000));
    const li = [...document.querySelectorAll(sel)];
    const conImg = li.filter((l) => [...l.querySelectorAll('img')].some((i) => i.naturalWidth > 300));
    // 20-nov: la Bola 8 (v1.0.37) a veces publica TEXTO ("Prediction for SPX ..."). Se toma el informe MÁS NUEVO en el
    // orden del chat, sea texto o imagen (auditoría: antes, si quedaban imágenes viejas cargadas, el texto nuevo se perdía)
    const tx = li.filter((l) => /Prediction for SPX/.test(l.innerText || ''));
    const horaDe = (m) => { for (let i = li.indexOf(m); i >= 0; i--) { const t = li[i].querySelector('time'); if (t) return t.getAttribute('datetime'); } return null; };
    const posTx = tx.length ? li.indexOf(tx[tx.length - 1]) : -1, posImg = conImg.length ? li.indexOf(conImg[conImg.length - 1]) : -1;
    if (posTx > posImg) {
      const u = tx[tx.length - 1];
      return { cuando: horaDe(u), imgs: [], texto: u.innerText };
    }
    if (!conImg.length) return null;
    const ultimo = conImg.slice(-2);
    const cuando = horaDe(ultimo[0]);
    const out = [];
    for (const l of ultimo) {
      for (const im of [...l.querySelectorAll('img')].filter((i) => i.naturalWidth > 300)) {
        const u = im.src.replace(/width=\d+&height=\d+&?/, '');
        const b = await new Promise((ok, ko) => { const x = new Image(); x.crossOrigin = 'anonymous'; x.onload = () => ok(x); x.onerror = ko; x.src = u; });
        const c = document.createElement('canvas'); c.width = b.naturalWidth; c.height = b.naturalHeight; c.getContext('2d').drawImage(b, 0, 0);
        out.push(c.toDataURL('image/png'));
      }
    }
    return { cuando, imgs: out };
  }, sel, rapido);
  if (r && !r.cuando) { log('bola8: informe sin hora, no se guarda'); return []; }
  if (r && !r.imgs.length && r.texto) {
    const marca = (r.cuando || '').replace(/[-:T]/g, '').slice(0, 12);
    const archivo = path.join(carpeta, `bola8_${marca}_texto.txt`);
    const nuevo = !fs.existsSync(archivo);
    if (nuevo) { fs.writeFileSync(archivo + '.tmp', r.texto, 'utf8'); fs.renameSync(archivo + '.tmp', archivo); }
    log(`bola8: texto ${r.cuando} (${nuevo ? 1 : 0} nuevo)`);
    return nuevo ? [archivo] : [];
  }
  if (!r || !r.imgs.length) { log('bola8: sin imágenes'); return []; }
  const marca = (r.cuando || '').replace(/[-:T]/g, '').slice(0, 12);
  const hechos = [];
  for (const [i, d] of r.imgs.entries()) {
    const archivo = path.join(carpeta, `bola8_${marca}_${i === 0 ? 'paneles' : 'sonar'}.png`);
    if (!fs.existsSync(archivo)) { await guardarDataURL(d, archivo); hechos.push(archivo); }
  }
  log(`bola8: informe ${r.cuando} (${hechos.length} nuevas)`);
  return hechos;
}

async function barrido(browser) {
  T0 = Date.now();
  const h = horaNY();
  const carpeta = path.join(CAPTURAS, h.fecha);
  fs.mkdirSync(carpeta, { recursive: true });   // antes de capturar: así se guardan también las fotos SIN_VIDEO
  const page = (await browser.pages())[0] || await browser.newPage();
  const res = { at: new Date().toISOString(), hora_ny: h.hhmmss, archivos: {} };
  // 21-nov: la Bola 8 PRIMERO (texto, ~15 s; es la que vota: al final se perdía cuando Discord estaba lento) y luego
  // GexBot Classic (alimenta el histograma de TV) y el resto.
  try { res.archivos.bola8 = await capturarBola8(page, carpeta); } catch (e) { log('bola8 error: ' + e.message); }
  if (await sesionCaida(page)) {   // 23-nov: sin sesión no tiene sentido seguir: aviso y fuera
    log('barrido: la sesión de Discord está CERRADA (pantalla de login); se avisa y se corta el ciclo');
    res.sesion = 'cerrada'; await avisarSesion('barrido');
    fs.appendFileSync(path.join(carpeta, 'barridos.jsonl'), JSON.stringify(res) + '\n');
    return res;
  }
  // 23-nov: rotación. Con Discord lento Tradytics (última) se saltaba en TODOS los ciclos. Lo que se saltó en el ciclo
  // anterior va primero en este, justo después de Classic (que sigue adelante: alimenta el histograma de TV).
  // 24-nov: la rotación por "saltados del ciclo anterior" fallaba cuando se saltaban TODOS (volvía al orden fijo y
  // option_flow, 4.º, no se capturó desde las 13:18 ET). Ahora el orden es por ÚLTIMA CAPTURA BUENA: el que lleva más
  // tiempo sin foto va primero (después de Classic). Se guarda en ultimas_capturas.json {clave: epoch ms}.
  const fUlt = path.join(BASE, 'ultimas_capturas.json');
  let ult = {}; try { ult = JSON.parse(fs.readFileSync(fUlt, 'utf8')) || {}; } catch {}
  const orden = [ESCENARIOS[0], ...ESCENARIOS.slice(1).sort((a, b) => (ult[a.clave] || 0) - (ult[b.clave] || 0))];
  for (const esc of orden) {
    if (transcurrido() > 200000) { log(`${esc.clave}: se salta (barrido sin tiempo)`); continue; }
    try { res.archivos[esc.clave] = await capturarEscenario(page, esc, carpeta, h); } catch (e) { log(`${esc.clave} error: ${e.message}`); }
    // un intento fallido también cuenta como turno (si no, un escenario caído acapararía el primer puesto)
    ult[esc.clave] = res.archivos[esc.clave] ? Date.now() : Date.now() - 60000;
  }
  try { fs.writeFileSync(fUlt, JSON.stringify(ult)); } catch {}
  fs.mkdirSync(carpeta, { recursive: true });
  fs.appendFileSync(path.join(carpeta, 'barridos.jsonl'), JSON.stringify(res) + '\n');
  return res;
}

// ══ MODO CONTINUO (24-nov-2026, pedido de Guillermo: "0 DTE y scalping, cada minuto cuenta") ══════════════════════
// Antes cada ciclo abría un Chromium nuevo y cada escenario recargaba Discord entero (60-150 s): huecos de 8-28 min
// por escenario (máximos de 65-96). Ahora el navegador se abre UNA vez, se cambia de canal con la navegación interna
// de Discord (history.pushState + popstate, sin recargar) y las esperas fijas pasan a ser esperas a condiciones.
const ULTIMAS = path.join(BASE, 'ultimas_capturas.json');
const LATIDO = path.join(BASE, 'latido_captura.txt');
const TOPE_ESCENARIO = 75000;   // por escenario; si se pasa, se recarga la página para recuperar
// cada escenario se vuelve a capturar como mucho cada 60 s (con Discord ya abierto una vuelta de los 5 tarda ~35 s)
const MIN_ENTRE_CAPTURAS = 90000;   // 24-nov: Guillermo eligió 90 s (equilibrio frescura / riesgo de la cuenta de Discord); bajar a 60000 si Discord no protesta
// Promise.race con tope que limpia su temporizador (un rechazo suelto tumbaría node con "unhandled rejection")
function conTope(promesa, ms, msg, alCortar) {
  let t;
  const tope = new Promise((_, ko) => { t = setTimeout(() => { if (alCortar) alCortar(); ko(new Error(msg)); }, ms); });
  promesa.catch(() => {});   // si pierde la carrera y luego falla, que no quede un rechazo sin atender
  return Promise.race([promesa, tope]).finally(() => clearTimeout(t));
}
const seg = (t0) => ((Date.now() - t0) / 1000).toFixed(1);

// Calendario NYSE (única fuente, en la bitácora), igual que tv_dibujar.mjs / confluencia.py. Minuto NY del cierre o null.
function cierreDelDia(fecha, dia) {
  if (['Sat', 'Sun'].includes(dia)) return null;
  let cal = null;
  try { cal = JSON.parse(fs.readFileSync(path.join(BASE, '..', '..', 'Bitacoras', 'bitacora-tasty', 'src', 'calendario_nyse.json'), 'utf8')); }
  catch { log('[aviso] sin calendario NYSE: se asume día hábil normal'); return 16 * 60; }
  if ((cal.feriados || []).includes(fecha)) return null;
  return (cal.mediosDias || []).includes(fecha) ? 13 * 60 : 16 * 60;
}

// REGLA CRÍTICA: nunca dos procesos con discord_profile a la vez (Discord revoca la sesión)
function otroUsandoPerfil() {
  const ps = "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*discord_profile*') -or " +
    `($_.Name -eq 'node.exe' -and $_.CommandLine -like '*barrido_discord.mjs*' -and $_.ProcessId -ne ${process.pid}) } | ` +
    "ForEach-Object { [string]$_.ProcessId + ' ' + $_.Name }";
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 45000, windowsHide: true })
      .split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  } catch (e) { log('continuo: no se pudo revisar los procesos (' + e.message + '); se sigue'); return []; }
}

// Cambio de canal SIN recargar. Devuelve el método usado ('ya' | 'push' | 'clic' | 'goto').
async function irCanal(page, canal) {
  const ruta = `/channels/${GUILD}/${canal}`;
  try { if (new URL(page.url()).pathname === ruta) return 'ya'; } catch {}
  if (/discord\.com\/channels\//.test(page.url())) {
    // Para el canal de TEXTO (Bola 8) sirve el enlace de la barra lateral; en los escenarios NO (un clic en un canal de
    // voz/escenario puede conectarse solo): ahí va pushState + popstate, que mueve el enrutador de Discord.
    const vista = () => (document.querySelector('main, [class*="chat_"], [class*="chatContent"]') || document.body).innerText.slice(0, 300);
    const antes = await page.evaluate(vista).catch(() => '');
    const metodo = await page.evaluate((r, texto) => {
      const a = texto ? document.querySelector(`a[href="${r}"]`) : null;
      if (a) { a.click(); return 'clic'; }
      history.pushState(history.state, '', r);
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
      return 'push';
    }, ruta, canal === BOLA8).catch(() => null);
    // la URL cambió y el enrutador de Discord pintó el canal nuevo (su vista ya no es la del canal anterior); tope 10 s.
    // (Que de verdad cargó lo confirma después la espera a "Join Stage"/video o a los mensajes de la Bola 8.)
    const ok = metodo && await page.waitForFunction((r, antes) => location.pathname === r
      && (document.querySelector('main, [class*="chat_"], [class*="chatContent"]') || document.body).innerText.slice(0, 300) !== antes,
    { timeout: 10000, polling: 100 }, ruta, antes).then(() => true).catch(() => false);
    if (ok) return metodo;
    log(`irCanal: la navegación interna no cambió el canal ${canal} en 10 s; se recarga`);
  }
  await page.goto('https://discord.com' + ruta, { waitUntil: 'domcontentloaded', timeout: 90000 });
  return 'goto';
}

const hayVideoPrincipal = () => [...document.querySelectorAll('video')].some((v) => v.videoWidth > 0 && v.getBoundingClientRect().left > 380);

// Igual que capturarEscenario (Join Stage nunca "Listen In", "You sure?" → Confirm, video del área principal left > 380,
// colgar al final, foto SIN_VIDEO), pero sin recargar y con esperas a condiciones. `corte.ya` = se pasó el tope: no guarda.
async function capturarEscenarioRapido(page, esc, carpeta, corte) {
  const t0 = Date.now();
  const metodo = await irCanal(page, esc.canal);
  const tCanal = seg(t0);
  // en vez de 4 s fijos: hasta 10 s a que aparezca "Join Stage"/"Unirse al escenario" o el video
  await page.waitForFunction(() => {
    const els = [...document.querySelectorAll('button, [role="button"]')].filter((e) => e.offsetParent);
    return els.some((e) => /^(join stage|unirse al escenario)$/i.test((e.innerText || '').trim()))
      || [...document.querySelectorAll('video')].some((v) => v.videoWidth > 0 && v.getBoundingClientRect().left > 380);
  }, { timeout: 10000, polling: 200 }).catch(() => {});
  const tListo = seg(t0);
  let llego = false;
  for (let i = 0; i < 2 && !llego && !corte.ya; i++) {
    const conectadoAqui = await page.evaluate((canal) => {
      const panel = document.querySelector('[class*="rtcConnectionStatus"], [class*="connection_"]')?.closest('section, div[class*="panels"]');
      const a = panel ? panel.querySelector(`a[href*="${canal}"]`) : null;
      return !!a && [...document.querySelectorAll('video')].some((v) => v.videoWidth > 0);
    }, esc.canal);
    if (conectadoAqui) { llego = await page.evaluate(hayVideoPrincipal); if (llego) break; }
    const c = await clicPorTexto(page, ['Join Stage', 'Unirse al escenario']);   // NUNCA "Listen In"
    if (c) {
      // solo el diálogo "You sure?" de cambiar de escenario, nunca otro Confirm (hasta 2 s a que aparezca)
      for (let k = 0; k < 8; k++) {
        await esperar(250);
        const hecho = await page.evaluate(() => {
          const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => /you sure|are you sure|seguro/i.test(d.innerText || ''));
          const b = dlg && [...dlg.querySelectorAll('button')].find((e) => /^(confirm|confirmar)$/i.test((e.innerText || '').trim()));
          if (b) { b.click(); return true; }
          return false;
        });
        if (hecho || await page.evaluate(hayVideoPrincipal)) break;
      }
      // el RTC a veces tarda ("RTC Connecting"): hasta 25 s a que llegue el video
      llego = await page.waitForFunction(hayVideoPrincipal, { timeout: 25000, polling: 250 }).then(() => true).catch(() => false);
    } else {
      // sin botón: si la transmisión se ve como miniatura, un clic en el recuadro LIVE la agranda; si no hay ni eso,
      // el escenario no está en vivo y no tiene sentido esperar 25 s
      const tile = await page.evaluate(() => { const t = [...document.querySelectorAll('[class*="tile"], [class*="Tile"]')].find((e) => /LIVE/.test(e.innerText || '')); if (t) { t.click(); return true; } return false; });
      if (!tile) break;
      llego = await page.waitForFunction(hayVideoPrincipal, { timeout: 8000, polling: 250 }).then(() => true).catch(() => false);
    }
  }
  if (llego) await esperar(2500);   // igual que antes: deja asentar el cuadro antes de copiarlo
  if (corte.ya) return null;
  const h = horaNY();
  const r = llego ? await page.evaluate(() => {
    const vs = [...document.querySelectorAll('video')]
      .filter((v) => v.videoWidth > 0 && v.getBoundingClientRect().left > 380)
      .sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight);
    if (!vs.length) return null;
    const v = vs[0];
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    return { w: v.videoWidth, h: v.videoHeight, data: c.toDataURL('image/png') };
  }) : null;
  if (corte.ya) return null;
  if (!r) {
    await page.screenshot({ path: path.join(carpeta, `${h.hhmmss}_${esc.clave}_SIN_VIDEO_pagina.png`) }).catch(() => {});
    await colgarRapido(page);
    log(`${esc.clave}: sin video (¿no está en vivo?) — canal ${tCanal}s (${metodo}), listo ${tListo}s, total ${seg(t0)}s`);
    return null;
  }
  const archivo = path.join(carpeta, `${h.hhmmss}_${esc.clave}.png`);
  await guardarDataURL(r.data, archivo);
  const tFoto = seg(t0);
  await colgarRapido(page);
  log(`${esc.clave}: ${r.w}x${r.h} -> ${path.basename(archivo)} — canal ${tCanal}s (${metodo}), listo ${tListo}s, foto ${tFoto}s, total ${seg(t0)}s`);
  return archivo;
}

async function colgarRapido(page) {
  const hubo = await page.evaluate(() => {
    const b = document.querySelector('button[aria-label="Disconnect"], button[aria-label="Desconectar"], [aria-label="Disconnect"]');
    if (b) { b.click(); return true; }
    return false;
  }).catch(() => false);
  // en vez de 2 s fijos: hasta 3 s a que se vaya el video principal
  if (hubo) await page.waitForFunction(() => ![...document.querySelectorAll('video')].some((v) => v.videoWidth > 0 && v.getBoundingClientRect().left > 380),
    { timeout: 3000, polling: 200 }).catch(() => {});
}

function anotarCaptura(carpeta, clave, archivo) {
  try { fs.appendFileSync(path.join(carpeta, 'capturas.jsonl'), JSON.stringify({ at: new Date().toISOString(), clave, archivo: path.basename(archivo) }) + '\n'); } catch {}
}

async function continuo(prueba, sinHorarioMin = 0) {
  const finSinHorario = sinHorarioMin ? Date.now() + sinHorarioMin * 60000 : 0;   // prueba del bucle real fuera de horario
  // un error suelto de puppeteer no puede tumbar la captura de todo el día
  process.on('unhandledRejection', (e) => log('continuo: rechazo sin atender (se sigue): ' + (e?.message || e)));
  // (el --chequeo de las 8:15 acaba de cerrar su Chromium: se dan hasta 2 min a que desaparezca antes de rendirse)
  const perfilLibre = async () => {
    for (let i = 0; i < 12; i++) {
      const otros = otroUsandoPerfil();
      if (!otros.length) return true;
      if (i === 11) log(`continuo: NO arranca — ya hay otro proceso con discord_profile/barrido (${otros.join(', ')}); dos a la vez revocan la sesión`);
      else await esperar(10000);
    }
    return false;
  };
  if (!await perfilLibre()) { process.exitCode = 4; return; }
  // espera a la ventana 9:25 → cierre (+2 min); fuera de ella no abre el navegador
  if (!prueba && !finSinHorario) {
    for (;;) {
      const h = horaNY(), cierre = cierreDelDia(h.fecha, h.dia);
      if (cierre === null) { log('continuo: hoy no hay mercado (fin de semana o feriado NYSE): termina'); return; }
      if (h.min > cierre + 2) { log('continuo: la sesión ya cerró: termina'); return; }
      if (h.min >= 9 * 60 + 25) break;
      try { fs.writeFileSync(LATIDO, String(Date.now())); } catch {}
      await esperar(20000);
    }
  }
  if (!prueba && !await perfilLibre()) { process.exitCode = 4; return; }   // de nuevo justo antes de abrir (9:25)
  log(`continuo: arranca${prueba ? ' (PRUEBA: una vuelta, sin horario)' : ''}`);
  let b = null, page = null;
  const abrirTodo = async () => {
    const t0 = Date.now();
    try { if (b) await b.close(); } catch {}
    b = await abrir(true);
    page = (await b.pages())[0] || await b.newPage();
    await page.goto(`https://discord.com/channels/${GUILD}/${BOLA8}`, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch((e) => log('continuo: carga inicial lenta (' + e.message + ')'));
    log(`continuo: navegador y Discord cargados en ${seg(t0)}s`);
  };
  const recuperable = (e) => /Target closed|Session closed|disconnected|Protocol error|detached|crashed|Execution context was destroyed/i.test(e?.message || '');
  const recargar = () => page.goto(`https://discord.com/channels/${GUILD}/${BOLA8}`, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  await abrirTodo();
  let ult = {}; try { ult = JSON.parse(fs.readFileSync(ULTIMAS, 'utf8')) || {}; } catch {}
  let ultBola8 = 0, vuelta = 0;
  const pendientesPrueba = [...ESCENARIOS];
  try {
    for (;;) {
      const h = horaNY();
      if (finSinHorario) {
        if (Date.now() > finSinHorario) { log('continuo: fin de la prueba sin horario'); break; }
      } else if (!prueba) {
        const cierre = cierreDelDia(h.fecha, h.dia);
        if (cierre === null || h.min > cierre + 2) { log('continuo: cierre de la sesión (+2 min): se cierra el navegador y termina'); break; }
      } else if (!pendientesPrueba.length && ultBola8) break;
      vuelta++;
      try { fs.writeFileSync(LATIDO, String(Date.now())); } catch {}
      const carpeta = path.join(CAPTURAS, h.fecha);
      fs.mkdirSync(carpeta, { recursive: true });
      try {
        // ── Bola 8: cada ≥ 60 s (solo leer el canal)
        if (Date.now() - ultBola8 >= 60000) {
          const t0 = Date.now();
          let hechos = [];
          try {
            hechos = await conTope(capturarBola8(page, carpeta, true), 45000, 'pasó de 45 s');
          } catch (e) {
            log('bola8 error: ' + e.message);
            if (recuperable(e)) throw e;
            await recargar();
          }
          ultBola8 = Date.now();
          for (const f of hechos || []) anotarCaptura(carpeta, 'bola8', f);
          log(`bola8: revisada en ${seg(t0)}s (${(hechos || []).length} archivos nuevos)`);
          if (await sesionCaida(page)) {
            log('continuo: la sesión de Discord está CERRADA (pantalla de login); aviso y reintento en 2 min');
            await avisarSesion('captura continua');
            if (prueba) break;
            await esperar(120000);
            await recargar();
            ultBola8 = 0;
            continue;
          }
        }
        // ── Escenario: el que lleva MÁS tiempo sin captura buena (en prueba, los 5 en orden). Si hasta el más viejo tiene
        // menos de MIN_ENTRE_CAPTURAS, se espera (sin esto entraba y salía de los escenarios cada ~35 s todo el día).
        let esc = prueba ? pendientesPrueba.shift()
          : [...ESCENARIOS].sort((a, c) => (ult[a.clave] || 0) - (ult[c.clave] || 0))[0];
        if (!prueba && esc && Date.now() - (ult[esc.clave] || 0) < MIN_ENTRE_CAPTURAS) {
          const falta = Math.min(MIN_ENTRE_CAPTURAS - (Date.now() - (ult[esc.clave] || 0)), 60000 - (Date.now() - ultBola8));
          await esperar(Math.max(500, Math.min(falta, 5000)));
          esc = null;
        }
        if (esc) {
          const t0 = Date.now(), corte = { ya: false };
          let archivo = null;
          try {
            archivo = await conTope(capturarEscenarioRapido(page, esc, carpeta, corte), TOPE_ESCENARIO,
              `pasó el tope de ${TOPE_ESCENARIO / 1000} s`, () => { corte.ya = true; });
          } catch (e) {
            corte.ya = true;
            log(`${esc.clave} error: ${e.message} (${seg(t0)}s); se recarga la página para recuperar`);
            if (recuperable(e)) throw e;
            await colgarRapido(page);
            await recargar();
          }
          // un intento fallido también cuenta como turno, con penalización de 60 s
          ult[esc.clave] = archivo ? Date.now() : Date.now() - 60000;
          try { fs.writeFileSync(ULTIMAS, JSON.stringify(ult)); } catch {}
          if (archivo) anotarCaptura(carpeta, esc.clave, archivo);
        }
      } catch (e) {
        if (!recuperable(e)) { log('continuo: error en la vuelta ' + vuelta + ': ' + e.message); await esperar(5000); continue; }
        log('continuo: el navegador se cayó (' + e.message + '): se vuelve a abrir');
        try { await abrirTodo(); } catch (e2) { log('continuo: no se pudo reabrir (' + e2.message + '); reintento en 30 s'); await esperar(30000); }
      }
    }
  } finally {
    try { await colgarRapido(page); } catch {}
    try { await b.close(); } catch {}
    log('continuo: navegador cerrado');
  }
}

const args = process.argv.slice(2);
if (args.includes('--login')) {
  const b = await abrir(false);
  const p = (await b.pages())[0];
  await p.goto('https://discord.com/login');
  log('Ventana de login abierta: Guillermo inicia sesión y luego cierra la ventana.');
  await new Promise((ok) => b.on('disconnected', ok));
} else if (args.includes('--chequeo')) {
  // 23-nov: chequeo de sesión al arrancar la tarea (8:15): si está cerrada, aviso con tiempo para reloguear antes de 9:25
  const b = await abrir(true);
  try {
    const p = (await b.pages())[0] || await b.newPage();
    await p.goto('https://discord.com/channels/@me', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await esperar(8000);
    if (await sesionCaida(p)) { log('chequeo: sesión de Discord CERRADA'); await avisarSesion('chequeo de las 8:15'); process.exitCode = 3; }
    else log('chequeo: sesión de Discord OK');
  } finally { await b.close(); }
} else if (args.includes('--continuo')) {
  await continuo(args.includes('--prueba'), args.includes('--sin-horario') ? +args[args.indexOf('--sin-horario') + 1] || 3 : 0);
  process.exit(process.exitCode || 0);
} else if (args.includes('--barrido')) {
  // Tope global (auditoría 20-nov): un barrido nunca pasa de 6 min. Sale con código 2 y confluencia.py cierra el
  // navegador del bot (antes solo lo cortaba Python a los 7 min, con el ciclo ya perdido).
  setTimeout(() => { log('barrido: tope de 6 min alcanzado, se corta'); process.exit(2); }, 360000).unref();
  const b = await abrir(!args.includes('--ver'));
  try { await barrido(b); } finally { await b.close(); }
} else if (args.includes('--loop')) {
  const seg = +args[args.indexOf('--loop') + 1] || 180;
  const b = await abrir(!args.includes('--ver'));
  log(`loop cada ${seg}s`);
  for (;;) {
    const h = horaNY();
    if (!['Sat', 'Sun'].includes(h.dia) && h.min >= 9 * 60 + 25 && h.min <= 16 * 60) {
      const t0 = Date.now();
      try { await barrido(b); } catch (e) { log('barrido error: ' + e.message); }
      await esperar(Math.max(5000, seg * 1000 - (Date.now() - t0)));
    } else {
      await esperar(60000);
    }
  }
}
