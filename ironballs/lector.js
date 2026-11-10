// ── Lector de Iron Balls — corre en el PC o en Vultr, NO se despliega en Railway (2026-11-01, v2 2026-11-10) ──
//
// Lee WhatsApp a traves de GOWA (127.0.0.1:3001) y manda al servidor de produccion lo que importa, con el
// TEXTO CRUDO (o la FOTO en base64). Quien decide si se opera es el servidor (re-parsea, mira kill-switch,
// edad, ventana, cupo). El servidor es idempotente por id de mensaje: dos lectores (PC + Vultr) no duplican.
//
// v2 (Guillermo 2026-11-10) — tres grupos, y en cada señal queda el rastro de QUIEN la mando:
//   - "📈 Canal Oficial - Iron Balls 📈" (linea USA)   → solo Pipe: "Options Alert" y "⚠️ CLOSED"
//   - "📊 CHAT V.I.P ☄️☄️"            (linea USA)   → solo Pipe: las mismas tarjetas (a veces SOLO aca, y
//                                                      minutos antes; otros miembros pegan tarjetas: se ignoran)
//   - "Operaciones by Iron Balls"      (linea COLOMBIA) → Alejandro/Emerson: la FOTO de OptionStrat con los
//                                                      strikes (POST /api/ironballs/ale) y los textos de Alejandro
//                                                      ("Fuera +40", "Nivel de control", "Dentro con")
//
// Uso:
//   node ironballs/lector.js            # bucle: cada 10 s en dia de mercado 9:00-16:15 ET
//   node ironballs/lector.js --una-vez  # una pasada y sale (diagnostico)
//   node ironballs/lector.js --seco     # lee y parsea, NO manda nada al servidor
//
// Configuracion en ironballs/.env (no versionado):
//   IRONBALLS_TOKEN=...                 # la misma clave que en Railway; sin ella corre en seco
//   IRONBALLS_URL=https://web-production-23473.up.railway.app   (default)
//   En Vultr: GOWA_USER, GOWA_PASS, GOWA_DEVICE_USA, GOWA_DEVICE_COLOMBIA (GOWA_DEVICE = USA, compatibilidad)
//
// Estado en ironballs/estado.json (ids ya vistos por grupo) y ironballs/status.json (latido).
// La PRIMERA vez que ve un grupo marca como vistos todos sus mensajes, sin mandarlos: el historial no se copia.

const fs = require('fs');
const path = require('path');
const ib = require('../src/ironballs');
const ale = require('../src/ironballs_ale');
const calendario = require('../src/calendario_nyse');

const DIR = __dirname;
const WHATSAPP_DIR = 'C:/Users/gcarv/Documents/CARPETA PERSONAL/whatsapp';
const GOWA = process.env.GOWA_URL || 'http://127.0.0.1:3001';
const PIPE_JID = '14077487451@s.whatsapp.net';
const AUTORES = {
  [PIPE_JID]: 'Pipe Andrade',
  '5491132318348@s.whatsapp.net': 'Alejandro',
  '18287810664@s.whatsapp.net': 'Emerson Flores',
};
const FUENTES = [
  { id: 'canal', cuenta: 'usa', jid: '120363233546136336@g.us', grupo: 'Canal Oficial', modo: 'pipe' },
  { id: 'vip', cuenta: 'usa', jid: '120363399540609677@g.us', grupo: 'Chat VIP', modo: 'pipe' },
  { id: 'operaciones', cuenta: 'colombia', jid: '120363189733565990@g.us', grupo: 'Operaciones', modo: 'ale' },
];
const FOTO_AUTORES = new Set(['5491132318348@s.whatsapp.net', '18287810664@s.whatsapp.net']);   // Alejandro, Emerson
const TEXTO_AUTORES = new Set(['5491132318348@s.whatsapp.net']);                                 // solo Alejandro
const FOTO_MAX_MIN = 10;     // una foto mas vieja no se manda (el servidor exige <= 5 min; ahorra la lectura)
const CICLO_MS = 10 * 1000;
const AVISO_CAIDA_MIN = 3;   // un grupo que falla 3 min seguidos en mercado manda ntfy (una vez)
const ESTADO = path.join(DIR, 'estado.json');
const STATUS = path.join(DIR, 'status.json');
const LOG = path.join(DIR, 'lector.log');

