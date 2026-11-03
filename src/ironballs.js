// ── Iron Balls — lector de las alertas de Pipe (2026-11-01) ─────────────────
//
// Guillermo pago el VIP de Iron Balls (ironballtraders.com) el 31-oct-2026. Las
// operaciones llegan al grupo de WhatsApp "📈 Canal Oficial - Iron Balls 📈" de la
// linea USA, donde solo publica Pipe, como la tarjeta que genera Sigma Trade:
//
//   🔔 *Options Alert — Sigma Trade*
//   📌 *SPX — Bull Put Spread*
//   🟢 Buy 1× Put 7640 (Oct 26, 2026) @ $6.57
//   🔴 Sell 1× Put 7645 (Oct 26, 2026) @ $7.77
//   💰 *Net Credit:* $120.00
//   ⏳ *DTE:* 0
//
// y el cierre, aparte:
//
//   ⚠️ CLOSED
//   (Shared on Oct 26)
//   ✅ SPX October 26 7640/7645 Bull Put Spread @ 83.33%
//   Gain of $100 per position
//
// Este modulo es PURO (sin red, sin disco): lo usan el servidor —que re-parsea el
// texto y NO confia en lo que le mande el lector local— y el lector de
// ironballs/lector.js, y lo prueba scripts/pruebas.js contra los 16 mensajes reales
// de sep-oct 2026.
//
// Lo que se sabia al escribirlo, sin maquillar:
//   - Las alertas NO traen TP ni SL (la web dice que si). La salida es el CLOSED.
//   - Varias alertas se publicaron segundos ANTES de su propio CLOSED, o sea
//     despues de que Pipe ya habia salido (15-oct: 4 s; 26-oct 1DTE: 1 s). Esas no
//     se pueden copiar y el lector las manda como 'ya_cerrada'.
//   - Hay alertas en ingles (Buy/Sell) y en espanol (Compra/Venta), y estructuras
//     que no son verticales (Iron Condor, Long Put Butterfly). La v1 solo opera las
//     4 verticales; el resto se registra como NO_SOPORTADA para decidir despues.

const VERSION = 'ironballs-v1';

const MESES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
                ene: 1, abr: 4, ago: 8, dic: 12 };

const NOMBRES = {
  'bull put spread':  'BULL_PUT_SPREAD',
  'bear call spread': 'BEAR_CALL_SPREAD',
  'bull call spread': 'BULL_CALL_SPREAD',
  'bear put spread':  'BEAR_PUT_SPREAD',
  'iron condor':      'IRON_CONDOR',
};
const VERTICALES = ['BULL_PUT_SPREAD', 'BEAR_CALL_SPREAD', 'BULL_CALL_SPREAD', 'BEAR_PUT_SPREAD'];
const ES_CREDITO = { BULL_PUT_SPREAD: true, BEAR_CALL_SPREAD: true, BULL_CALL_SPREAD: false, BEAR_PUT_SPREAD: false };
const DIRECCION = { BULL_PUT_SPREAD: 'BULLISH', BULL_CALL_SPREAD: 'BULLISH', BEAR_CALL_SPREAD: 'BEARISH', BEAR_PUT_SPREAD: 'BEARISH' };

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const num = (s) => Number(String(s).replace(/,/g, ''));
// WhatsApp mete *negritas*; se quitan para no depender de donde caen.
const limpiar = (t) => String(t || '').replace(/\*/g, '').replace(/\r/g, '');

function mes(nombre) {
  return MESES[String(nombre || '').slice(0, 3).toLowerCase()] || null;
}

function esAlerta(texto) { return /Options Alert/i.test(texto || ''); }
function esCierre(texto) { return /^\s*⚠️?\s*CLOSED\b/im.test(texto || '') || /\bCLOSED\b[\s\S]*\bSPX\b[\s\S]*@\s*-?[\d.]+%/i.test(texto || ''); }

// Clase de la vertical a partir de las patas, no del titulo: el titulo se valida
// contra esto. Venta mas arriba que la compra en puts = Bull Put (credito), etc.
function claseDeVertical(venta, compra) {
  if (venta.tipo !== compra.tipo) return null;
  if (venta.tipo === 'P') return venta.strike > compra.strike ? 'BULL_PUT_SPREAD' : 'BEAR_PUT_SPREAD';
  return venta.strike < compra.strike ? 'BEAR_CALL_SPREAD' : 'BULL_CALL_SPREAD';
}

