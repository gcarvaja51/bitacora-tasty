'use strict';

// ── CONTEO DE IMPULSOS EN 15 MINUTOS (2026-08-27) ───────────────────────────
//
// Pedido de Guillermo el 27-ago, sobre una sesion que el bot cerro en +$400 pero
// donde el dinero estaba concentrado al principio: "necesitamos que el bot entre
// en el primer o segundo impulso; cuando se entra en el tercero, con un call wall
// cerca o por encima de mi objetivo, la probabilidad de que el precio se devuelva
// es muy alta".
//
// QUE MIDE. Dentro de la sesion regular, cuantos tramos a favor lleva el precio
// desde el extremo que abrio el movimiento. Para un ALCISTA se cuenta desde el
// minimo de la sesion hasta ahora: cada tramo minimo->maximo del zigzag es un
// impulso, y el que esta en curso tambien cuenta. Para un BAJISTA, el espejo
// desde el maximo.
//
// POR QUE ZIGZAG POR RETROCESO Y NO PIVOTES DE N BARRAS. Un fractal de "N barras
// a cada lado" en 15m se come los impulsos cortos y ademas solo confirma el
// pivote N barras tarde, que es justo cuando ya no sirve para decidir una
// entrada. El zigzag por retroceso confirma un maximo en cuanto el precio cede
// `umbral` desde el, que es lo mismo que se ve a ojo en el chart.
//
// EL UMBRAL ES POR DIA, NO FIJO. Cinco puntos son mucho en una sesion comprimida
// (25-ago: rango de 33 pts) y poco en una ancha (20-ago: 61 pts). Se ata a la
// mediana del rango real de las velas de 15m de ESE dia, con un piso para que en
// un dia muy plano no cuente ruido como impulsos.
//
// EVIDENCIA (backtest 2026-08-27 sobre las 53 ejecuciones cerradas de TENDENCIA
// con timestamp y spot de entrada, 16 sesiones del 4 al 27 de agosto):
//
//   BULLISH (n=26)          aciertos      P&L
//     impulso 1   n=9          67%       +435
//     impulso 2   n=11         73%       +500
//     impulso 3+  n=6          17%       -225      <- lo que Guillermo describio
//
//   BEARISH (n=27)          aciertos      P&L
//     impulsos 1-2 n=17        53%        -45
//     impulso 3+   n=10        80%       +540      <- AL REVES
//
// La brecha alcista aguanta quitando cualquier dia completo (+46,7 a +66,7 pp) y
// los seis casos del bucket vienen de CUATRO sesiones distintas, no de una sola.
// Pero son SEIS, y por eso esto NO VETA: con esa muestra negar entradas seria
// sobreajuste (el veto de muro pide ~25-30 casos limpios y no hay razon para
// bajar el liston aca). Lo que hace es mas barato de equivocarse: exige mas score
// para entrar y, sobre todo, COBRA ANTES. Ver evaluarImpulso() mas abajo.
//
// Y OJO CON LA SIMETRIA: la regla es ALCISTA. En bajista los datos dicen lo
// contrario y con mas casos (n=10). Aplicarla a las dos direcciones porque
// "suena razonable" seria romper la mitad bajista del sistema — que es
// exactamente el error que el veto de muro evito al no aplicarse en alcista.

const UMBRAL_PISO_PTS = 4.0;      // por debajo de esto se cuenta ruido como impulso
const UMBRAL_FACTOR = 1.2;        // sobre la mediana del rango de las velas del dia
const MIN_VELAS = 4;              // sin esto el zigzag no tiene de donde agarrarse

