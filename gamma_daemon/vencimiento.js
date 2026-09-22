// Lectura de Sigma exigiendo el vencimiento de HOY (2026-09-22).
//
// Sigma elige el chip 0DTE solo al cargar la pagina, y la pestaña del daemon vive
// dias: el 17 y el 22-sep amanecio en el vencimiento del dia anterior. Sin
// recargar, el premercado se quedaba sin muros de hoy y la fase de sesion
// empujaba al servidor y a TradingView los de una cadena vencida como frescos.
//
// Aparte de index.js (que arranca el loop al importarse) para poder probarlo:
// las dependencias entran por parametro. Ver vencimiento.test.mjs.

export const RECARGA_MIN_MS = 5 * 60 * 1000;

// Devuelve una funcion leer() con su propio reloj de recargas. Una recarga cada
// RECARGA_MIN_MS como mucho: a las 08:15 la terminal puede no haber cambiado de
// dia todavia, y recargar cada 30s no la apura.
export function crearLectorDeHoy({ readLevels, recargar, fechaET, ahora = () => Date.now(), log = console.warn }) {
  let ultimaRecarga = -Infinity;
  return async function leer() {
    const levels = await readLevels();
    const hoy = fechaET();
    if (!levels.expiry || levels.expiry === hoy) return levels;
    if (ahora() - ultimaRecarga < RECARGA_MIN_MS) return levels;
    ultimaRecarga = ahora();
    log(`[sigma] el panel esta en el vencimiento ${levels.expiry} (hoy ${hoy}) -- recargando el terminal`);
    await recargar();
    return readLevels();
  };
}

// El cerrojo de la fase de sesion: si ni recargando aparece la cadena de hoy, no
// se empuja nada. Un expiry null (el rotulo no se pudo leer) NO bloquea: es el
// comportamiento de siempre y bloquear ahi dejaria al servidor sin precio por un
// cambio cosmetico de Sigma.
export function exigirVencimientoDeHoy(levels, hoy) {
  if (levels.expiry && levels.expiry !== hoy) {
    throw new Error(`Sigma sigue en la cadena del ${levels.expiry} (hoy ${hoy}) -- no se empujan muros de un vencimiento que no es el de hoy`);
  }
}
