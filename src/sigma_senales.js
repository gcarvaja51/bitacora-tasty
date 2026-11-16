'use strict';
// ── Señales del canal "Notificaciones 5 de Opción Sigma" → libro Señales Sigma (Guillermo 2026-11-16) ────────────
//
// Funciones PURAS (sin red ni disco): leen el texto de un mensaje del canal y dicen qué es.
//   - parsearSenalSigma(texto, { mensajeAt, autorJid }) → { tipo: 'apertura' | 'cierre' | 'otro', profe, ... }
//   - inicioVentana(mensajeAt, calendario) / venceVentana(...) → la regla de los 30 minutos
//
// Reglas de Guillermo (16-nov-2026):
//   - "la señal de sigma tiene máximo 30 minutos de vida": si el demo no entra en 30 min desde que se publicó,
//     queda VENCIDA. Si se publicó con el mercado cerrado, los 30 min cuentan desde la siguiente apertura (9:30 ET).
//   - En Señales Sigma NO hay meta diaria de $200: se toman todas las que se puedan tomar.
//
// Quién manda qué (verificado contra Sigma Terminal el 16-nov):
//   13213201370  = Luis Silva Sinning
//   5491125371038 = Facu Melo (alertas en inglés; antes se creía Gonza, error corregido el 16-nov)
//   34605855722  = Tarri Sigma Club: publica las de Henry, Gonza, Rocío… con "POSICIÓN/OPERACIÓN DE X"; sin nombre = Tarri

const REMITENTES = { '13213201370': 'Luis', '5491125371038': 'Facu', '34605855722': 'Tarri' };

// Nombre corto y estable del profe (la asertividad por profe depende de que sea siempre el mismo).
const ALIAS = { GONZALO: 'Gonza', GONZA: 'Gonza', ROCIO: 'Rocío', 'ROCÍO': 'Rocío', HENRY: 'Henry', LUIS: 'Luis',
                TARRI: 'Tarri', FACU: 'Facu', FACUNDO: 'Facu', CRISTIAN: 'Cristian', PIPE: 'Pipe' };

const MESES = { jan: 1, ene: 1, feb: 2, mar: 3, apr: 4, abr: 4, may: 5, jun: 6, jul: 7, aug: 8, ago: 8, sep: 9, set: 9,
                oct: 10, nov: 11, dec: 12, dic: 12 };
const MESES_LARGOS = { january: 1, enero: 1, february: 2, febrero: 2, march: 3, marzo: 3, april: 4, abril: 4, may: 5,
                       mayo: 5, june: 6, junio: 6, july: 7, julio: 7, august: 8, agosto: 8, september: 9, septiembre: 9,
                       setiembre: 9, october: 10, octubre: 10, november: 11, noviembre: 11, december: 12, diciembre: 12 };

