'use strict';
// ── Direccional v2: freno del premercado + DIR-5 + salida TP75/SL75 (Guillermo 2026-11-09) ──────────────
//
// Paquete decidido con el backtest de 183 trades reales (17-ago -> 9-nov) cruzados con el premercado:
//   - Freno del premercado: no abrir en la direccion CONTRARIA al escenario favorito del premercado del dia.
//     Guillermo descarto la condicion "30% o menos" (solo 5 trades la sostenian): se calcula y se anota en
//     sombra, pero no bloquea. Sin premercado cargado ese dia, el freno deja pasar (y lo anota).
//   - DIR-5: no abrir un BAJISTA cuyo TP quede del otro lado del Put Wall. Se evalua contra un TP de
//     REFERENCIA de 30% (el que existia cuando se midio), no contra el TP de 75% de la salida nueva: con 75%
//     el veto se volveria mucho mas estricto y dejaria de ser el filtro que se midio.
//   - Salida: TP 75% / SL 75% de la prima, en credito y en debito. Reemplaza a la escalera de TP por impulso.
// Se activan los tres juntos con trading.direccionalV2.activo (decision de Guillermo: "los tres juntos, como
// una version nueva"). Con el interruptor apagado se calcula todo igual y queda en sombra en cada trade.

const V2_DEFAULTS = {
  activo: false,
  frenoPremercado: true,
  dir5: true,
  dir5TpReferenciaPct: 30,
  tpPct: 75,      // % de la prima: credito = recomprar a 25% del credito; debito = vender a 175% del debito
  slPct: 75,      // % de la prima: credito = recomprar a 175% del credito (slMult 1.75); debito = vender a 25%
};

function configV2(cfg) {
  const v = (cfg && cfg.trading && cfg.trading.direccionalV2) || {};
  return { ...V2_DEFAULTS, ...v, activo: v.activo === true };
}

// Lado del premercado que corresponde a la direccion del trade
const ladoDe = (direction) => (direction === 'BULLISH' ? 'alcista' : direction === 'BEARISH' ? 'bajista' : null);

// Lectura del premercado para una direccion. `prem` = la entrada del dia ({ fecha, probabilidades:{alcista,
// neutral, bajista} }) o null. Un empate en la probabilidad mas alta NO cuenta como favorito contrario.
function evaluarFrenoPremercado(direction, prem) {
  const lado = ladoDe(direction);
  const pr = prem && prem.probabilidades;
  const nums = pr && ['alcista', 'neutral', 'bajista'].every((k) => Number.isFinite(Number(pr[k])));
  if (!lado || !nums) {
    return { hayPremercado: false, bloquea: false, contraFavorito: false, bajo30: false,
             motivo: prem ? 'premercado sin probabilidades validas' : 'sin premercado cargado para hoy: deja pasar' };
  }
  const p = { alcista: Number(pr.alcista), neutral: Number(pr.neutral), bajista: Number(pr.bajista) };
  const max = Math.max(p.alcista, p.neutral, p.bajista);
  const tope = Object.keys(p).filter((k) => p[k] === max);
  const favorito = tope.length === 1 ? tope[0] : null;          // null = empate
  const opuesto = lado === 'alcista' ? 'bajista' : 'alcista';
  const contraFavorito = favorito === opuesto;
  const bajo30 = p[lado] <= 30;
  return {
    hayPremercado: true, fecha: prem.fecha || null, probabilidades: p, favorito, probDireccion: p[lado],
    contraFavorito, bajo30,
    bloquea: contraFavorito,
    motivo: contraFavorito
      ? `el premercado favorece el escenario ${favorito} (${max}%) y el trade es ${lado} (${p[lado]}%)`
      : favorito
        ? `a favor o neutral: favorito ${favorito} (${max}%), ${lado} ${p[lado]}%`
        : `empate en el favorito (${tope.join('/')} ${max}%): no frena`,
  };
}

// Parametros de salida para el registro de la ejecucion. Credito: tpPct = % del credito a capturar,
// slMult = multiplo del credito al que se recompra. Debito: % ganado / % perdido sobre el debito.
function parametrosSalidaV2(v2) {
  return {
    tpPct: v2.tpPct,
    slMult: +(1 + v2.slPct / 100).toFixed(4),
    debitTpPct: v2.tpPct,
    debitSlPct: v2.slPct,
  };
}

// Decision combinada. `vetoDir5` = resultado de evaluarVetoMuroSombra calculado con el TP de referencia.
function decidirV2({ v2, direction, prem, vetoDir5 }) {
  const premercado = evaluarFrenoPremercado(direction, prem);
  const dir5 = {
    vetaria: !!(vetoDir5 && vetoDir5.vetaria && direction === 'BEARISH'),
    tpReferenciaPct: v2.dir5TpReferenciaPct,
    nota: vetoDir5 ? (vetoDir5.nota || vetoDir5.motivo || null) : 'sin evaluar',
    aire: vetoDir5?.aire ?? null, puntosParaTP: vetoDir5?.puntosParaTP ?? null, muro: vetoDir5?.muro ?? null,
  };
  const motivos = [];
  if (v2.frenoPremercado && premercado.bloquea) motivos.push(`freno del premercado: ${premercado.motivo}`);
  if (v2.dir5 && dir5.vetaria) motivos.push(`DIR-5: ${dir5.nota || 'el TP queda del otro lado del Put Wall'}`);
  const bloquearia = motivos.length > 0;
  return {
    activo: v2.activo,
    bloquea: v2.activo && bloquearia,      // solo bloquea con el interruptor encendido
    bloquearia,                            // lo que habria hecho (sombra) con el interruptor apagado
    motivos,
    premercado,
    dir5,
    salida: parametrosSalidaV2(v2),
  };
}

module.exports = { V2_DEFAULTS, configV2, evaluarFrenoPremercado, parametrosSalidaV2, decidirV2 };
