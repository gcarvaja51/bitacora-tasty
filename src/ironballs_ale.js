'use strict';
// ── Iron Balls — las entradas de ALEJANDRO (Guillermo 2026-11-10) ───────────────────────────
//
// En el grupo "Operaciones by Iron Balls" (linea Colombia) Alejandro NO manda tarjeta de texto: sube una
// captura de OptionStrat ("Evaluen" / "Armando, evaluen") y los strikes van EN LA FOTO. Luego escribe:
//   "Evalúe entrada bajista… Nivel de control alrededor del 7486.37 (No debe traspasar al alza)"
//   "Dentro con 2.05"            (a veces)
//   "Fuera +40 x contrato"       (salida)
//   "Fuera runners +90 x contrato"
// Entre la foto y el "Fuera" pasan 5-15 min, casi siempre 13:00-14:45 NY.
//
// Como lee OptionStrat (comprobado en las 6 fotos del 2 al 10-nov-2026):
//   - etiqueta de ARRIBA de la regla de strikes = pata COMPRADA, la de ABAJO = VENDIDA
//     (ej. 7495C arriba / 7490C abajo = Bear Call 7490/7495; 7485P arriba / 7490P abajo = Bull Put 7490/7485)
//   - el color es el tipo (verde = call, rojo = put), NO el lado
//   - la fecha resaltada en la fila de fechas = vencimiento; NET CREDIT / MAX LOSS / CHANCE OF PROFIT / BREAKEVEN visibles
//
// Decisiones de Guillermo (10-nov): entra CON LA FOTO (llega 0-7 min antes que el texto), 1 contrato,
// stop por perdida de $150 por contrato, cierra con el primer "Fuera". Demo propia (TastyTrade dry-run).
//
// La foto la lee Claude (vision) y devuelve SOLO lo que ve (etiquetas, posicion, fecha, numeros). La
// clase de la vertical, el lado de cada pata y las validaciones las hace ESTE codigo, no el modelo.

const VERSION = 'ironballs-ale-v1';
const MODELO = process.env.IRONBALLS_MODELO_VISION || 'claude-opus-5-5';

const PROMPT = `Esta imagen la publica un mentor de trading en WhatsApp. Puede ser una captura de OptionStrat (calculadora de opciones) o cualquier otra cosa (grafico de velas, mapa de niveles, meme, texto).

Si es una captura de OptionStrat, lee EXACTAMENTE lo que se ve, sin interpretar la estrategia:
- En la regla "STRIKES" hay etiquetas de strike con forma de globo (ej. "7495C", "7490P"). Para cada etiqueta da el numero, la letra (C o P) y si el globo esta ARRIBA de la regla o ABAJO de la regla.
- En la fila de fechas (encima de "STRIKES") hay un dia resaltado (recuadro de color). Da ese numero de dia y el mes de la barra que lo contiene (ej. "Nov").
- Los valores de NET CREDIT o NET DEBIT, MAX LOSS, MAX PROFIT y CHANCE OF PROFIT tal como aparecen, en numero (sin $ ni %). Si no aparece alguno, null.
- El texto de BREAKEVEN tal como aparece.
Si no es una captura de OptionStrat, marca es_optionstrat=false y deja lo demas vacio o null.
No adivines: si un numero no se lee con claridad, pon null.`;

const ESQUEMA = {
  type: 'object',
  properties: {
    es_optionstrat: { type: 'boolean' },
    etiquetas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          strike: { type: 'number' },
          tipo: { type: 'string', enum: ['C', 'P'] },
          posicion: { type: 'string', enum: ['arriba', 'abajo'] },
        },
        required: ['strike', 'tipo', 'posicion'],
        additionalProperties: false,
      },
    },
    dia_resaltado: { type: ['integer', 'null'] },
    mes_resaltado: { type: ['string', 'null'] },
    net_credit: { type: ['number', 'null'] },
    net_debit: { type: ['number', 'null'] },
    max_loss: { type: ['number', 'null'] },
    max_profit: { type: ['number', 'null'] },
    chance_of_profit: { type: ['number', 'null'] },
    breakeven: { type: ['string', 'null'] },
  },
  required: ['es_optionstrat', 'etiquetas', 'dia_resaltado', 'mes_resaltado', 'net_credit', 'net_debit',
             'max_loss', 'max_profit', 'chance_of_profit', 'breakeven'],
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

/** Lee la foto con Claude. Devuelve { lectura, ms, modelo } o lanza error. */
async function leerFoto({ b64, mime = 'image/jpeg' }) {
  const t0 = Date.now();
  const r = await anthropic().beta.messages.create({
    model: MODELO,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: ESQUEMA } },
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
      { type: 'text', text: PROMPT },
    ] }],
  });
  if (r.stop_reason === 'refusal') throw new Error(`el modelo rechazó la imagen (${r.stop_details?.category || 'sin categoría'})`);
  const txt = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let lectura;
  try { lectura = JSON.parse(txt); } catch (e) { throw new Error(`respuesta no es JSON (${r.stop_reason}): ${txt.slice(0, 120)}`); }
  return { lectura, ms: Date.now() - t0, modelo: r.model };
}

const MESES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
                ene: 1, abr: 4, ago: 8, dic: 12 };
const pad = (n) => String(n).padStart(2, '0');

/**
 * PURA. De la lectura de la foto a una vertical operable. hoyET = 'AAAA-MM-DD' (fecha NY del mensaje).
 * Devuelve el mismo formato que ironballs.parsearAlerta para que la demo lo abra igual:
 * { tipo:'apertura', ok, motivo?, vertical, clave, prima, isCredit, dte, spot:null, foto:{...} }
 */
