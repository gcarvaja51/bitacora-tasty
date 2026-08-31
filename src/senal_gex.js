/**
 * SEÑAL DE MURO DOMINANTE (GEX)
 * =============================
 *
 * Regla de Guillermo (2026-08-25), en sus palabras:
 *   "si por mas de 30 minutos o de 1 hora el call wall / put wall esta en un
 *    mismo strike y ese valor de call/puts en ese periodo tiene una relacion de
 *    2x o algo cercano, es un gran momento para disparar un trade iron
 *    butterfly, esto acompanado de macd y de emas"
 *
 * Tres condiciones, y las tres tienen que darse a la vez:
 *
 *   1. PERSISTENCIA -- el muro lleva N minutos clavado en el mismo strike.
 *      Medido el 25-ago sobre el historico real del daemon: el lunes la primera
 *      hora fue ruido puro (el call wall salto entre 7710/7675/7650 en tramos de
 *      1 a 10 min) y desde las 11:29 se clavo 116 min seguidos. El martes el
 *      call wall aguanto 61 min desde la apertura. Este filtro es justo lo que
 *      distingue esas dos situaciones.
 *
 *   2. DOMINANCIA -- ese strike tiene >= 2x el GEX del siguiente del mismo lado.
 *      Es "la carga de dinero": el 25-ago el 7665 tenia 4,06 B en calls contra
 *      el segundo strike, y mas de 2x el strike tipico de la cadena.
 *
 *   3. COMPRESION -- el corredor call wall / put wall es estrecho. Un corredor
 *      ancho significa que el mercado todavia no ha decidido donde fijar.
 *
 * A eso se le suma el gate de MACD/EMAs (`senales_horizontal.js`), que se
 * evalua aparte porque mide otra cosa: la estructura del PRECIO, no la de las
 * opciones.
 *
 * ⚠️ SIN VALIDAR TODAVIA. Esta regla NO se ha podido backtestear: el historico
 * de muros del daemon (7192 lecturas desde el 21-jul) guarda el STRIKE del muro
 * pero nunca su MAGNITUD, asi que la condicion 2 era imposible de medir hacia
 * atras. `gex_perfil.cjs` empezo a guardarla el 25-ago. Hasta que haya unas
 * semanas de muestra, esto es una hipotesis instrumentada, no un resultado.
 * No subir tamaño ni bajar filtros antes de tener esos datos.
 */

'use strict';

const DEFAULTS = {
  persistenciaMin: 30,       // minutos que el muro debe llevar en el mismo strike
  dominanciaMin: 2.0,        // "regla del 2x"
  dominanciaCercana: 1.8,    // "o algo cercano a ese valor" -- se avisa, no dispara
  corredorMaxPts: 45,        // compresion: ancho maximo call wall - put wall
  ladoRequerido: 'cualquiera', // 'call' | 'put' | 'cualquiera' | 'ambos'
};

/**
 * Cuantos minutos lleva `campo` sin cambiar de strike, mirando hacia atras.
 * `capturas` viene ordenado de mas antigua a mas reciente.
 */
function minutosEstable(capturas, campo) {
  if (!capturas.length) return 0;
  const ult = capturas[capturas.length - 1];
  const valor = ult[campo];
  let desde = new Date(ult.ts);
  for (let i = capturas.length - 2; i >= 0; i--) {
    if (capturas[i][campo] !== valor) break;
    desde = new Date(capturas[i].ts);
  }
  return (new Date(ult.ts) - desde) / 60000;
}

/**
 * Evalua la señal sobre una ventana de capturas de `gex_perfil.cjs`.
 * @param {object[]} capturas  ordenadas por ts ascendente
 * @param {object} cfg
 */
function evaluar(capturas, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  if (!capturas || capturas.length < 2) {
    return { ok: false, motivo: `hacen falta al menos 2 capturas, hay ${capturas ? capturas.length : 0}` };
  }
  const ult = capturas[capturas.length - 1];

  const minCall = minutosEstable(capturas, 'callWall');
  const minPut = minutosEstable(capturas, 'putWall');
  const domCall = ult.callWall2x;
  const domPut = ult.putWall2x;

  const callOk = minCall >= c.persistenciaMin && domCall != null && domCall >= c.dominanciaMin;
  const putOk = minPut >= c.persistenciaMin && domPut != null && domPut >= c.dominanciaMin;

  let ladoOk, lado;
  if (c.ladoRequerido === 'call') { ladoOk = callOk; lado = 'call'; }
  else if (c.ladoRequerido === 'put') { ladoOk = putOk; lado = 'put'; }
  else if (c.ladoRequerido === 'ambos') { ladoOk = callOk && putOk; lado = 'ambos'; }
  else {
    ladoOk = callOk || putOk;
    // Con los dos validos manda el de MAS dominancia: es donde esta el dinero.
    lado = (callOk && putOk) ? ((domCall >= domPut) ? 'call' : 'put') : (callOk ? 'call' : 'put');
  }

  const corredor = Math.abs(ult.callWall - ult.putWall);
  const comprimido = corredor <= c.corredorMaxPts;

  // El strike a operar: el muro del lado que disparo.
  const strike = lado === 'put' ? ult.putWall : ult.callWall;
  const dominancia = lado === 'put' ? domPut : domCall;
  const minutos = lado === 'put' ? minPut : minCall;

  const fallos = [];
  if (!ladoOk) {
    const cerca = (domCall != null && domCall >= c.dominanciaCercana)
               || (domPut != null && domPut >= c.dominanciaCercana);
    fallos.push(`sin muro dominante estable (call ${minCall.toFixed(0)}min ${domCall ?? '?'}x, ` +
                `put ${minPut.toFixed(0)}min ${domPut ?? '?'}x; se piden ` +
                `${c.persistenciaMin}min y ${c.dominanciaMin}x)` +
                (cerca ? ' -- CERCA del umbral' : ''));
  }
  if (!comprimido) {
    fallos.push(`corredor ${corredor} pts es mayor que ${c.corredorMaxPts}: sin compresion`);
  }

  return {
    ok: ladoOk && comprimido,
    lado, strike, dominancia,
    minutosEstable: +minutos.toFixed(0),
    corredor,
    callWall: ult.callWall, callWall2x: domCall, minCall: +minCall.toFixed(0),
    putWall: ult.putWall, putWall2x: domPut, minPut: +minPut.toFixed(0),
    spot: ult.spot,
    motivo: fallos.length ? fallos.join('; ')
      : `muro ${lado} en ${strike} estable ${minutos.toFixed(0)} min con ${dominancia}x; ` +
        `corredor ${corredor} pts`,
  };
}

module.exports = { evaluar, minutosEstable, DEFAULTS };
