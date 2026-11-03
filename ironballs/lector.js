// ── Lector de Iron Balls — corre en el PC, NO se despliega (2026-11-01) ─────
//
// Vigila el grupo de WhatsApp "📈 Canal Oficial - Iron Balls 📈" (linea USA) a traves
// de GOWA en 127.0.0.1:3001 —que solo existe en este PC, por eso el lector no puede
// vivir en Railway— y manda cada "Options Alert" y cada "⚠️ CLOSED" a
// POST /api/ironballs/alerta de produccion, con el TEXTO CRUDO. Quien decide si se
// opera es el servidor (re-parsea, mira el kill-switch, la edad, la ventana, el cupo).
//
// Uso:
//   node ironballs/lector.js            # bucle: cada 15 s en dia de mercado 9:00-16:15 ET
//   node ironballs/lector.js --una-vez  # una pasada y sale (diagnostico)
//   node ironballs/lector.js --seco     # lee y parsea, NO manda nada al servidor
//
// Configuracion en ironballs/.env (no versionado):
//   IRONBALLS_TOKEN=...                 # la misma clave que en Railway; sin ella corre en seco
//   IRONBALLS_URL=https://web-production-23473.up.railway.app   (default)
//
// Estado en ironballs/estado.json (ids ya enviados) y ironballs/status.json (latido).
// En el PRIMER arranque marca como vistos todos los mensajes que ya existen, sin
// mandarlos: el historial no se copia.

const fs = require('fs');
const path = require('path');
const ib = require('../src/ironballs');
const calendario = require('../src/calendario_nyse');

const DIR = __dirname;
const WHATSAPP_DIR = 'C:/Users/gcarv/Documents/CARPETA PERSONAL/whatsapp';
const GOWA = 'http://127.0.0.1:3001';
const CANAL_JID = '120363233546136336@g.us';   // 📈 Canal Oficial - Iron Balls 📈
const PIPE_JID = '14077487451@s.whatsapp.net'; // solo cuentan los mensajes de Pipe
const CICLO_MS = 15 * 1000;
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