// Clave para emparejar una apertura con su CLOSED: estructura + vencimiento +
// strikes ordenados. El CLOSED trae "7640/7645" (menor/mayor) sin año.
function claveDe(estructura, expiry, strikes) {
  return `${estructura}|${expiry}|${[...strikes].map(Number).sort((a, b) => a - b).join('/')}`;
}

/**
 * Parsea la tarjeta "Options Alert". Devuelve null si el texto no es una alerta.
 * { ok, motivo?, estructura, nombre, subyacente, patas[], vertical?, isCredit, netoDolares,
 *   prima, dte, spot, enlace, clave }
 */
function parsearAlerta(texto) {
  if (!esAlerta(texto)) return null;
  const t = limpiar(texto);
  const out = { tipo: 'apertura', version: VERSION, ok: false };

  const cab = t.match(/📌\s*([A-Z]{1,6})\s*[—–-]\s*([^\n]+)/);
  out.subyacente = cab ? cab[1].toUpperCase() : null;
  out.nombre = cab ? cab[2].trim() : null;
  const porNombre = out.nombre ? NOMBRES[out.nombre.toLowerCase()] : null;

  out.patas = [];
  const rePata = /(Buy|Sell|Compra|Venta|Vende|Compro)\s+(\d+)\s*[×x]\s*(Put|Call)\s+([\d,.]+)\s*\(\s*([A-Za-z]{3,})\s+(\d{1,2}),\s*(\d{4})\s*\)\s*@\s*\$?([\d,.]+)/gi;
  let m;
  while ((m = rePata.exec(t))) {
    const verbo = m[1].toLowerCase();
    out.patas.push({
      lado: (verbo === 'buy' || verbo.startsWith('compr')) ? 'BUY' : 'SELL',
      cantidad: Number(m[2]),
      tipo: m[3].toLowerCase() === 'put' ? 'P' : 'C',
      strike: num(m[4]),
      expiry: mes(m[5]) ? iso(Number(m[7]), mes(m[5]), Number(m[6])) : null,
      precio: num(m[8]),
    });
  }

  const neto = t.match(/Net\s+(Credit|Debit)\s*:\s*\$?([\d,.]+)/i);
  out.isCredit = neto ? neto[1].toLowerCase() === 'credit' : null;
  out.netoDolares = neto ? num(neto[2]) : null;               // DOLARES TOTALES por 1 contrato (gotcha 3)
  const prima = t.match(/Premium per contract\s*:\s*\$?([\d,.]+)/i);
  out.prima = prima ? num(prima[1]) : (out.netoDolares != null ? +(out.netoDolares / 100).toFixed(2) : null);
  const dte = t.match(/DTE\s*:\s*(\d+)/i);
  out.dte = dte ? Number(dte[1]) : null;
  const spot = t.match(/Current price of [A-Z]+\s*:\s*\$?([\d,.]+)/i);
  out.spot = spot ? num(spot[1]) : null;
  const enlace = t.match(/https:\/\/web\.sigma\.trade\/share\/\S+/i);
  out.enlace = enlace ? enlace[0] : null;

  if (out.subyacente !== 'SPX') { out.motivo = `subyacente ${out.subyacente || '?'} — solo se opera SPX`; return out; }
  if (!out.patas.length || out.patas.some(p => !p.expiry)) { out.motivo = 'no se pudieron leer las patas'; return out; }

  out.estructura = porNombre || 'OTRA';
  const expiries = [...new Set(out.patas.map(p => p.expiry))];
  out.expiry = expiries.length === 1 ? expiries[0] : null;

  // Vertical: exactamente 2 patas, 1x cada una, mismo tipo y vencimiento, una compra y una venta.
  const ventas = out.patas.filter(p => p.lado === 'SELL'), compras = out.patas.filter(p => p.lado === 'BUY');
  if (out.patas.length === 2 && ventas.length === 1 && compras.length === 1 && out.expiry &&
      ventas[0].cantidad === 1 && compras[0].cantidad === 1) {
    const clase = claseDeVertical(ventas[0], compras[0]);
    if (clase && porNombre && porNombre !== clase) {
      out.motivo = `el titulo dice ${porNombre} pero las patas arman ${clase} — no se opera`;
      out.estructura = clase;
      return out;
    }
    if (clase) {
      out.estructura = clase;
      out.vertical = {
        strategy: clase,
        direction: DIRECCION[clase],
        shortStrike: ventas[0].strike,
        longStrike: compras[0].strike,
        ancho: Math.abs(ventas[0].strike - compras[0].strike),
        expiry: out.expiry,
        tipo: ventas[0].tipo,
      };
      if (out.isCredit != null && out.isCredit !== ES_CREDITO[clase]) {
        out.motivo = `la alerta dice ${out.isCredit ? 'credito' : 'debito'} y ${clase} es lo contrario — no se opera`;
        return out;
      }
      out.isCredit = ES_CREDITO[clase];
      out.clave = claveDe(clase, out.expiry, [ventas[0].strike, compras[0].strike]);
      out.ok = true;
      return out;
    }
  }
  out.clave = out.expiry ? claveDe(out.estructura, out.expiry, out.patas.map(p => p.strike)) : null;
  out.motivo = `${out.nombre || out.estructura}: la v1 solo opera las 4 verticales de 1 contrato`;
  return out;
}

