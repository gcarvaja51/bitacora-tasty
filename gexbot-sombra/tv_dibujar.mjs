// Dibuja en TradingView (panel SPX de 2 min) el resultado de un ciclo de confluencia (19-nov-2026):
//  - histograma de GexBot Classic como marca de agua (rojo = gamma negativa, verde = positiva), anclado a la
//    vela actual y creciendo hacia la izquierda (como GexBot), largo máximo 90 min;
//  - línea tenue "Gamma Flip GB <valor>";
//  - etiqueta discreta con la confluencia (lecturas A y B, fases 5m/2m, votos).
// Borra lo que dibujó en el ciclo anterior (ids en window.__gbIds; si TV se recargó, los reconoce por su texto/color).
// Uso: node tv_dibujar.mjs ultimo_dibujo.json
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire('C:/Users/gcarv/bitacora-tasty/gamma_daemon/package.json');
const CDP = require('chrome-remote-interface');

const d = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
// Calendario NYSE (única fuente, en la bitácora): feriados sin velas y medios días con cierre a las 13:00.
let CAL = { feriados: [], mediosDias: [] };
try { CAL = JSON.parse(fs.readFileSync(new URL('../../Bitacoras/bitacora-tasty/src/calendario_nyse.json', import.meta.url), 'utf8')); } catch { /* sin calendario: L-V 9:30-16:00 */ }

// TradingView puede tener VARIAS pestañas con el mismo diseño: se dibuja en todas las que tengan SPX de 2 min.
async function objetivos() {
  for (const port of [9222, 9223, 9224]) {
    try {
      const lista = await CDP.List({ port });
      const ts = lista.filter((x) => x.type === 'page' && /tradingview\.com\/chart/.test(x.url));
      if (ts.length) return ts.map((t) => ({ port, target: t.id }));
    } catch { /* puerto cerrado */ }
  }
  return [];
}

