// Recuperacion de la pestaña de Sigma cuando la LECTURA falla (2026-10-02).
//
// Antes, un fallo de lectura no hacia nada: ensurePage() solo descarta la pestaña
// si un evaluate() trivial tira excepcion, y una pagina que "no devolvio el
// simbolo" sigue respondiendo a eso. El ciclo siguiente leia la MISMA pestaña
// trabada, y el siguiente, hasta que el vigilante mataba el proceso ~15-18 min
// despues. El 02-oct eso fue de 09:28 a 09:49 ET, en plena apertura, con el
// grafico de 15m mostrando los muros del premercado (GEX -3.9B cuando ya era
// +27B). Mismo patron el 30-sep (Runtime.callFunctionOn timed out, 27 min).
//
// Escalera, contando SOLO fallos de lectura de Sigma (un POST fallido al servidor
// no se arregla recargando Sigma):
//   fallo 1, 2  -> recargar la pestaña (barato, conserva el login)
//   fallo 3     -> descartar el navegador; el ciclo siguiente lo relanza limpio
//   y se repite: 4,5 recargar, 6 relanzar...
//
// No arregla un Sigma caido de verdad (el 02-oct un Chrome recien lanzado tambien
// tardo >90s en cargar): solo evita que una pestaña trabada alargue el corte.
//
// Aparte de index.js para poder probarlo. Ver recuperacion.test.mjs.

export const CADA_RELANZAR = 3;

export function crearRecuperador({ recargar, relanzar, log = console.warn, cadaRelanzar = CADA_RELANZAR }) {
  return async function recuperar(fallosSeguidos) {
    if (!(fallosSeguidos > 0)) return null;
    const accion = fallosSeguidos % cadaRelanzar === 0 ? 'relanzar' : 'recargar';
    try {
      if (accion === 'relanzar') await relanzar();
      else await recargar();
      log(`[recuperacion] fallo de lectura #${fallosSeguidos} -> ${accion} OK`);
      return accion;
    } catch (e) {
      // Que la recuperacion falle no debe tumbar el loop: el ciclo siguiente
      // vuelve a intentar leer y, si sigue mal, escala por la cuenta.
      log(`[recuperacion] fallo de lectura #${fallosSeguidos} -> ${accion} FALLO (${e.message})`);
      return `${accion}_fallo`;
    }
  };
}
