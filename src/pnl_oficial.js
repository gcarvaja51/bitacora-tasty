'use strict';

// ── LA ÚNICA RESPUESTA A "¿CUÁNTO GANÓ ESTE TRADE?" (2026-08-21) ─────────────
//
// Por que existe: hasta hoy esa pregunta tenia CINCO implementaciones distintas
// —metrics_tradier.js, /api/spx/version-stats, /api/spx/shadow-trail, el skill
// del informe de trade y scripts/control_cambios.py— y cada vez que se escribia
// una pantalla nueva se inventaba la sexta. metrics_tradier.js la resolvio bien
// el 20-ago; nadie mas se entero.
//
// El resultado eran numeros que se contradecian entre si. Medido sobre los 12
// trades que ya tenian libro propio: CUATRO cambiaban de signo segun quien los
// mirara. Un SL que Tradier anotaba como +$10 era, contra la cadena real, una
// perdida de $264.
//
// La regla, que no se discute: EL DINERO SALE DE LA CADENA REAL DE TASTYTRADE,
// nunca de los fills de Tradier. El sandbox cotiza y llena contra un libro de
// ~15 min de atraso: su fill no describe el trade que el algoritmo hizo, sino el
// que habria hecho alguien operando con un cuarto de hora de retraso.
//
// Este modulo es la unica puerta. Nadie mas lee `ex.pnl` directamente salvo para
// auditar la diferencia. Asi la regla deja de ser una convencion (que se olvida)
// y pasa a ser una dependencia (que no se puede saltar sin darse cuenta).

// ── Cortes historicos ───────────────────────────────────────────────────────
//
// 2026-08-03  El /gainloss viejo asignaba mal las patas cuando varios trades
//             compartian strikes el mismo dia. 39 de 62 direccionales previos
//             tienen el P&L mal calculado; al menos 5 registran una perdida
//             MAYOR al debito pagado, imposible en un spread de debito.
//
// 2026-08-16  Nace el libro propio (marcarPaper / cerrarLibroPaper en server.js).
//             Antes de esta fecha NO existe medicion contra la cadena real: no
//             hay dato que ponerles, y borrar el historial seria peor.
const CORTE_GAINLOSS   = '2026-08-03';
const CORTE_LIBRO      = '2026-08-16';

// Fuentes que NO describen una operacion real. No es que el numero sea dudoso:
// es que no hubo trade. Se excluyen siempre, de cualquier agregado.
const NO_ES_OPERACION = new Set(['sandbox_orden_fantasma']);
const MOTIVOS_NO_OPERACION = new Set(['SANDBOX_GLITCH_SIN_POSICION']);

/**
 * Resultado oficial de una ejecucion.
 *
 * @returns {{
 *   pnl: number|null,          resultado oficial en dolares (bruto, sin comision)
 *   neto: number|null,         el mismo, ya descontada la comision asumida
 *   fuente: string|null,       cadena_real | broker | broker_dudoso | no_operacion
 *   esCadenaReal: boolean,     true solo si salio del libro propio
 *   comparable: boolean,       apto para promediar/agregar con otros comparables
 *   pendiente: boolean,        todavia no hay resultado (abierta o sin asentar)
 *   pnlBroker: number|null,    el numero del sandbox, conservado para auditar
 *   diferencia: number|null,   cadena real - broker, en dolares
 *   nota: string|null          por que no es comparable, cuando aplica
 * }}
 */
