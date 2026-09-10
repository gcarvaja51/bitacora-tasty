// Que lectura de Sigma usa el informe de premercado, y si vale como "de hoy".
//
// Vive aparte de collect.js por una razon concreta: collect.js llama a main() al
// importarse, asi que su logica no se puede probar sin lanzar el recolector entero
// contra TradingView. Esta era justo la parte que llevaba semanas equivocandose en
// silencio (ver abajo), y la que mas falta hacia poder probar en frio.
//
// EL FALLO QUE ORIGINA ESTE MODULO (2026-09-09). status.json del gamma_daemon tiene
// dos sitios donde puede haber niveles:
//
//   - `premercado`  -> la fase de solo lectura que el daemon corre entre 08:15 y
//     09:00 ET, hecha justo para el recolector de las 08:30.
//   - `lastLevels`  -> el ultimo ciclo de OPERACION, ventana 09:00-16:05 ET. A las
//     08:30 esto es SIEMPRE el cierre de la sesion anterior.
//
// El colector leia `lastLevels` a secas y lo anunciaba como "[sigma] OK". Resultado:
// el informe se escribio durante semanas con los muros de ayer presentados como los
// de hoy, y como decia OK nadie lo miro. El 09-09 la diferencia era Put Wall 7675
// (ayer) contra 7630 (real), Call Wall 7680 contra 7700, y la cadena de un
// vencimiento ya expirado.

// Devuelve { levels, asOf, fuente, antiguedadMin, rancio } o lanza si no hay nada.
// `ahoraMs` y `maxAntiguedadMin` entran por parametro --y no se leen de Date.now()
// ni de una constante-- precisamente para que las pruebas puedan fijar el reloj.
export function elegirSigma(status, ahoraMs, maxAntiguedadMin) {
  const candidatos = [];
  if (status?.premercado?.levels) {
    candidatos.push({
      levels: status.premercado.levels,
      asOf: status.premercado.leidoEn,
      fuente: 'premercado',
    });
  }
  if (status?.lastLevels) {
    candidatos.push({
      levels: status.lastLevels,
      asOf: status.lastSuccessAt,
      fuente: 'ultimo_ciclo_operacion',
    });
  }
  if (candidatos.length === 0) {
    throw new Error('status.json de gamma_daemon no tiene ni premercado ni lastLevels todavia');
  }

  // Gana el sello mas reciente, no la clave preferida. Si un dia el daemon lleva
  // rato operando y la fase de premercado no corrio, `lastLevels` es lo bueno; y al
  // reves a las 08:30. Un asOf ausente cuenta como el principio de los tiempos: sin
  // sello no hay forma de defender que el dato sea de hoy.
  const orden = candidatos.sort((a, b) => new Date(b.asOf || 0) - new Date(a.asOf || 0));
  const elegido = orden[0];

  const antiguedadMin = elegido.asOf
    ? Math.round((ahoraMs - new Date(elegido.asOf).getTime()) / 60000)
    : null;

  return {
    ...elegido,
    antiguedadMin,
    rancio: antiguedadMin == null || antiguedadMin > maxAntiguedadMin,
  };
}