const num = (s) => { const n = parseFloat(String(s).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const sinTildes = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');

function profeDe(texto, autorJid) {
  const m = sinTildes(texto).match(/(?:POSICION|OPERACION)\s+DE\s+([A-Z]+)/i);
  if (m) {
    const k = m[1].toUpperCase();
    return ALIAS[k] || (k.charAt(0) + k.slice(1).toLowerCase());
  }
  return REMITENTES[String(autorJid || '').split('@')[0]] || 'Desconocido';
}

// Tercer viernes del mes: el vencimiento mensual del SPX (raíz SPX, AM). El resto de los días, SPXW.
function esTercerViernes(y, m, d) {
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 5 && d >= 15 && d <= 21;
}

function raizOpcion(activo, y, m, d) {
  if (activo === 'SPX') return esTercerViernes(y, m, d) ? 'SPX' : 'SPXW';
  if (activo === 'NDX') return esTercerViernes(y, m, d) ? 'NDX' : 'NDXP';
  if (activo === 'RUT') return esTercerViernes(y, m, d) ? 'RUT' : 'RUTW';
  return activo;
}

// Símbolo en el formato que usa el servidor (Tradier/OCC sin espacios): SPXW261218P07500000
function simbolo(activo, y, m, d, tipo, strike) {
  const r = raizOpcion(activo, y, m, d);
  const fecha = `${String(y).slice(2)}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
  return `${r}${fecha}${tipo}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
}

// "🔴 Sell 1× Put 7500 (Dec 18, 2026) @ $132.45" | "🟢 Compra 1× Call 279 (nov 23, 2026) @ $1.135"
const RE_PATA = /(Sell|Buy|Venta|Compra)\s+(\d+)\s*[×x]\s*(Put|Call)\s+([\d.]+)\s*\(\s*([A-Za-zÁÉÍÓÚáéíóú]{3})[a-zé]*\.?\s+(\d{1,2}),\s*(\d{4})\s*\)\s*@\s*\$?\s*([\d.,]+)/gi;

function parsearApertura(texto, base) {
  const activoM = texto.match(/📌\s*\*?\s*([A-Z][A-Z0-9.]{0,6})\s*[—–-]\s*([^*\n]+)/);
  const activo = activoM ? activoM[1] : null;
  const estrategia = activoM ? activoM[2].trim() : null;
  const patas = [];
  let m;
  RE_PATA.lastIndex = 0;
  while ((m = RE_PATA.exec(texto))) {
    const vende = /^(sell|venta)$/i.test(m[1]);
    const q = Number(m[2]) * (vende ? -1 : 1);
    const tipo = /^put$/i.test(m[3]) ? 'P' : 'C';
    const strike = num(m[4]);
    const mes = MESES[sinTildes(m[5]).toLowerCase()];
    const dia = Number(m[6]), anio = Number(m[7]);
    if (!activo || !mes || strike == null) continue;
    patas.push({ sym: simbolo(activo, anio, mes, dia, tipo, strike), q, tipo, strike,
                 vto: `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`, precio: num(m[8]) });
  }
  const cred = texto.match(/(?:Net Credit|Cr[eé]dito Neto)\s*:?\**\s*:?\s*\$\s*([\d.,]+)/i);
  const deb = texto.match(/(?:Net Debit|D[eé]bito Neto)\s*:?\**\s*:?\s*\$\s*([\d.,]+)/i);
  const riesgo = texto.match(/(?:Max loss|P[eé]rdida m[aá]x)[^:$\n]*:?\**\s*:?\s*\$\s*([\d.,]+)/i);
  const pop = texto.match(/(?:Probability of profit|Probabilidad de (?:beneficio|ganancia|éxito|exito))\s*:?\**\s*:?\s*([\d.]+)\s*%/i);
  const netoUsd = cred ? num(cred[1]) : deb ? -num(deb[1]) : null;   // + crédito, - débito (por contrato, en $)
  const ok = !!activo && patas.length > 0;
  return { ...base, tipo: 'apertura', ok, activo, estrategia, patas,
           netoPublicado: netoUsd != null ? +(netoUsd / 100).toFixed(3) : null,   // por acción, + crédito
           riesgoUsd: riesgo ? num(riesgo[1]) : null, pop: pop ? num(pop[1]) : null,
           motivo: ok ? null : (activo ? 'no se leyeron las patas' : 'no se leyó el activo') };
}

// "✅ SPX December 18 7490/7500 Bull Put Spread @ 14.49%" | "✅ GOOG 11 de diciembre 275/280/350/355 Iron Condor @ 27.91%"
// "❌ SPY October 19 772/772/785/785 Double Calendar Spread @ -29.41%" | "✅ NU Dec 18 12 Short Put @ 69.15%"
function parsearCierre(texto, base) {
  const linea = (texto.split('\n').find((l) => /^\s*(✅|❌)/.test(l)) || '').replace(/^\s*(✅|❌)\s*/, '');
  const activoM = linea.match(/^([A-Z][A-Z0-9.]{0,6})\b/);
  const activo = activoM ? activoM[1] : null;
  let mes = null, dia = null;
  const largo = linea.match(/\b(\d{1,2})\s+de\s+([a-záéíóú]+)/i);
  const ingles = linea.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})\b/);
  if (largo) { dia = Number(largo[1]); mes = MESES_LARGOS[sinTildes(largo[2]).toLowerCase()] || null; }
  else if (ingles) {
    const k = sinTildes(ingles[1]).toLowerCase();
    mes = MESES_LARGOS[k] || MESES[k.slice(0, 3)] || null;
    if (mes) dia = Number(ingles[2]);
  }
  // strikes: el primer grupo "a/b[/c/d]" o, si no hay barras, el número suelto antes del nombre de la estrategia
  const grupo = linea.match(/(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)+)/);
  let strikes = grupo ? grupo[1].split('/').map(Number) : [];
  if (!strikes.length) {
    const suelto = linea.replace(/^[A-Z.]+\s+/, '').match(/(?:^|\s)(\d+(?:\.\d+)?)\s+(?:[A-Z]{2,5}\s+\w+\s+\d+\s+[\d.]+\s+)?(?:Short|Cash|Long|Covered|Naked)/i);
    if (suelto) strikes = [Number(suelto[1])];
  }
  if (!strikes.length) {   // "✅ BULL Cash Secured Put Strike 7.5 @ 80%"
    const st = linea.match(/Strike\s+(\d+(?:\.\d+)?)/i);
    if (st) strikes = [Number(st[1])];
  }
  const pct = linea.match(/@\s*(-?[\d.]+)\s*%/);
  const precio = texto.match(/(?:Cerrad[oa] a|Closed at)\s*([\d.,]+)\s*(?:de\s*)?(d[eé]bito|debit|cr[eé]dito|credit)/i);
  const pnl = texto.match(/(Ganancia|Gain|Profit|P[eé]rdida|Loss)\s+(?:de|of)\s*\$?\s*([\d.,]+)/i);
  const signo = pnl && /p[eé]rdida|loss/i.test(pnl[1]) ? -1 : 1;
  return { ...base, tipo: 'cierre', ok: !!activo && strikes.length > 0, activo, mes, dia,
           strikes: [...new Set(strikes)].sort((a, b) => a - b),
           pctPublicado: pct ? num(pct[1]) : null,
           precioCierre: precio ? num(precio[1]) : null,
           efectoCierre: precio ? (/d[eé]bito|debit/i.test(precio[2]) ? 'debito' : 'credito') : null,
           pnlPublicadoUsd: pnl ? signo * num(pnl[2]) : null,
           linea: linea.slice(0, 200), motivo: activo ? null : 'no se leyó el activo del cierre' };
}