function armarDesdeFoto(lectura, hoyET) {
  const out = { tipo: 'apertura', version: VERSION, ok: false, fuente: 'ALEJANDRO', spot: null, foto: lectura };
  if (!lectura || !lectura.es_optionstrat) { out.motivo = 'la foto no es una captura de OptionStrat'; out.noEsTarjeta = true; return out; }
  const et = Array.isArray(lectura.etiquetas) ? lectura.etiquetas : [];
  if (et.length !== 2) { out.motivo = `se leyeron ${et.length} etiquetas de strike (la v1 solo opera verticales de 2 patas)`; return out; }
  const compra = et.find((e) => e.posicion === 'arriba');
  const venta = et.find((e) => e.posicion === 'abajo');
  if (!compra || !venta) { out.motivo = 'no hay una etiqueta arriba (compra) y otra abajo (venta)'; return out; }
  if (compra.tipo !== venta.tipo) { out.motivo = `patas de distinto tipo (${compra.tipo}/${venta.tipo})`; return out; }
  const ancho = Math.abs(venta.strike - compra.strike);
  if (!(ancho > 0 && ancho <= 25)) { out.motivo = `ancho de ${ancho} pts fuera de rango`; return out; }
  if (!(venta.strike > 1000 && venta.strike < 20000)) { out.motivo = `strike ${venta.strike} no parece del SPX`; return out; }

  const tipo = venta.tipo;
  const strategy = tipo === 'P' ? (venta.strike > compra.strike ? 'BULL_PUT_SPREAD' : 'BEAR_PUT_SPREAD')
                                : (venta.strike < compra.strike ? 'BEAR_CALL_SPREAD' : 'BULL_CALL_SPREAD');
  const credito = strategy === 'BULL_PUT_SPREAD' || strategy === 'BEAR_CALL_SPREAD';
  if (lectura.net_credit != null && !credito) { out.motivo = `la foto dice NET CREDIT pero las patas arman ${strategy}`; return out; }
  if (lectura.net_debit != null && credito) { out.motivo = `la foto dice NET DEBIT pero las patas arman ${strategy}`; return out; }

  // vencimiento: el dia resaltado; si es menor que hoy, es del mes siguiente
  const [y, m, d] = hoyET.split('-').map(Number);
  const dia = Number(lectura.dia_resaltado);
  if (!(dia >= 1 && dia <= 31)) { out.motivo = 'no se leyó el día de vencimiento'; return out; }
  let mm = MESES[String(lectura.mes_resaltado || '').slice(0, 3).toLowerCase()] || (dia >= d ? m : m + 1);
  let yy = y;
  if (mm < m && !(m === 12 && mm === 1)) { out.motivo = `vencimiento ${dia}/${mm} ya pasó`; return out; }
  if (mm > 12) { mm = 1; yy += 1; }
  if (m === 12 && mm === 1) yy = y + 1;
  const expiry = `${yy}-${pad(mm)}-${pad(dia)}`;
  if (expiry < hoyET) { out.motivo = `vencimiento ${expiry} anterior a hoy`; return out; }
  const dte = Math.round((new Date(expiry + 'T12:00:00Z') - new Date(hoyET + 'T12:00:00Z')) / 86400000);
  if (dte > 7) { out.motivo = `vence en ${dte} días (la v1 copia 0-7 DTE)`; return out; }

  const neto = credito ? lectura.net_credit : lectura.net_debit;
  Object.assign(out, {
    ok: true, estructura: strategy, expiry, dte, isCredit: credito,
    prima: neto != null ? +(Number(neto) / 100).toFixed(2) : null,      // la foto da $195 = 1.95 por contrato
    netoDolares: neto != null ? Number(neto) : null,
    vertical: { strategy, direction: strategy.startsWith('BULL') ? 'BULLISH' : 'BEARISH',
                shortStrike: venta.strike, longStrike: compra.strike, ancho, expiry, tipo },
    clave: `ALE|${strategy}|${expiry}|${[venta.strike, compra.strike].sort((a, b) => a - b).join('/')}`,
  });
  return out;
}

/**
 * PURA. Los textos de Alejandro que importan. null = charla.
 *   { tipo:'salida', runners, usd }     "Fuera +40 x contrato" / "Fuera runners +90"
 *   { tipo:'control', nivel, direccion } "Evalúe entrada bajista ... Nivel de control alrededor del 7486.37"
 *   { tipo:'dentro', credito }          "Dentro con 2.05" / "Credito 2.50"
 */
function parsearTextoAle(texto) {
  const t = String(texto || '').replace(/[*_~]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const out = {};
  const sal = t.match(/\bfuera\s+(runners?\s+)?([+\-−])\s*\$?\s*(\d+(?:[.,]\d+)?)/i);
  if (sal) {
    out.salida = { runners: !!sal[1], usd: (sal[2] === '+' ? 1 : -1) * Number(sal[3].replace(',', '.')) };
  }
  const ctl = t.match(/nivel de control[^\d]{0,30}(\d{4,5}(?:[.,]\d+)?)/i);
  if (ctl) {
    const dir = /entrada\s+bajista/i.test(t) ? 'BEARISH' : /entrada\s+alcista/i.test(t) ? 'BULLISH' : null;
    out.control = { nivel: Number(ctl[1].replace(',', '.')), direccion: dir };
  }
  const den = t.match(/\b(?:dentro con|entr[eé] con|cr[eé]dito)\s*\$?\s*(\d+(?:[.,]\d+)?)/i);
  if (den) {
    const v = Number(den[1].replace(',', '.'));
    if (v > 0 && v < 25) out.dentro = { credito: v };
  }
  return Object.keys(out).length ? out : null;
}

module.exports = { VERSION, MODELO, leerFoto, armarDesdeFoto, parsearTextoAle, _ESQUEMA: ESQUEMA };
