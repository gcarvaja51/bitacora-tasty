'use strict';

// ── APAGONES DEL BROKER (2026-09-03) ───────────────────────────────────────
//
// El sandbox de Tradier no falla al azar: falla en BLOQUES. Medido hoy con 62
// sondas `preview=true` (que validan una orden sin colocarla), mandando la misma
// vertical cada 2 minutos:
//
//   mercado CERRADO  33 muestras   0 fallos    0%
//   mercado ABIERTO  29 muestras  17 fallos   59%
//
//   09:30 -> 09:32  caido
//   09:34 -> 09:44  anda
//   09:46 -> 10:24  caido  (38 minutos seguidos)
//   10:26 -> 10:36  anda
//
// Con el mercado cerrado acepto 33 de 33 la MISMA orden, con los mismos strikes,
// que despues rechazo 17 veces. No es nuestro payload: es el motor de ordenes de
// Tradier cayendose durante el horario de mercado.
//
// Las ordenes reales de produccion dan lo mismo o peor: 89% de rechazo el 1-sep
// (31 de 35) y 82% el 2-sep (18 de 22).
//
// QUE HACE ESTE MODULO: nada mas que DECIR que estamos en un apagon. No reintenta
// —un bloque de 38 min se come cualquier setup de 0DTE— ni cambia ninguna
// decision de trading. Convierte 20 rechazos sueltos, indistinguibles de 20 bugs
// distintos, en un hecho con nombre, principio, fin y cuantos setups costo.
//
// POR QUE NO SE REINTENTA MAS FUERTE: ver la nota de `_req` en src/tradier.js. Un
// POST /orders no es idempotente y el bloque dura mas que la validez del setup.
// El reintento sano sigue siendo el ciclo siguiente de la estrategia.

// ── Clasificar el fallo: del broker o nuestro ──────────────────────────────
//
// ESTA ES LA PARTE QUE HAY QUE CUIDAR. Si un bug nuestro se cuenta como apagon,
// el sistema se auto-absuelve y el bug queda invisible detras de un aviso de
// "Tradier esta caido" — exactamente al reves de para lo que existe esto.
//
// Un 5xx es del broker por definicion. Pero Tradier tambien devuelve fallos de su
// PROPIO servidor bajo un 400, con el cuerpo diciendolo:
//
//   400 {"message":"An error occurred while processing your request",
//        "error":"Unexpected server error"}
//
// Eso es una mina puesta, no una curiosidad: `_req` (src/tradier.js) no reintenta
// los 4xx —con razon, "la peticion esta mal, repetirla no la arregla"— asi que un
// fallo transitorio disfrazado de 400 se abandona en silencio y ademas se contaria
// como culpa nuestra. Por eso el cuerpo manda sobre el codigo.
//
// Los 4xx de verdad nuestros NO matchean y siguen contando como bug propio:
// "price must be greater than 0", "must use up to 2 decimal place(s)",
// "order not available to be canceled".
const SENAS_DE_FALLO_DEL_BROKER = [
  /unexpected server error/i,
  /an error occurred while processing your request/i,
  /an error occurred while communicating with the backend/i,
];

function esFalloDelBroker(mensaje) {
  const txt = String(mensaje || '');
  const m = txt.match(/Tradier API (\d{3})/);
  if (m && Number(m[1]) >= 500) return true;
  return SENAS_DE_FALLO_DEL_BROKER.some(re => re.test(txt));
}

// Dos fallos seguidos para declarar, no uno: un rechazo aislado pasa y no merece
// una notificacion. Los bloques medidos tienen 2, 6 y 15 muestras, asi que dos
// alcanza para engancharlos todos sin gritar por un hipo.
const FALLOS_PARA_DECLARAR = 2;

// Si entre dos fallos pasa mas que esto, no son el mismo apagon. Sin este corte,
// el ultimo fallo de un martes y el primero de un miercoles se encadenarian en un
// apagon de 18 horas. Generoso frente a los bloques medidos (el mas largo, 38
// min) porque las estrategias no evaluan a cadencia fija: la Reversion mira cada
// 60s pero el Iron Condor cada 5 min, y entre dos intentos suyos puede haber
// mucho hueco sin que el apagon se haya ido.
const VENTANA_MISMO_APAGON_MS = 20 * 60 * 1000;

let _racha = [];        // fallos consecutivos del broker: [{ts, familia}]
let _declarado = null;  // {desde, familias:Set} mientras dura el apagon

function _limpiarSiVencio(ahora) {
  if (!_racha.length) return;
  if (ahora - _racha[_racha.length - 1].ts > VENTANA_MISMO_APAGON_MS) {
    _racha = [];
    _declarado = null;
  }
}

// Un intento de orden que fallo. Devuelve que hacer con eso.
//   esDelBroker      false -> es un bug nuestro, tratarlo como siempre
//   recienDeclarado  true  -> primer momento del apagon: avisar UNA vez
//   enApagon         true  -> ya estabamos dentro, no volver a avisar
function registrarFallo({ familia, mensaje, ahora = Date.now() } = {}) {
  if (!esFalloDelBroker(mensaje)) {
    // Un fallo nuestro corta la racha: no puede sostener un apagon ajeno.
    _racha = [];
    _declarado = null;
    return { esDelBroker: false, enApagon: false, recienDeclarado: false, fallos: 0 };
  }
  _limpiarSiVencio(ahora);
  _racha.push({ ts: ahora, familia: familia || '?' });

  const recienDeclarado = !_declarado && _racha.length >= FALLOS_PARA_DECLARAR;
  if (recienDeclarado) {
    // El apagon empezo en el PRIMER fallo de la racha, no en el que lo declara —
    // si no, la duracion reportada saldria corta por definicion.
    _declarado = { desde: _racha[0].ts, familias: new Set() };
  }
  if (_declarado) _declarado.familias.add(familia || '?');

  return {
    esDelBroker: true,
    enApagon: !!_declarado,
    recienDeclarado,
    fallos: _racha.length,
    desde: _declarado ? new Date(_declarado.desde).toISOString() : null,
  };
}

// Una orden que SI entro. Cierra el apagon si habia uno.
//   seRecupero true -> primer exito despues de un apagon: avisar el fin
function registrarExito({ ahora = Date.now() } = {}) {
  const habia = _declarado;
  const fallos = _racha.length;
  _racha = [];
  _declarado = null;
  if (!habia) return { seRecupero: false };
  return {
    seRecupero: true,
    duracionMin: Math.max(1, Math.round((ahora - habia.desde) / 60000)),
    setupsPerdidos: fallos,
    familias: [...habia.familias],
    desde: new Date(habia.desde).toISOString(),
  };
}

// Para el endpoint y para la Torre de Control.
function estado({ ahora = Date.now() } = {}) {
  _limpiarSiVencio(ahora);
  if (!_declarado) {
    return { enApagon: false, fallosSeguidos: _racha.length };
  }
  return {
    enApagon: true,
    desde: new Date(_declarado.desde).toISOString(),
    duracionMin: Math.max(1, Math.round((ahora - _declarado.desde) / 60000)),
    setupsPerdidos: _racha.length,
    familias: [..._declarado.familias],
  };
}

function _reset() { _racha = []; _declarado = null; }

module.exports = {
  esFalloDelBroker, registrarFallo, registrarExito, estado, _reset,
  FALLOS_PARA_DECLARAR, VENTANA_MISMO_APAGON_MS,
};