function resultadoOficial(ex) {
  const vacio = {
    pnl: null, neto: null, fuente: null, esCadenaReal: false,
    comparable: false, pendiente: true, pnlBroker: null, diferencia: null, nota: null,
  };
  if (!ex) return vacio;

  const pnlBroker = typeof ex.pnl === 'number' ? ex.pnl : null;
  const fecha     = (ex.closedAt || ex.filledAt || ex.timestamp || '').slice(0, 10);

  // 1. Lo que no fue una operacion no entra a ningun lado, aunque traiga un numero.
  if (NO_ES_OPERACION.has(ex.pnlSource) || MOTIVOS_NO_OPERACION.has(ex.closeReason)) {
    return { ...vacio, pendiente: false, fuente: 'no_operacion', pnlBroker,
             nota: 'orden fantasma del sandbox: nunca hubo posicion' };
  }

  // 2. El libro propio manda siempre que exista y sea confiable.
  const libro = (ex.paperPnl && ex.paperPnl.confiable) ? ex.paperPnl : null;
  if (libro && typeof libro.bruto === 'number') {
    return {
      pnl:  +libro.bruto.toFixed(2),
      neto: typeof libro.neto === 'number' ? +libro.neto.toFixed(2) : null,
      fuente: 'cadena_real',
      esCadenaReal: true,
      comparable: true,
      pendiente: false,
      pnlBroker,
      diferencia: pnlBroker == null ? null : +(libro.bruto - pnlBroker).toFixed(2),
      nota: null,
    };
  }

  // 3. Sin libro, queda el numero del broker — util para no perder el historial,
  //    pero NO comparable con lo medido contra la cadena real. Mezclarlos es lo
  //    que producia estadisticas que no significaban nada.
  if (pnlBroker == null) {
    return { ...vacio, pnlBroker: null,
             nota: fecha && fecha >= CORTE_LIBRO ? 'sin libro y sin numero del broker' : null };
  }

  const dudoso = ex.pnlSource === 'gainloss' || (fecha && fecha < CORTE_GAINLOSS);
  return {
    pnl: pnlBroker,
    neto: null,
    fuente: dudoso ? 'broker_dudoso' : 'broker',
    esCadenaReal: false,
    comparable: false,
    pendiente: false,
    pnlBroker,
    diferencia: null,
    nota: dudoso
      ? `medido con el /gainloss viejo o anterior al ${CORTE_GAINLOSS}: patas mal asignadas`
      : `medido con los fills de Tradier: anterior al libro propio (${CORTE_LIBRO})`,
  };
}

/**
 * Agrega una lista de ejecuciones aplicando la regla. Devuelve los comparables y
 * los de legado por separado — NUNCA sumados, que es de donde salian los promedios
 * sin sentido.
 *
 * `muestraSuficiente` mira solo los comparables: con menos de 30 trades cerrados la
 * diferencia entre 60% y 80% de acierto no se distingue del azar.
 */
const MUESTRA_MINIMA = 30;

function agregar(ejecuciones) {
  const comp = [], legado = [];
  let excluidas = 0;

  for (const ex of ejecuciones || []) {
    const r = resultadoOficial(ex);
    if (r.fuente === 'no_operacion') { excluidas++; continue; }
    if (r.pendiente || r.pnl == null) continue;
    (r.comparable ? comp : legado).push({ ex, r });
  }

  const resumen = filas => {
    if (!filas.length) return { trades: 0, ganadores: 0, winRate: null, pnl: 0, pnlPorTrade: null, gananciaMedia: null, perdidaMedia: null };
    const gan = filas.filter(f => f.r.pnl > 0);
    const per = filas.filter(f => f.r.pnl <= 0);
    const suma = filas.reduce((a, f) => a + f.r.pnl, 0);
    return {
      trades: filas.length,
      ganadores: gan.length,
      winRate: +(gan.length / filas.length * 100).toFixed(1),
      pnl: +suma.toFixed(2),
      pnlPorTrade: +(suma / filas.length).toFixed(2),
      gananciaMedia: gan.length ? +(gan.reduce((a, f) => a + f.r.pnl, 0) / gan.length).toFixed(2) : null,
      // La variable que hay que vigilar en estructuras de credito: el win rate
      // engaña, lo que mata es el tamaño de la cola.
      perdidaMedia:  per.length ? +(per.reduce((a, f) => a + f.r.pnl, 0) / per.length).toFixed(2) : null,
    };
  };

  return {
    comparable: { ...resumen(comp), muestraSuficiente: comp.length >= MUESTRA_MINIMA, faltan: Math.max(0, MUESTRA_MINIMA - comp.length) },
    legado:     { ...resumen(legado), nota: 'medido con los fills de Tradier — NO comparable con lo de arriba' },
    excluidas,
  };
}

module.exports = { resultadoOficial, agregar, MUESTRA_MINIMA, CORTE_GAINLOSS, CORTE_LIBRO };
