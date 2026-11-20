'use strict';
// ── Señales Sigma — rolls y ajustes que no vienen en un formato fijo (Guillermo 2026-11-18) ──────────────────────────
//
// Dos casos los lee Claude:
//   - FOTO de Luis: la ventana "Rolar posición" de Sigma Terminal ("♻️ Roll de META"): patas que cierra con su precio,
//     patas nuevas con vencimiento, strike y prima, y el "Neto del roll".
//   - TEXTO LIBRE: "Cerré la put comprada de 20 $… Rolé la put vendida de 22 $ al 15/01/2027…", "NUEVOS ROLLS" de Ford…
//
// Claude devuelve SOLO lo que ve/lee (activo, patas que se cierran, patas que se abren, neto). Qué posición del demo es,
// el año del vencimiento y la ejecución los decide src/libro_senales.js, no el modelo.

const MODELO = process.env.SIGMA_MODELO_GESTION || process.env.IRONBALLS_MODELO_VISION || 'claude-opus-5-5';

const PROMPT = `Este mensaje lo publica un mentor de trading de opciones en un canal de señales. Puede describir una GESTIÓN de una posición abierta (un roll, un ajuste, un cierre parcial) o puede ser cualquier otra cosa (comentario, reflexión, plan del día, noticia, invitación a un directo).

Si describe una gestión concreta con patas identificables, extrae:
Devuelve una entrada en "gestiones" POR CADA ACTIVO gestionado (una foto puede traer varias órdenes, ej. un roll de SOFI y otro de MARA: son dos entradas). En cada una:
- activo: el ticker (ej. META, SPX, F).
- accion: "roll" (cierra patas y abre otras), "cierre_parcial" (solo cierra algunas patas), "ajuste" (abre patas nuevas sobre una posición existente, sin cerrar), "cierre_total".
- cerrar: cada pata que se CIERRA, con tipo ("P" put o "C" call), strike, día y mes de vencimiento (número), año si aparece (si no, null), cantidad (positiva) y lado ORIGINAL de la pata ("vendida" si era una opción vendida, "comprada" si era comprada; en Sigma Terminal "-1x" es vendida y "1x" es comprada). Precio de cierre por acción si aparece.
- abrir: cada pata NUEVA que se abre, con tipo, strike, día, mes, año (o null), cantidad y lado ("vendida" o "comprada"). Prima por acción si aparece.
- neto_usd: el neto del roll/ajuste de ESE activo en dólares por posición (+ si es crédito, - si es débito), si aparece (en el pie o en la foto). Si no, null.
Si NO hay ninguna gestión concreta (o no se pueden identificar strikes), devuelve "gestiones" vacío.
No adivines: si un dato no se lee con claridad, pon null. Un "roll de X" sin patas visibles NO es gestión concreta.`;

const PATA = {
  type: 'object',
  properties: {
    tipo: { type: 'string', enum: ['P', 'C'] },
    strike: { type: 'number' },
    dia: { type: ['integer', 'null'] },
    mes: { type: ['integer', 'null'] },
    anio: { type: ['integer', 'null'] },
    cantidad: { type: 'integer' },
    lado: { type: 'string', enum: ['vendida', 'comprada'] },
    precio: { type: ['number', 'null'] },
  },
  required: ['tipo', 'strike', 'dia', 'mes', 'anio', 'cantidad', 'lado', 'precio'],
  additionalProperties: false,
};
const GESTION = {
  type: 'object',
  properties: {
    es_gestion: { type: 'boolean' },
    activo: { type: ['string', 'null'] },
    accion: { type: 'string', enum: ['roll', 'cierre_parcial', 'ajuste', 'cierre_total', 'ninguna'] },
    cerrar: { type: 'array', items: PATA },
    abrir: { type: 'array', items: PATA },
    neto_usd: { type: ['number', 'null'] },
  },
  required: ['es_gestion', 'activo', 'accion', 'cerrar', 'abrir', 'neto_usd'],
  additionalProperties: false,
};
// Varias gestiones por mensaje (2026-11-19: la foto "Gestion SOFI y MARA" de Facu traía dos rolls y solo se aplicó uno).
const ESQUEMA = {
  type: 'object',
  properties: { gestiones: { type: 'array', items: GESTION } },
  required: ['gestiones'],
  additionalProperties: false,
};