const args = new Set(process.argv.slice(2));

function leerEnv() {
  const env = {};
  try {
    for (const l of fs.readFileSync(path.join(DIR, '.env'), 'utf8').split(/\r?\n/)) {
      const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* sin .env: en seco */ }
  return env;
}
const ENV = { ...leerEnv(), ...process.env };
const TOKEN = ENV.IRONBALLS_TOKEN || '';
const URL_SERVIDOR = (ENV.IRONBALLS_URL || 'https://web-production-23473.up.railway.app').replace(/\/$/, '');
const SECO = args.has('--seco') || !TOKEN;

function log(msg) {
  const linea = `[${new Date().toISOString()}] ${msg}`;
  console.log(linea);
  try { fs.appendFileSync(LOG, linea + '\n'); } catch { /* el log nunca tumba el lector */ }
}

const cabeceras = {};
function cabecerasGowa(cuenta) {
  if (cabeceras[cuenta]) return cabeceras[cuenta];
  let h;
  if (ENV.GOWA_USER) {   // Vultr: credenciales por entorno
    h = { Authorization: 'Basic ' + Buffer.from(`${ENV.GOWA_USER}:${ENV.GOWA_PASS || ''}`).toString('base64') };
    const dev = cuenta === 'colombia' ? ENV.GOWA_DEVICE_COLOMBIA : (ENV.GOWA_DEVICE_USA || ENV.GOWA_DEVICE);
    if (dev) h['X-Device-Id'] = dev;
  } else {               // PC
    const cred = {};
    for (const l of fs.readFileSync(path.join(WHATSAPP_DIR, 'credenciales.txt'), 'utf8').split(/\r?\n/)) {
      const i = l.indexOf(':');
      if (i > 0) cred[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    }
    h = { 'X-Device-Id': JSON.parse(fs.readFileSync(path.join(WHATSAPP_DIR, 'cuentas.json'), 'utf8'))[cuenta].device_id };
    if (cred.usuario && cred.password) h.Authorization = 'Basic ' + Buffer.from(`${cred.usuario}:${cred.password}`).toString('base64');
  }
  return (cabeceras[cuenta] = h);
}

async function ultimosMensajes(f, limite = 60) {
  const r = await fetch(`${GOWA}/chat/${encodeURIComponent(f.jid)}/messages?limit=${limite}&offset=0`,
                        { headers: cabecerasGowa(f.cuenta), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`GOWA ${r.status}: ${j?.message || 'sin detalle'}`);
  const filas = j?.results?.data || j?.results?.messages || [];
  return filas.filter(m => m.id && m.timestamp).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

// Baja la foto via GOWA (la deja en su carpeta statics y la sirve por HTTP) → base64
async function bajarFoto(f, m) {
  const h = cabecerasGowa(f.cuenta);
  const r = await fetch(`${GOWA}/message/${encodeURIComponent(m.id)}/download?phone=${encodeURIComponent(f.jid)}`,
                        { headers: h, signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({}));
  const rel = (/to (statics\S*)/.exec(j.message || '') || [])[1];
  if (!r.ok || !rel) throw new Error(`GOWA no bajó la foto (${r.status} ${j.message || ''})`);
  const s = await fetch(`${GOWA}/${rel.split('\\').join('/')}`, { headers: h, signal: AbortSignal.timeout(30000) });
  if (!s.ok) throw new Error(`GOWA no sirvió la foto (${s.status})`);
  return { b64: Buffer.from(await s.arrayBuffer()).toString('base64'), mime: s.headers.get('content-type') || 'image/jpeg' };
}

function cargarEstado() {
  try {
    const e = JSON.parse(fs.readFileSync(ESTADO, 'utf8'));
    if (!e.fuentes) e.fuentes = { canal: { vistos: e.vistos || [] } };   // migra el estado de la v1 (solo el canal)
    delete e.vistos;
    return e;
  } catch { return { creado: new Date().toISOString(), fuentes: {} }; }
}
function guardarEstado(e) {
  for (const k of Object.keys(e.fuentes)) e.fuentes[k].vistos = e.fuentes[k].vistos.slice(-2000);
  fs.writeFileSync(ESTADO, JSON.stringify(e, null, 2));
}
function latido(extra) {
  try { fs.writeFileSync(STATUS, JSON.stringify({ at: new Date().toISOString(), seco: SECO, url: URL_SERVIDOR, ...extra }, null, 2)); } catch {}
}

async function enviar(ruta, cuerpo) {
  const r = await fetch(`${URL_SERVIDOR}${ruta}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ironballs-token': TOKEN },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(90000),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}

function avisarNtfy(titulo, texto) {
  return fetch('https://ntfy.sh/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: 'bitacora_gcarvaja51', title: titulo, message: texto, priority: 4, tags: ['warning'] }),
  }).catch(() => {});
}

// Que mandar de cada mensaje nuevo. null = nada (mapas, Zoom, charla, otros miembros).
function clasificar(f, m, msgs) {
  const autor = m.is_from_me ? null : (AUTORES[m.sender_jid] || null);
  if (f.modo === 'pipe') {
    if (m.sender_jid && m.sender_jid !== PIPE_JID) return null;
    const p = ib.parsearMensaje(m.content || '', m.timestamp);
    if (!p) return null;
    // ¿El CLOSED de esta alerta ya esta publicado? (Pipe a veces manda la alerta cuando ya salio.)
    const yaCerrada = p.tipo === 'apertura' && !!p.clave && msgs.some(o => o.id !== m.id &&
      new Date(o.timestamp) >= new Date(m.timestamp) && ib.parsearCierre(o.content || '', o.timestamp)?.clave === p.clave);
    return { ruta: '/api/ironballs/alerta', resumen: `${p.tipo} ${p.clave || ''} (${p.ok ? 'ok' : p.motivo})${yaCerrada ? ' [ya cerrada]' : ''}`,
             cuerpo: { alertId: m.id, mensajeAt: m.timestamp, texto: m.content, yaCerrada, autor: 'Pipe Andrade', grupo: f.grupo } };
  }
  // modo 'ale' (grupo Operaciones)
  if (m.media_type === 'image' && FOTO_AUTORES.has(m.sender_jid)) {
    const edad = (Date.now() - new Date(m.timestamp)) / 60000;
    if (edad > FOTO_MAX_MIN) return { saltar: `foto de ${autor} con ${edad.toFixed(0)} min` };
    return { ruta: '/api/ironballs/ale', foto: true, resumen: `foto de ${autor}${m.content ? ` "${m.content.slice(0, 40)}"` : ''}`,
             cuerpo: { alertId: m.id, mensajeAt: m.timestamp, texto: m.content || '', autor, grupo: f.grupo } };
  }
  if (!m.media_type && TEXTO_AUTORES.has(m.sender_jid)) {
    const t = ale.parsearTextoAle(m.content || '');
    if (!t) return null;
    return { ruta: '/api/ironballs/ale', resumen: `texto de ${autor}: ${Object.keys(t).join('+')} "${(m.content || '').slice(0, 40)}"`,
             cuerpo: { alertId: m.id, mensajeAt: m.timestamp, texto: m.content, autor, grupo: f.grupo } };
  }
  return null;
}

let estado = null;
const errores = {};   // por grupo: { desde, msg, avisado }

async function pasadaFuente(f) {
  const msgs = await ultimosMensajes(f);
  const st = estado.fuentes[f.id];
  if (!st) {
    estado.fuentes[f.id] = { creado: new Date().toISOString(), vistos: msgs.map(m => m.id) };
    log(`[${f.grupo}] primera vez: ${msgs.length} mensajes existentes marcados como vistos (el historial no se copia).`);
    return { nuevos: 0, enviados: 0 };
  }
  const vistos = new Set(st.vistos);
  const nuevos = msgs.filter(m => !vistos.has(m.id));
  let enviados = 0;
  for (const m of nuevos) {
    const c = clasificar(f, m, msgs);
    if (!c) { st.vistos.push(m.id); continue; }
    if (c.saltar) { log(`[${f.grupo}] se salta ${c.saltar}`); st.vistos.push(m.id); continue; }
    if (SECO) { log(`[SECO] [${f.grupo}] ${m.timestamp} ${c.resumen}`); st.vistos.push(m.id); continue; }
    try {
      if (c.foto) {
        const { b64, mime } = await bajarFoto(f, m);
        c.cuerpo.imagenB64 = b64;
        c.cuerpo.mime = mime;
      }
      const { status, j } = await enviar(c.ruta, c.cuerpo);
      if (status >= 200 && status < 300) {
        log(`[${f.grupo}] ${m.timestamp} ${c.resumen} → ${j.estado}: ${j.motivo || ''}`);
        st.vistos.push(m.id); enviados++;
      } else if (status === 400) {
        log(`[${f.grupo}] ${m.timestamp} ${c.resumen} → 400 ${j.error || ''} (se descarta)`);
        st.vistos.push(m.id);
      } else {
        // 401/503/5xx: no se marca, se reintenta el ciclo siguiente (el servidor es idempotente por alertId)
        log(`[${f.grupo}] ${m.timestamp} ${c.resumen} → HTTP ${status} ${j.error || ''} (se reintenta)`);
      }
    } catch (e) {
      log(`[${f.grupo}] ${m.timestamp} ${c.resumen} → ${e.message} (se reintenta)`);
    }
  }
  return { nuevos: nuevos.length, enviados };
}

async function pasada() {
  const res = {};
  for (const f of FUENTES) {
    try {
      res[f.id] = { ok: true, ...(await pasadaFuente(f)) };
      if (errores[f.id]) { log(`[${f.grupo}] volvió (${errores[f.id].msg})`); delete errores[f.id]; }
    } catch (e) {
      const er = errores[f.id] || (errores[f.id] = { desde: Date.now(), msg: e.message, avisado: false });
      if (er.msg !== e.message || !er.logueado) { log(`[${f.grupo}] error leyendo WhatsApp: ${e.message}`); er.msg = e.message; er.logueado = true; }
      if (!er.avisado && Date.now() - er.desde > AVISO_CAIDA_MIN * 60000) {
        er.avisado = true;
        avisarNtfy(`⚠️ Lector Iron Balls: no lee ${f.grupo}`, `Hace ${AVISO_CAIDA_MIN}+ min que no puede leer "${f.grupo}" (línea ${f.cuenta}).\n${e.message}\nLas señales de ese grupo no se están copiando.`);
      }
      res[f.id] = { ok: false, error: e.message };
    }
  }
  guardarEstado(estado);
  return res;
}

async function main() {
  estado = cargarEstado();
  log(`Lector Iron Balls v2 arrancando — ${SECO ? 'EN SECO (no manda nada)' : `enviando a ${URL_SERVIDOR}`} — grupos: ${FUENTES.map(f => f.grupo).join(', ')}.`);
  for (;;) {
    // Dia de mercado, 9:00-16:15 ET (un CLOSED de ultima hora todavia sirve; despues ya no).
    const activo = args.has('--una-vez') || calendario.enVentanaET(9 * 60, 16 * 60 + 15);
    if (activo) {
      const r = await pasada();
      latido({ ok: Object.values(r).every(x => x.ok), fuentes: r, motivoCierre: null });
    } else {
      latido({ ok: true, dormido: true, motivoCierre: calendario.motivoCierre() || 'fuera_de_horario' });
    }
    if (args.has('--una-vez')) break;
    await new Promise(r => setTimeout(r, activo ? CICLO_MS : 60 * 1000));
  }
}

main().catch(e => { log(`Caída: ${e.stack || e.message}`); process.exit(1); });
