/**
 * SEÑALES DE MERCADO HORIZONTAL
 * =============================
 *
 * Dos indicadores calculados sobre velas de 15m que, juntos, estiman si el SPX
 * va a pasar el resto del dia sin recorrido amplio:
 *
 *   1. MACD EQUILIBRADO  -- |histograma| pequeño = ni compras ni ventas
 *      tienen el mando.
 *   2. EMAs TRANQUILAS   -- EMA10/20/50 apretadas entre si ("trenzadas"). Es la
 *      misma idea que el skill del premercado ya llamaba compas trenzado.
 *
 * Idea de Guillermo (2026-08-25): "MACD equilibrado y EMAs tranquilas... estas
 * señales me permiten estimar un SPX horizontal sin amplios recorridos".
 *
 * MEDIDO SOBRE 58 SESIONES (jun-ago 2026), tomando la señal a las 10:30 ET y
 * midiendo lo que hizo el precio de ahi al cierre:
 *
 *   filtro                          n    rango medio   |mov| medio   aciertos IB
 *   todas                          58        59,7         28,0          31%
 *   MACD equilibrado               29        59,2         24,2          41%
 *   EMAs tranquilas                29        50,7         22,7          31%
 *   MACD equilibrado + EMAs tranq  17        50,7         21,5          47%
 *   lo contrario                   17        66,9         36,9          29%
 *
 * Conclusion honesta: las señales DISCRIMINAN (21,5 vs 36,9 de movimiento medio
 * entre el mejor y el peor grupo, casi 2x), pero por si solas NO dan ventaja: el
 * EV del butterfly pasa de -5,12 a -1,94 pts. Recortan la perdida un 62% y no
 * cruzan el cero. Por eso se usan como GATE -- para no operar los peores dias,
 * que tienen EV -7,13 -- y no como generador de señal.
 *
 * ⚠️ EL CORTE EXACTO NO ESTA VALIDADO, Y CONVIENE NO OLVIDARLO.
 * Un barrido 2D de 7x7 cortes (MACD x dispersion) sobre las mismas 58 sesiones
 * dio EV negativo en TODAS las celdas (-2,26 a -6,04) sin gradiente alguno:
 * celdas vecinas saltaban de -4,17 a -2,26 a -2,42, mas de lo que se movia
 * cualquier tendencia. Eso es ruido de muestra pequeña.
 * La primera version de este archivo puso los umbrales en p50/p40 (3,4 y 16,4)
 * describiendolos como "el corte de mejor EV medido" -- que era literalmente
 * elegir el maximo del ruido. Sobreajuste.
 * Ahora estan en p60, a proposito flojos: filtran solo el 40% de dias
 * claramente agitados, que es lo unico que los datos sostienen. Si alguien
 * vuelve a bajarlos buscando "mejor EV" sobre esta misma muestra, esta
 * repitiendo el error.
 *
 * Falta la tercera pata (dominancia del GEX en un strike), que no se pudo medir
 * porque no hay historico de GEX por strike. Ver `gex_perfil.js`.
 */

'use strict';

function emaSerie(vals, n) {
  if (vals.length < n) return [];
  const k = 2 / (n + 1);
  let e = vals.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const out = new Array(n - 1).fill(null);
  out.push(e);
  for (let i = n; i < vals.length; i++) { e = vals[i] * k + e * (1 - k); out.push(e); }
  return out;
}

/** MACD(12,26,9) sobre los cierres. Devuelve el histograma de la ultima vela. */
function macdHist(cierres) {
  if (cierres.length < 35) return null;
  const e12 = emaSerie(cierres, 12), e26 = emaSerie(cierres, 26);
  const macd = [];
  for (let i = 0; i < cierres.length; i++) {
    if (e12[i] == null || e26[i] == null) continue;
    macd.push(e12[i] - e26[i]);
  }
  const sig = emaSerie(macd, 9);
  const iM = macd.length - 1, iS = sig.length - 1;
  if (iS < 0 || sig[iS] == null) return null;
  return macd[iM] - sig[iS];
}

/** Dispersion en PUNTOS entre EMA10/20/50. Cuanto menor, mas trenzadas. */
function dispersionEmas(cierres) {
  if (cierres.length < 50) return null;
  const v = [10, 20, 50].map(n => {
    const s = emaSerie(cierres, n);
    return s[s.length - 1];
  });
  if (v.some(x => x == null)) return null;
  return Math.max(...v) - Math.min(...v);
}

/**
 * Evalua las dos señales contra los umbrales.
 * @param {number[]} cierres  cierres de 15m, el ultimo es la vela mas reciente CERRADA
 * @param {object} cfg  { maxAbsMacdHist15m, maxDispEmas15mPts }
 */
function evaluar(cierres, cfg = {}) {
  const maxH = cfg.maxAbsMacdHist15m ?? 4.02;   // p60 de 58 sesiones
  const maxD = cfg.maxDispEmas15mPts ?? 20.6;   // p60 de 58 sesiones
  const h = macdHist(cierres);
  const d = dispersionEmas(cierres);
  if (h == null || d == null) {
    return { ok: false, macdHist: h, dispEmas: d,
             motivo: `sin velas suficientes para calcular las señales ` +
                     `(hacen falta 50 de 15m, hay ${cierres.length})` };
  }
  const macdOk = Math.abs(h) < maxH;
  const emasOk = d < maxD;
  const fallos = [];
  if (!macdOk) fallos.push(`MACD hist ${h.toFixed(2)} (|.| >= ${maxH}): hay pendiente`);
  if (!emasOk) fallos.push(`EMAs dispersas ${d.toFixed(1)} pts (>= ${maxD}): hay tendencia`);
  return {
    ok: macdOk && emasOk,
    macdHist: +h.toFixed(3),
    dispEmas: +d.toFixed(2),
    macdOk, emasOk,
    motivo: fallos.length ? fallos.join('; ')
      : `MACD hist ${h.toFixed(2)} y EMAs a ${d.toFixed(1)} pts: mercado horizontal`,
  };
}

module.exports = { evaluar, macdHist, dispersionEmas, emaSerie };