/**
 * Parsea el aviso "⚠️ CLOSED". `fechaMensaje` (Date o ISO) da el año, que el texto no trae.
 * { ok, estructura, expiry, strikes[], pct, resultadoDolares, gano, clave }
 */
function parsearCierre(texto, fechaMensaje) {
  if (!esCierre(texto)) return null;
  const t = limpiar(texto);
  const out = { tipo: 'cierre', version: VERSION, ok: false };
  const m = t.match(/([✅❌🟢🔴])?\s*SPX\s+([A-Za-z]{3,})\s+(\d{1,2})\s+([\d,.]+)\s*\/\s*([\d,.]+)(?:\s*\/\s*([\d,.]+))?(?:\s*\/\s*([\d,.]+))?\s+([A-Za-z ]+?)\s*@\s*(-?[\d.,]+)\s*%/i);
  if (!m) { out.motivo = 'no se pudo leer la linea del cierre'; return out; }
  const ref = fechaMensaje ? new Date(fechaMensaje) : new Date();
  const mm = mes(m[2]);
  if (!mm) { out.motivo = `mes ilegible: ${m[2]}`; return out; }
  // El CLOSED no trae año: el del mensaje, salvo el cruce dic->ene (un cierre de
  // diciembre que nombra un vencimiento de enero es del año siguiente).
  let y = ref.getUTCFullYear();
  const mesMsg = ref.getUTCMonth() + 1;
  if (mesMsg === 12 && mm === 1) y += 1;
  if (mesMsg === 1 && mm === 12) y -= 1;
  out.expiry = iso(y, mm, Number(m[3]));
  out.strikes = [m[4], m[5], m[6], m[7]].filter(Boolean).map(num);
  out.nombre = m[8].trim();
  out.estructura = NOMBRES[out.nombre.toLowerCase()] || 'OTRA';
  out.pct = num(m[9]);
  // 2-nov-2026: Pipe tambien escribe "Profit of $124 per position" (antes solo "Gain of").
  const res = t.match(/(Gain|Profit|Loss|Ganancia|Perdida|Pérdida)\s+of\s+\$?(-?[\d,.]+)/i) || t.match(/(Gain|Profit|Loss|Ganancia|P[eé]rdida)\s*:?\s*\$?(-?[\d,.]+)/i);
  if (res) {
    const pierde = /loss|p[eé]rdida/i.test(res[1]);
    out.resultadoDolares = (pierde ? -1 : 1) * Math.abs(num(res[2]));
  } else {
    out.resultadoDolares = null;
  }
  out.gano = out.resultadoDolares != null ? out.resultadoDolares > 0 : (m[1] ? ['✅', '🟢'].includes(m[1]) : null);
  out.clave = claveDe(out.estructura, out.expiry, out.strikes);
  out.ok = true;
  return out;
}

/** Despacha cualquier mensaje del canal. null = no es ni alerta ni cierre (mapas, capsulas, Zoom...). */
function parsearMensaje(texto, fechaMensaje) {
  return parsearAlerta(texto) || parsearCierre(texto, fechaMensaje);
}

module.exports = { VERSION, VERTICALES, ES_CREDITO, parsearAlerta, parsearCierre, parsearMensaje, esAlerta, esCierre, claveDe };