function mediana(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Umbral de retroceso para el zigzag, atado a la volatilidad real del dia.
 */
function umbralDelDia(velas) {
  const rangos = velas.map((v) => Number(v.h) - Number(v.l)).filter((r) => Number.isFinite(r) && r >= 0);
  return Math.max(UMBRAL_PISO_PTS, +(UMBRAL_FACTOR * mediana(rangos)).toFixed(2));
}

/**
 * Pivotes alternados del zigzag. Devuelve [{i, precio, tipo:'H'|'L'}].
 * Un maximo se confirma cuando el precio cede `umbral` desde el; un minimo, al reves.
 */
function zigzag(velas, umbral) {
  if (!velas.length) return [];
  const piv = [];
  let modo = null;                       // 'up' = buscando maximo | 'down' = buscando minimo
  let extI = 0;
  let extP = Number(velas[0].c);

  for (let i = 0; i < velas.length; i++) {
    const h = Number(velas[i].h);
    const l = Number(velas[i].l);
    if (modo === null || modo === 'up') {
      if (h >= extP) { extI = i; extP = h; }
      else if (extP - l >= umbral) {
        piv.push({ i: extI, precio: extP, tipo: 'H' });
        modo = 'down'; extI = i; extP = l;
        continue;
      }
    }
    if (modo === null || modo === 'down') {
      if (l <= extP) { extI = i; extP = l; }
      else if (h - extP >= umbral) {
        piv.push({ i: extI, precio: extP, tipo: 'L' });
        modo = 'up'; extI = i; extP = h;
      }
    }
    if (modo === null) modo = 'up';
  }
  return piv;
}

/**
 * En que impulso esta el precio ahora mismo.
 *
 * @param {Array}  velas      velas de 15m de la SESION EN CURSO, con {h,l,c}, en orden
 * @param {String} direction  'BULLISH' | 'BEARISH'
 * @returns {Object} { aplica, impulso, umbral, pivotes, origenIdx, velas, motivo }
 */
function contarImpulsos({ velas, direction } = {}) {
  if (!Array.isArray(velas) || velas.length < MIN_VELAS) {
    return { aplica: false, motivo: `hacen falta ${MIN_VELAS} velas de 15m de la sesion, hay ${Array.isArray(velas) ? velas.length : 0}` };
  }
  if (direction !== 'BULLISH' && direction !== 'BEARISH') {
    return { aplica: false, motivo: `direccion no reconocida: ${direction}` };
  }
  const limpias = velas.filter((v) => Number.isFinite(Number(v.h)) && Number.isFinite(Number(v.l)));
  if (limpias.length < MIN_VELAS) {
    return { aplica: false, motivo: 'las velas de 15m no traen high/low usables' };
  }

  const umbral = umbralDelDia(limpias);
  const piv = zigzag(limpias, umbral);
  const ultimo = limpias.length - 1;

  // El origen es el extremo contrario dentro de la sesion: el movimiento alcista
  // que estamos contando empezo en el minimo del dia, no en la primera vela.
  let origenIdx = 0;
  if (direction === 'BULLISH') {
    for (let i = 1; i <= ultimo; i++) if (Number(limpias[i].l) < Number(limpias[origenIdx].l)) origenIdx = i;
  } else {
    for (let i = 1; i <= ultimo; i++) if (Number(limpias[i].h) > Number(limpias[origenIdx].h)) origenIdx = i;
  }

  const tipoTramo = direction === 'BULLISH' ? 'H' : 'L';
  const tramosCerrados = piv.filter((p) => p.i > origenIdx && p.i <= ultimo && p.tipo === tipoTramo).length;

  return {
    aplica: true,
    impulso: tramosCerrados + 1,          // el tramo en curso cuenta
    tramosCerrados,
    umbral,
    origenIdx,
    origenPrecio: direction === 'BULLISH' ? Number(limpias[origenIdx].l) : Number(limpias[origenIdx].h),
    pivotes: piv.length,
    velas: limpias.length,
    direction,
  };
}

/**
 * Lectura del impulso para la senal.
 *
 * QUE PODER TIENE (decision de Guillermo, 2026-08-27): un impulso alcista tardio
 * NO veta la entrada — le SUBE EL LISTON, de `minScore` (80) a 90. Es la via
 * intermedia entre no hacer nada y vetar con 6 casos de muestra: encarece la
 * entrada en el tramo donde el backtest da 17% de acierto, sin cerrarla, y sigue
 * dejando pasar una senal excepcional. El mismo mecanismo que ya usa
 * `minScoreTrasPerdida` tras una perdida del dia.
 *
 * `impulsoTardio` se marca SOLO en alcista a partir del impulso 3: es lo unico
 * que el backtest sostiene. En bajista se calcula el impulso igual (hace falta
 * para seguir juntando muestra) pero NUNCA se marca — ahi el impulso 3+ es el
 * que gana, 8/10.
 *
 * FALLA ABIERTA A PROPOSITO: si no hay velas suficientes (`aplica:false`, tipico
 * en los primeros 45 min de sesion) no se sube nada. Una entrada tan temprana es
 * por definicion impulso 1 o 2, que es justo lo que no habria que encarecer;
 * subir el liston "por las dudas" seria castigar el tramo bueno.
 */
const IMPULSO_MAXIMO_ALCISTA = 3;
const MIN_SCORE_IMPULSO_TARDIO = 90;

// ── ESCALERA DE TP POR IMPULSO (decision de Guillermo, 2026-08-27) ──────────
//
// Se llego aca despues de medir que el liston de score casi no muerde: los
// scores de TENDENCIA se apilan arriba —mediana 90, y 146 de 361 valen
// exactamente 100— asi que subir el minimo no frenaba las entradas del 27-ago,
// que puntuaron 100 las tres. La palanca util no era la ENTRADA sino la SALIDA.
//
// La escalera sigue la logica del propio pedido: cuanto mas maduro el
// movimiento, menos recorrido le queda y antes hay que cobrar.
//
//   impulso 1   TP 35%   el tramo con mas pista por delante: se le deja correr
//   impulso 2   TP 30%   el de config, sin tocar (es el bucket que mejor anda:
//                        73% de acierto, +500 — no hay nada que arreglarle)
//   impulso 3+  TP 15%   "la probabilidad de que el precio se devuelva es muy
//                        alta": se cobra antes en vez de negar la entrada
//
// SOLO ALCISTA, igual que el resto del modulo. En bajista el impulso 3+ es el
// que gana (8/10, +540) y tocarle el TP seria arreglar lo que no esta roto.
//
// Efecto esperado, dicho sin adornos. En el tramo 3+: mas ganadoras y mas
// chicas — en los seis casos del backtest el problema no fue entrar tarde per
// se, fue que el precio se dio vuelta antes de llegar al 30%, y cuatro de los
// seis terminaron en 0 o en perdida; un TP de 15% convierte parte de esos en
// ganancia chica. Lo que NO arregla son los que se dieron vuelta de inmediato:
// ahi manda el SL. Y en el impulso 1 el efecto es el contrario y hay que
// asumirlo: subir el TP de 30 a 35 va a bajar algo el porcentaje de aciertos a
// cambio de que los aciertos sean mas grandes. Con 9 casos en ese bucket no hay
// forma de saber todavia si el cambio suma o resta — queda medido en el
// registro (`tpPctExigido` viaja congelado en cada ejecucion) para que el
// Auditor lo dictamine con muestra.
const TP_PCT_POR_IMPULSO_ALCISTA = { 1: 35, 3: 15 };   // el 2 usa el de config
const TP_PCT_IMPULSO_TARDIO = TP_PCT_POR_IMPULSO_ALCISTA[3];

/**
 * TP a exigir segun el impulso, o null para dejar el de configuracion.
 * El 3 es un piso: impulso 4, 5... tambien cobran al 15%.
 */
function tpPctPorImpulso(direction, impulso) {
  if (direction !== 'BULLISH' || !Number.isFinite(impulso)) return null;
  if (impulso >= IMPULSO_MAXIMO_ALCISTA) return TP_PCT_POR_IMPULSO_ALCISTA[3];
  return TP_PCT_POR_IMPULSO_ALCISTA[impulso] ?? null;
}

function evaluarImpulso({ velas, direction, callWall, putWall, spxPrice, margenMuro } = {}) {
  const base = contarImpulsos({ velas, direction });
  if (!base.aplica) {
    return { ...base, impulsoTardio: false, minScoreExigido: null, tpPctExigido: null };
  }

  const impulsoTardio = direction === 'BULLISH' && base.impulso >= IMPULSO_MAXIMO_ALCISTA;

  // El muro va de acompanante, no de condicion: la parte "call wall cerca" de la
  // hipotesis original YA se midio el 16-ago y en alcista no predijo nada (brecha
  // de 3,6 pp, y los 4 trades abiertos pasado el Call Wall ganaron los 4). Se
  // guarda para poder cruzar las dos cosas cuando haya muestra, no para vetar.
  const muro = direction === 'BULLISH' ? callWall : putWall;
  const aire = Number.isFinite(muro) && Number.isFinite(spxPrice)
    ? +((direction === 'BULLISH' ? muro - spxPrice : spxPrice - muro)).toFixed(2)
    : null;

  return {
    ...base,
    impulsoTardio,
    minScoreExigido: impulsoTardio ? MIN_SCORE_IMPULSO_TARDIO : null,
    tpPctExigido:    tpPctPorImpulso(direction, base.impulso),
    umbralImpulso: IMPULSO_MAXIMO_ALCISTA,
    muro: Number.isFinite(muro) ? muro : null,
    aire,
    margenMuro: Number.isFinite(margenMuro) ? margenMuro : null,
    nota: impulsoTardio
      ? `impulso ${base.impulso} en 15m (umbral ${base.umbral} pts): tercer tramo alcista o más, donde el backtest del 27-ago da 17% de acierto contra 70% en los dos primeros — score mínimo ${MIN_SCORE_IMPULSO_TARDIO}% y TP acortado a ${TP_PCT_IMPULSO_TARDIO}%`
      : `impulso ${base.impulso} en 15m (umbral ${base.umbral} pts)`
        + (tpPctPorImpulso(direction, base.impulso) ? ` — TP ${tpPctPorImpulso(direction, base.impulso)}%` : ''),
  };
}

module.exports = {
  contarImpulsos,
  evaluarImpulso,
  zigzag,
  umbralDelDia,
  IMPULSO_MAXIMO_ALCISTA,
  MIN_SCORE_IMPULSO_TARDIO,
  TP_PCT_IMPULSO_TARDIO,
  TP_PCT_POR_IMPULSO_ALCISTA,
  tpPctPorImpulso,
};