let cliente = null;
function anthropic() {
  if (!cliente) {
    const Anthropic = require('@anthropic-ai/sdk');
    cliente = new (Anthropic.default || Anthropic)({ timeout: 45000, maxRetries: 1 });
  }
  return cliente;
}

/** Interpreta el mensaje (texto y/o foto). Devuelve { lectura, ms, modelo } o lanza error. */
async function interpretarGestion({ texto = '', imagenB64 = null, mime = 'image/jpeg' }) {
  const t0 = Date.now();
  const content = [];
  if (imagenB64) content.push({ type: 'image', source: { type: 'base64', media_type: mime, data: imagenB64 } });
  content.push({ type: 'text', text: `${PROMPT}\n\nTexto del mensaje${imagenB64 ? ' (pie de la foto)' : ''}:\n"""\n${String(texto).slice(0, 4000)}\n"""` });
  const r = await anthropic().beta.messages.create({
    model: MODELO,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: ESQUEMA } },
    messages: [{ role: 'user', content }],
  });
  if (r.stop_reason === 'refusal') throw new Error(`el modelo rechazó el mensaje (${r.stop_details?.category || 'sin categoría'})`);
  const txt = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let lectura;
  try { lectura = JSON.parse(txt); } catch (e) { throw new Error(`respuesta no es JSON (${r.stop_reason}): ${txt.slice(0, 120)}`); }
  return { lectura, ms: Date.now() - t0, modelo: r.model };
}

/** PURA. De la lectura de Claude al formato de patas de roll de sigma_senales ({tipo, strike, dia, mes, anio, q}). */
function aGestion(lectura) {
  if (!lectura || !lectura.es_gestion || !lectura.activo) return { ok: false, motivo: 'no es una gestión concreta' };
  const conv = (p) => ({ tipo: p.tipo, strike: p.strike, dia: p.dia, mes: p.mes, anio: p.anio,
                         q: (p.lado === 'vendida' ? -1 : 1) * Math.max(1, Math.abs(p.cantidad || 1)), precio: p.precio });
  const cerrar = (lectura.cerrar || []).map(conv);
  const abrir = (lectura.abrir || []).map(conv);
  if (!cerrar.length && !abrir.length) return { ok: false, motivo: 'la gestión no trae patas' };
  if (abrir.some((p) => !(p.dia >= 1 && p.dia <= 31 && p.mes >= 1 && p.mes <= 12))) {
    return { ok: false, motivo: 'una pata nueva no tiene vencimiento legible' };
  }
  return { ok: true, activo: String(lectura.activo).toUpperCase().replace(/[^A-Z0-9.]/g, ''), accion: lectura.accion,
           cerrar, abrir, netoPublicadoUsd: lectura.neto_usd };
}

/** PURA. Lectura con varias gestiones → { ok, gestiones: [aGestion ok…], descartadas: [motivos] }. Acepta la forma vieja (una sola). */
function aGestiones(lectura) {
  const lista = Array.isArray(lectura?.gestiones) ? lectura.gestiones : (lectura ? [lectura] : []);
  const gs = lista.map(aGestion);
  const buenas = gs.filter((g) => g.ok);
  if (!buenas.length) return { ok: false, motivo: gs.length ? gs[0].motivo : 'no es una gestión concreta', gestiones: [] };
  return { ok: true, gestiones: buenas, descartadas: gs.filter((g) => !g.ok).map((g) => g.motivo) };
}

module.exports = { interpretarGestion, aGestion, aGestiones, ESQUEMA };
