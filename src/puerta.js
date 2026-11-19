// Puerta de escritura de la Bitácora (2026-11-16).
// Hasta hoy 56 direcciones que ESCRIBEN (POST/PUT/DELETE/PATCH) no pedían clave: cualquiera que conociera la dirección
// web podía cambiar la configuración del robot, apretar el pánico o borrar ejecuciones. Esta puerta las cubre a todas.
//
// Tres estados, según las variables de Railway:
//   sin BITACORA_TOKEN              → APAGADA: todo como antes (es la marcha atrás: borrar la variable).
//   BITACORA_TOKEN                  → AVISO: deja pasar, pero anota quién escribió sin clave (Guillermo: "aviso un día").
//   BITACORA_TOKEN + BITACORA_PUERTA=cerrada → CERRADA: sin clave responde 401.
//
// La clave llega en la cabecera x-bitacora-token, en la cookie bitacora_token o en ?k= (para alertas de TradingView,
// que no pueden mandar cabeceras). Las direcciones que ya tienen su propia clave siguen con la suya.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CON_CLAVE_PROPIA = ['/api/spx/clic', '/api/spx/clic-real', '/api/ironballs/alerta', '/api/ironballs/ale',
  '/api/libros/senales/alerta', '/api/libros/senales/importar', '/api/libros/senales/margen',
  '/api/libros/senales/reprogramar'];
const LECTURA = new Set(['GET', 'HEAD', 'OPTIONS']);

function igual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function cookieDe(req, nombre) {
  const m = new RegExp('(?:^|;\\s*)' + nombre + '=([^;]+)').exec(String(req.headers?.cookie || ''));
  return m ? decodeURIComponent(m[1]) : '';
}
// /api/watchlist/NVDA/note/123 → /api/watchlist/:x/note/:x (para agrupar los avisos)
const patron = (p) => String(p).split('?')[0].replace(/\/(tex-|sig-|esp-|spx-|ibd-)?[A-Za-z]*\d[\w.-]*/g, '/:x');

function crearPuerta({ dataDir, env = process.env, ahora = () => new Date(), archivo = 'puerta_avisos.json' } = {}) {
  const ruta = dataDir ? path.join(dataDir, archivo) : null;
  let avisos = {};
  try { if (ruta && fs.existsSync(ruta)) avisos = JSON.parse(fs.readFileSync(ruta, 'utf8')) || {}; } catch { avisos = {}; }
  let sucio = false;
  const guardar = () => { if (!ruta || !sucio) return; sucio = false; try { fs.writeFileSync(ruta, JSON.stringify(avisos)); } catch { /* el aviso no puede tumbar nada */ } };

  const estado = () => (!env.BITACORA_TOKEN ? 'apagada' : String(env.BITACORA_PUERTA || '').toLowerCase() === 'cerrada' ? 'cerrada' : 'aviso');
  const traeClave = (req) => {
    const t = env.BITACORA_TOKEN;
    return !!t && (igual(req.headers?.['x-bitacora-token'], t) || igual(cookieDe(req, 'bitacora_token'), t) || igual(req.query?.k, t));
  };

  function anotar(req, bloqueado) {
    const p = patron(req.path || req.url || ''), ua = String(req.headers?.['user-agent'] || 'sin user-agent').slice(0, 80);
    const k = `${req.method} ${p} | ${ua}`;
    const a = avisos[k] = avisos[k] || { metodo: req.method, ruta: p, quien: ua, veces: 0, primera: ahora().toISOString() };
    a.veces++; a.ultima = ahora().toISOString(); a.bloqueado = !!bloqueado;
    a.origen = String(req.headers?.['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || null;
    if (Object.keys(avisos).length > 500) delete avisos[Object.keys(avisos)[0]];
    sucio = true;
  }

  function middleware(req, res, next) {
    const p = req.path || '';
    if (LECTURA.has(req.method) || !p.startsWith('/api/')) return next();
    const e = estado();
    if (e === 'apagada' || CON_CLAVE_PROPIA.includes(p) || traeClave(req)) return next();
    anotar(req, e === 'cerrada');
    if (e === 'aviso') return next();
    return res.status(401).json({ ok: false, puerta: true, error: 'Esta acción pide la clave de la Bitácora' });
  }

  const lista = () => Object.values(avisos).sort((a, b) => String(b.ultima).localeCompare(String(a.ultima)));
  const limpiar = () => { avisos = {}; sucio = true; guardar(); };
  return { middleware, estado, traeClave, lista, guardar, limpiar };
}

module.exports = { crearPuerta, CON_CLAVE_PROPIA, patron };
