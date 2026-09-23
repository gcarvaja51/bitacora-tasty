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

// ── Esperar a que haya dato de HOY (2026-09-23) ──────────────────────────────
//
// POR QUE. Una sola lectura de status.json a las 08:30 era una apuesta: del 11 al
// 22-sep el colector encontro el dato RANCIO 4 de 9 dias (11, 14, 17 y 22-sep), y
// en esos dias el informe salio sin muros de hoy. Las causas del lado del daemon son
// pasajeras -- Sigma todavia en la cadena de ayer, la pagina que no termino de cargar
// (14-sep), el daemon caido y relanzado por el vigilante a los 10 min (23-sep) -- y
// el daemon reintenta cada 30s. O sea que muchas veces el dato bueno llega pocos
// minutos DESPUES de que el colector ya se fue. Esperar un rato cuesta poco (corre en
// paralelo con TradingView) y convierte un RANCIO en un OK.
//
// Todo entra por parametro (leer, reloj, dormir) para poder probarlo sin disco ni
// esperas reales. Devuelve el ultimo elegido, con `esperaMs` e `intentos`; si al
// final sigue rancio lo devuelve igual (rancio:true) y el que llama decide.
export async function esperarSigmaDeHoy({
  leerStatus, ahora, dormir, maxAntiguedadMin, esperaMs, pasoMs,
}) {
  const inicio = ahora();
  let intentos = 0;
  let ultimo = null;
  let ultimoError = null;
  for (;;) {
    intentos += 1;
    try {
      const status = leerStatus();
      ultimo = { ...elegirSigma(status, ahora(), maxAntiguedadMin), status };
      ultimoError = null;
      if (!ultimo.rancio) break;
    } catch (e) {
      // status.json a medio escribir (el daemon lo reescribe cada 30s) o ausente.
      ultimoError = e;
    }
    if (ahora() - inicio + pasoMs > esperaMs) break;
    await dormir(pasoMs);
  }
  if (!ultimo) throw ultimoError || new Error('sin lectura de status.json');
  return { ...ultimo, esperaMs: ahora() - inicio, intentos };
}

// Por que no hay dato de hoy, en una linea, para que el log diga la CAUSA y no solo
// el sintoma. Lee lo que el propio daemon deja en status.json.
export function diagnosticoDaemon(status, ahoraMs) {
  const partes = [];
  const ciclo = status?.lastCycleAt ? Date.parse(status.lastCycleAt) : NaN;
  if (!Number.isFinite(ciclo)) {
    partes.push('el daemon no registra ningun ciclo');
  } else {
    const min = Math.round((ahoraMs - ciclo) / 60000);
    partes.push(min > 3
      ? `el daemon NO cicla hace ${min} min (caido o colgado)`
      : `el daemon cicla (ultimo hace ${min} min)`);
  }
  const err = status?.premercadoError;
  if (err?.mensaje) partes.push(`ultimo error de premercado (${err.en}): ${err.mensaje}`);
  return partes.join('; ');
}
