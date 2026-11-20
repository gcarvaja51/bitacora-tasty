'use strict';
// ── Cierres a decisión de Guillermo — libro Señales Sigma (2026-11-19) ────────────────────────────────────────────
//
// Cuando el profe cierra y nuestro cierre (cruzando el spread) sale más de 30% peor que el suyo, el libro NO cierra:
// deja la posición en `pendiente_decision` y le pide la decisión a Guillermo por tres vías, todas con el mismo link:
//   - correo (Gmail con clave de aplicación: GMAIL_USER + GMAIL_APP_PASSWORD; destino AVISO_CORREO_A o GMAIL_USER)
//   - WhatsApp (lo manda el lector del PC, que tiene GOWA: GET/POST /api/libros/senales/avisos-ws)
//   - ntfy (con el link como acción)
// El link abre una página con el detalle y dos botones (POST): "Cerrar ahora" y "Mantener". Un GET nunca ejecuta
// nada (los antivirus del correo abren los links solos).

const fmt = (x, d = 2) => (x == null || isNaN(x) ? '—' : Number(x).toFixed(d));
const usd = (x) => (x == null || isNaN(x) ? '—' : `${x >= 0 ? '+' : '−'}$${Math.abs(x).toFixed(2)}`);
const precio = (neto) => (neto == null ? '—' : `${fmt(Math.abs(neto))} de ${neto >= 0 ? 'crédito' : 'débito'}`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function linkDecision(base, id, clave) {
  return `${String(base).replace(/\/$/, '')}/api/libros/senales/decidir/${encodeURIComponent(id)}?c=${encodeURIComponent(clave)}`;
}

function textoDecision(t, link, { recordatorio = false } = {}) {
  const d = t.decision || {};
  return [
    `${recordatorio ? '⏰ RECORDATORIO — ' : ''}📕 Señales Sigma (demo): cierre a tu decisión`,
    '',
    `${t.profe} · ${t.activo} ${t.estrategia}`,
    `Profe cerró a ${precio(d.profe)}${d.pnlProfeUsd != null ? ` (${usd(d.pnlProfeUsd)})` : ''}`,
    `Nosotros cerraríamos a ${precio(d.nuestro)} (${usd(d.pnlNuestroEstimado)} estimado)`,
    `Diferencia: ${Math.round((d.pct || 0) * 100)}% peor que el profe`,
    '',
    'No se cerró. Decide aquí:',
    link,
  ].join('\n');
}

function correoDecision(t, link, opciones = {}) {
  const d = t.decision || {};
  const asunto = `${opciones.recordatorio ? 'Recordatorio: ' : ''}Cierre a tu decisión — ${t.activo} de ${t.profe} (${Math.round((d.pct || 0) * 100)}% peor)`;
  const fila = (k, v) => `<tr><td style="padding:6px 12px;color:#555">${esc(k)}</td><td style="padding:6px 12px;font-weight:600">${esc(v)}</td></tr>`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px">
<h2 style="margin:0 0 8px">${opciones.recordatorio ? '⏰ ' : ''}Cierre a tu decisión</h2>
<p style="margin:0 0 12px;color:#333">${esc(t.profe)} cerró <b>${esc(t.activo)} ${esc(t.estrategia)}</b>. Nuestro cierre sale
<b>${Math.round((d.pct || 0) * 100)}% peor</b> que el suyo, así que el demo <b>no cerró</b>.</p>
<table style="border-collapse:collapse;border:1px solid #ddd;margin-bottom:16px">
${fila('Cierre del profe', `${precio(d.profe)}${d.pnlProfeUsd != null ? ` (${usd(d.pnlProfeUsd)})` : ''}`)}
${fila('Nuestro cierre (cruzando el spread)', `${precio(d.nuestro)} (${usd(d.pnlNuestroEstimado)} estimado)`)}
${fila('Pedido', new Date(d.pedidaAt || Date.now()).toLocaleString('es-CO', { timeZone: 'America/New_York' }) + ' ET')}
</table>
<p><a href="${esc(link)}" style="display:inline-block;background:#1a7f37;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:700">Ver y decidir</a></p>
<p style="color:#777;font-size:12px">El link abre la página con el precio de este momento y los botones "Cerrar ahora" y "Mantener".
Sin tu clic la posición sigue abierta; a las 3:30pm ET te llega un recordatorio. Es el libro demo: nunca se manda una orden real.</p>
</div>`;
  return { asunto, html, texto: textoDecision(t, link, opciones) };
}

// Correo por Gmail con clave de aplicación. Devuelve { ok, motivo }.
async function enviarCorreo({ asunto, html, texto }, env = process.env) {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) return { ok: false, motivo: 'faltan GMAIL_USER / GMAIL_APP_PASSWORD en Railway' };
  const nodemailer = require('nodemailer');
  const tr = nodemailer.createTransport({ service: 'gmail', connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000, auth: { user: env.GMAIL_USER, pass: String(env.GMAIL_APP_PASSWORD).replace(/\s+/g, '') } });
  await tr.sendMail({ from: `Bitácora Señales Sigma <${env.GMAIL_USER}>`, to: env.AVISO_CORREO_A || env.GMAIL_USER,
                      subject: asunto, html, text: texto });
  return { ok: true };
}

function pagina({ titulo, cuerpo }) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(titulo)}</title>
<style>body{font-family:Arial,sans-serif;background:#f6f7f9;margin:0;padding:16px;color:#1f2328}
.c{max-width:520px;margin:0 auto;background:#fff;border:1px solid #d0d7de;border-radius:10px;padding:20px}
h1{font-size:20px;margin:0 0 6px}table{width:100%;border-collapse:collapse;margin:14px 0}
td{padding:7px 4px;border-bottom:1px solid #eee}td:last-child{text-align:right;font-weight:600}
button{width:100%;padding:14px;font-size:17px;font-weight:700;border:0;border-radius:8px;margin-top:10px;cursor:pointer}
.si{background:#1a7f37;color:#fff}.no{background:#eaeef2;color:#1f2328}.nota{color:#666;font-size:13px}</style></head>
<body><div class="c">${cuerpo}</div></body></html>`;
}

function paginaDecision(v, { id, clave }) {
  if (!v.ok) return pagina({ titulo: 'Link inválido', cuerpo: `<h1>Link inválido</h1><p>${esc(v.motivo)}</p>` });
  const t = v.trade, d = t.decision || {}, a = v.ahoraCierre;
  const filas = [
    ['Cierre del profe', `${precio(d.profe)}${d.pnlProfeUsd != null ? ` (${usd(d.pnlProfeUsd)})` : ''}`],
    ['Nuestro cierre cuando avisé', `${precio(d.nuestro)} (${usd(d.pnlNuestroEstimado)})`],
    ['Nuestro cierre AHORA', a ? `${precio(a.neto)} (${usd(a.pnlEstimado)})` : 'sin precio en este momento'],
    ['Diferencia ahora', a && a.pct != null ? `${Math.round(a.pct * 100)}% ${a.peor > 0 ? 'peor' : 'mejor o igual'}` : '—'],
  ].map(([k, x]) => `<tr><td>${esc(k)}</td><td>${esc(x)}</td></tr>`).join('');
  const form = (accion, clase, txt) => `<form method="post" action="/api/libros/senales/decidir/${encodeURIComponent(id)}">
<input type="hidden" name="c" value="${esc(clave)}"><input type="hidden" name="accion" value="${accion}">
<button class="${clase}" type="submit">${txt}</button></form>`;
  let botones;
  if (t.estado === 'pendiente_decision') botones = form('cerrar', 'si', 'Cerrar ahora') + form('mantener', 'no', 'Mantener abierta');
  else if (t.estado === 'abierta') botones = `<p class="nota">Decidiste mantenerla. Si cambias de opinión:</p>` + form('cerrar', 'si', 'Cerrar ahora');
  else botones = `<p><b>Estado: ${esc(t.estado)}</b>${t.pnlRealizado != null ? ` · P&L ${esc(usd(t.pnlRealizado))}` : ''}</p>`;
  return pagina({ titulo: `Decisión ${t.activo}`, cuerpo: `<h1>${esc(t.activo)} · ${esc(t.profe)}</h1>
<div class="nota">${esc(t.estrategia)} — libro demo Señales Sigma${v.mercadoAbierto ? '' : ' · mercado cerrado: si cierras, se ejecuta al abrir'}</div>
<table>${filas}</table>${botones}
<p class="nota">Es el demo: nunca se manda una orden real a TastyTrade.</p>` });
}

function paginaResultado(r) {
  const msg = !r.ok ? `No se pudo: ${r.motivo}`
    : r.estado === 'CERRADA' ? `Cerrada a ${precio(r.precio)}. P&L de la operación: ${usd(r.pnl)}.`
    : r.estado === 'MANTENIDA' ? 'Listo: la posición sigue abierta. El mismo link te sirve para cerrarla después.'
    : `Orden de cierre registrada: ${r.motivo}.`;
  return pagina({ titulo: 'Decisión registrada', cuerpo: `<h1>${r.ok ? '✅' : '⚠️'} ${r.ok ? 'Hecho' : 'Error'}</h1><p>${esc(msg)}</p>` });
}

module.exports = { linkDecision, textoDecision, correoDecision, enviarCorreo, paginaDecision, paginaResultado };