function parsearSenalSigma(texto, { mensajeAt = null, autorJid = '' } = {}) {
  const t = String(texto || '');
  const base = { profe: profeDe(t, autorJid), mensajeAt };
  if (/Options Alert|Alerta de Opci[oó]n/i.test(t)) return parsearApertura(t, base);
  if (/(CERRAD[OA]|CLOSED)/.test(t) && /(✅|❌)/.test(t)) return parsearCierre(t, base);
  return { ...base, tipo: 'otro', ok: false, motivo: 'no es una alerta de apertura ni de cierre' };
}

// ¿Este trade abierto es el que el cierre menciona? Mismo activo, mismos strikes y (si el cierre trae fecha) mismo vencimiento.
function coincideCierre(trade, cierre) {
  if (!trade || !cierre || trade.activo !== cierre.activo) return false;
  const ks = [...new Set((trade.patas || []).map((p) => Number(p.strike)))].sort((a, b) => a - b);
  if (ks.length !== cierre.strikes.length || ks.some((k, i) => Math.abs(k - cierre.strikes[i]) > 1e-6)) return false;
  if (cierre.mes && cierre.dia) {
    const vtos = (trade.patas || []).map((p) => p.vto);
    // un calendario tiene dos vencimientos: basta con que el cierre nombre uno de ellos
    return vtos.some((v) => Number(v.slice(5, 7)) === cierre.mes && Number(v.slice(8, 10)) === cierre.dia);
  }
  return true;
}

// Regla de los 30 minutos. `calendario` = src/calendario_nyse.js (se pregunta, no se reimplementa: gotcha 12).
const VIDA_MIN = 30;
function inicioVentana(mensajeAt, calendario) {
  const t = new Date(mensajeAt);
  if (calendario.enHorarioDeMercado(t)) return t;
  // Antes de la apertura de un día de mercado: cuenta desde las 9:30 ET de ese día. Si no, desde la próxima apertura.
  const apertura = (fecha) => {
    // 9:30 ET de `fecha` (YYYY-MM-DD) expresado en UTC: se prueba -4 y -5 horas y se queda el que cae a las 9:30 ET
    for (const off of [4, 5]) {
      const d = new Date(`${fecha}T${String(9 + off).padStart(2, '0')}:30:00Z`);
      if (calendario.minutosET(d) === 570) return d;
    }
    return new Date(`${fecha}T14:30:00Z`);
  };
  const hoy = calendario.fechaET(t);
  if (calendario.esDiaDeMercado(t) && calendario.minutosET(t) < 570) return apertura(hoy);
  return apertura(calendario.siguienteDiaDeMercado(t));
}
function venceVentana(mensajeAt, calendario) {
  return new Date(inicioVentana(mensajeAt, calendario).getTime() + VIDA_MIN * 60000);
}

module.exports = { parsearSenalSigma, coincideCierre, inicioVentana, venceVentana, simbolo, raizOpcion, profeDe,
                   esTercerViernes, VIDA_MIN, REMITENTES };