function cabecerasGowa() {
  const cred = {};
  for (const l of fs.readFileSync(path.join(WHATSAPP_DIR, 'credenciales.txt'), 'utf8').split(/\r?\n/)) {
    const i = l.indexOf(':');
    if (i > 0) cred[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  const dev = JSON.parse(fs.readFileSync(path.join(WHATSAPP_DIR, 'cuentas.json'), 'utf8')).usa.device_id;
  const h = { 'X-Device-Id': dev };
  if (cred.usuario && cred.password) h.Authorization = 'Basic ' + Buffer.from(`${cred.usuario}:${cred.password}`).toString('base64');
  return h;
}

const LIMITE = Math.min(100, Number((process.argv.find(a => a.startsWith('--limite=')) || '').split('=')[1]) || 40);
async function ultimosMensajes(limite = LIMITE) {
  const r = await fetch(`${GOWA}/chat/${encodeURIComponent(CANAL_JID)}/messages?limit=${limite}&offset=0`, { headers: cabecerasGowa() });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`GOWA ${r.status}: ${j?.message || 'sin detalle'}`);
  const filas = j?.results?.data || j?.results?.messages || [];
  return filas.filter(m => m.id && m.timestamp)
              .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function cargarEstado() {
  try { return JSON.parse(fs.readFileSync(ESTADO, 'utf8')); } catch { return null; }
}
function guardarEstado(e) {
  // Solo los ultimos 2000 ids: el canal trae ~20 mensajes/dia.
  e.vistos = e.vistos.slice(-2000);
  fs.writeFileSync(ESTADO, JSON.stringify(e, null, 2));
}
function latido(extra) {
  try { fs.writeFileSync(STATUS, JSON.stringify({ at: new Date().toISOString(), seco: SECO, url: URL_SERVIDOR, ...extra }, null, 2)); } catch {}
}

async function enviar(cuerpo) {
  const r = await fetch(`${URL_SERVIDOR}/api/ironballs/alerta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ironballs-token': TOKEN },
    body: JSON.stringify(cuerpo),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}

let estado = null;
let ultimoErrorGowa = null;

async function pasada() {
  const msgs = await ultimosMensajes();
  if (ultimoErrorGowa) { log(`GOWA volvió (${ultimoErrorGowa})`); ultimoErrorGowa = null; }

  if (!estado) {
    estado = { creado: new Date().toISOString(), vistos: msgs.map(m => m.id) };
    guardarEstado(estado);
    log(`Primer arranque: ${msgs.length} mensajes existentes marcados como vistos (el historial no se copia).`);
    return { nuevos: 0 };
  }
  const vistos = new Set(estado.vistos);
  const nuevos = msgs.filter(m => !vistos.has(m.id));
  let enviados = 0;
  for (const m of nuevos) {
    const deOtro = m.sender_jid && m.sender_jid !== PIPE_JID && !m.is_from_me;
    const p = deOtro ? null : ib.parsearMensaje(m.content || '', m.timestamp);
    if (!p) { estado.vistos.push(m.id); continue; }   // mapas, capsulas, Zoom, charla: nada que hacer

    // ¿El CLOSED de esta alerta ya esta publicado? (Pipe a veces manda la alerta cuando ya salio.)
    let yaCerrada = false;
    if (p.tipo === 'apertura' && p.clave) {
      yaCerrada = msgs.some(o => o.id !== m.id && new Date(o.timestamp) >= new Date(m.timestamp) &&
        ib.parsearCierre(o.content || '', o.timestamp)?.clave === p.clave);
    }
    const resumen = `${p.tipo} ${p.clave || ''} (${p.ok ? 'ok' : p.motivo})${yaCerrada ? ' [ya cerrada]' : ''}`;
    if (SECO) {
      log(`[SECO] ${m.timestamp} ${resumen}`);
      estado.vistos.push(m.id);
      continue;
    }
    try {
      const { status, j } = await enviar({ alertId: m.id, mensajeAt: m.timestamp, texto: m.content, yaCerrada });
      if (status >= 200 && status < 300) {
        log(`${m.timestamp} ${resumen} → ${j.estado}: ${j.motivo || ''}`);
        estado.vistos.push(m.id);
        enviados++;
      } else if (status === 400) {
        log(`${m.timestamp} ${resumen} → 400 ${j.error || ''} (se descarta)`);
        estado.vistos.push(m.id);
      } else {
        // 401/503/5xx: no se marca, se reintenta el ciclo siguiente (el servidor es idempotente por alertId).
        log(`${m.timestamp} ${resumen} → HTTP ${status} ${j.error || ''} (se reintenta)`);
      }
    } catch (e) {
      log(`${m.timestamp} ${resumen} → sin respuesta del servidor: ${e.message} (se reintenta)`);
    }
  }
  guardarEstado(estado);
  return { nuevos: nuevos.length, enviados };
}

async function main() {
  estado = cargarEstado();
  log(`Lector Iron Balls arrancando — ${SECO ? 'EN SECO (no manda nada)' : `enviando a ${URL_SERVIDOR}`}.`);
  for (;;) {
    // Dia de mercado, 9:00-16:15 ET (un CLOSED de ultima hora todavia sirve; despues ya no).
    const activo = args.has('--una-vez') || calendario.enVentanaET(9 * 60, 16 * 60 + 15);
    if (activo) {
      try {
        const r = await pasada();
        latido({ ok: true, ...r, motivoCierre: null });
      } catch (e) {
        if (ultimoErrorGowa !== e.message) log(`Error leyendo WhatsApp: ${e.message}`);
        ultimoErrorGowa = e.message;
        latido({ ok: false, error: e.message });
      }
    } else {
      latido({ ok: true, dormido: true, motivoCierre: calendario.motivoCierre() || 'fuera_de_horario' });
    }
    if (args.has('--una-vez')) break;
    await new Promise(r => setTimeout(r, activo ? CICLO_MS : 60 * 1000));
  }
}

main().catch(e => { log(`Caída: ${e.stack || e.message}`); process.exit(1); });