const objs = await objetivos();
if (!objs.length) { console.log('TradingView sin puerto de depuración abierto: no se dibujó'); process.exit(0); }
const payload = {
  barras: d.gexbot_classic?.barras || [],
  flip: d.gexbot_classic?.gamma_flip_gb || null,
  A: d.lecturas?.A_tendencia || {}, B: d.lecturas?.B_fade || {},
  f5: d.fase5m, f2: d.fase2m, votos: d.votos || {}, neto: d.lecturas?.neto_herramientas,
  hora: (d.at || '').slice(11, 16), fin: d.ancla_ts || null,
  feriados: CAL.feriados || [], medios: CAL.mediosDias || [],
};
const js = `(async () => {
  const P = ${JSON.stringify(payload)};
  const w = window.TradingViewApi;
  if (!w) return 'pestaña sin gráfico';
  // Datos del último barrido: los usa también el redibujo automático al hacer zoom/desplazarse.
  // 20-nov: si esta captura no dio barras (lectura fallida), se conserva el histograma anterior en vez de borrarlo
  // (auditoría 20-nov: solo si el anterior tiene menos de 10 min; si no, se mostraba un histograma de horas atrás)
  P.recibido = Date.now();
  if (!P.barras.length && window.__gbP && window.__gbP.barras && window.__gbP.barras.length && Date.now() - (window.__gbP.recibido || 0) < 600000) {
    P.barras = window.__gbP.barras; P.recibido = window.__gbP.recibido;
  }
  window.__gbP = P;
  const primeraVez = !window.__gbIds || Array.isArray(window.__gbIds);
  if (primeraVez) window.__gbIds = {};
  if (!window.__gbSubs) window.__gbSubs = {};

  // Dibuja el histograma ESTILO GEXBOT en el panel i (19-nov): línea de cero a ~45 % del ancho VISIBLE;
  // rojas (gamma negativa) crecen a la izquierda hasta el borde, verdes (positiva) a la derecha sin tapar las
  // últimas velas. Opacidad 30 % (pedido 19-nov: menos difuminado). + línea Gamma Flip GB.
  if (!window.__gbCola) window.__gbCola = {};
  window.__gbDibujar = (i, limpiarViejos) => {
    const sig = (window.__gbCola[i] || Promise.resolve()).catch(() => {}).then(() => window.__gbDibujarYa(i, limpiarViejos));
    window.__gbCola[i] = sig;
    return sig;
  };
  window.__gbDibujarYa = async (i, limpiarViejos) => {
    const P = window.__gbP; const c = w.chart(i);
    if (!P || !c || !/(^|:)SPX$/.test(c.symbol())) return null;
    const viejos = window.__gbIds[i] || [];   // 20-nov: se borran DESPUÉS de dibujar los nuevos (sin parpadeo)
    if (limpiarViejos) {   // tras recargar (o versiones viejas): reconocer por texto/estilo
      for (const s of c.getAllShapes()) {
        try {
          const pr = c.getShapeById(s.id).getProperties();
          const txt = (pr.text || '') + '';
          if (/GexBot Classic|Gamma Flip GB/.test(txt)) c.removeEntity(s.id);   // 21-nov: solo con texto del bot
        } catch (e) {}
      }
    }
    const ids = [];
    // 20-nov: se ubica por VELAS reales de la sesión (9:30-16:00 ET, L-V), no por tiempo: TradingView oculta las horas
    // sin mercado y un dibujo anclado de noche queda con ancho cero (invisible).
    const res = Math.max(1, parseInt(c.resolution(), 10) || 2) * 60;
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const enSesion = (t) => { const p = Object.fromEntries(fmt.formatToParts(new Date(t * 1000)).map(x => [x.type, x.value]));
      const f = p.year + '-' + p.month + '-' + p.day, fin = (P.medios || []).includes(f) ? 780 : 960;
      const m = (+p.hour % 24) * 60 + (+p.minute); return !['Sat', 'Sun'].includes(p.weekday) && !(P.feriados || []).includes(f) && m >= 570 && m < fin; };
    const ahoraReal = Math.floor(Date.now() / 1000 / res) * res;
    let vr = null; try { vr = c.getVisibleRange(); } catch (e) {}
    const desde = vr && vr.from ? vr.from : ahoraReal - 3 * 3600;
    const tope = Math.min(vr && vr.to ? vr.to : ahoraReal, ahoraReal);
    let velas = [];
    for (let t = Math.ceil(desde / res) * res; t <= tope && velas.length < 5000; t += res) if (enSesion(t)) velas.push(t);
    if (velas.length < 10) {   // vista sin velas de sesión (p. ej. desplazado al futuro): usar las últimas velas reales
      velas = []; for (let t = ahoraReal; velas.length < 120 && t > ahoraReal - 7 * 86400; t -= res) if (enSesion(t)) velas.unshift(t);
    }
    const n = velas.length, iCero = Math.floor(n * 0.45);
    const cero = velas[iCero], ahora = velas[n - 1];
    const maxIzq = iCero - Math.max(1, Math.round(n * 0.02)), maxDer = (n - 1 - iCero) * 0.55;
    const maxLargo = Math.max(1, ...P.barras.map(b => Math.abs(b[1])));
    for (const [k, largo] of P.barras) {
      const neg = largo < 0;
      const seg = Math.max(1, Math.round(Math.abs(largo) / maxLargo * (neg ? maxIzq : maxDer)));
      const a = neg ? velas[Math.max(0, iCero - seg)] : cero, b = neg ? cero : velas[Math.min(n - 1, iCero + seg)];
      ids.push(await c.createMultipointShape([{ time: a, price: k + 2 }, { time: b, price: k - 2 }], {
        shape: 'rectangle', lock: true, disableSelection: true, disableSave: true,
        overrides: { backgroundColor: neg ? 'rgba(242,54,69,0.30)' : 'rgba(8,153,129,0.30)', color: neg ? 'rgba(242,54,69,0.40)' : 'rgba(8,153,129,0.40)', fillBackground: true, linewidth: 1 } }));
    }
    if (P.barras.length) ids.push(await c.createShape({ time: cero, price: P.barras[0][0] }, { shape: 'vertical_line', lock: true, disableSelection: true, disableSave: true,
      overrides: { linecolor: 'rgba(200,200,200,0.22)', linewidth: 1, linestyle: 2, showTime: false } }));
    if (P.flip) ids.push(await c.createShape({ time: ahora, price: P.flip }, { shape: 'horizontal_line', lock: true, disableSelection: true, disableSave: true,
      overrides: { linecolor: 'rgba(255,152,0,0.55)', linewidth: 1, linestyle: 2, showLabel: true, text: 'Gamma Flip GB ' + P.flip, textcolor: 'rgba(255,152,0,0.8)', fontsize: 11, horzLabelsAlign: 'right', vertLabelsAlign: 'bottom' } }));
    window.__gbIds[i] = ids;
    for (const id of viejos) { try { c.removeEntity(id); } catch (e) {} }
    return 'panel ' + i + ' (' + c.resolution() + ')';
  };

  const hechos = [];
  for (let i = 0; i < w.chartsCount(); i++) {
    const c = w.chart(i);
    if (!/(^|:)SPX$/.test(c.symbol())) continue;
    const h = await window.__gbDibujar(i, primeraVez);
    if (h) hechos.push(h);
    if (!window.__gbSubs[i]) {   // redibujar solo al hacer zoom / desplazarse (con pausa para no saturar)
      let tmr = null;
      try {
        c.onVisibleRangeChanged().subscribe(null, () => { clearTimeout(tmr); tmr = setTimeout(() => window.__gbDibujar(i, false), 700); });
        window.__gbSubs[i] = true;
      } catch (e) {}
    }
  }
  // La confluencia NO se dibuja: Guillermo la quiere solo en sombra (queda en confluencia.jsonl).
  if (!hechos.length) return 'pestaña sin SPX (no se dibuja)';
  return 'ok: ' + hechos.join(', ') + ' · ' + P.barras.length + ' barras, flip ' + P.flip;
})()`;
const salida = [];
for (const o of objs) {
  try {
    const cli = await CDP({ port: o.port, target: o.target });
    try {
      const r = await cli.Runtime.evaluate({ expression: js, awaitPromise: true, returnByValue: true, timeout: 20000 });
      salida.push(r.result?.value || r.exceptionDetails?.exception?.description || 'sin respuesta');
    } finally { await cli.close().catch(() => {}); }
  } catch (e) { salida.push('error: ' + e.message); }
}
console.log(salida.join(' | '));
