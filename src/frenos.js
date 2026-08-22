'use strict';

// ── EL CIRCUITO DIARIO, Y POR QUE AHORA VIVE APARTE (2026-08-22) ────────────
//
// Estaba inline dentro del ciclo de Reversion, y eso tenia dos consecuencias:
//
//   1. NO SE PODIA PROBAR. Un freno que nadie probo es un freno que no existe.
//      Para verificarlo habia que esperar a perder 3.5% en un dia real y mirar
//      si paraba — o sea, no verificarlo nunca.
//
//   2. SUMABA CON LA REGLA EQUIVOCADA. El drawdown del dia se calculaba con
//      `e.pnl`, los fills del sandbox de Tradier. Y la brecha contra la cadena
//      real no es ruido: es DIRECCIONAL. Medido del 17 al 21 de agosto, en los
//      4 stops la cadena real reporto MAS perdida que el broker, y en 7 de 8
//      objetivos mas ganancia. El sandbox siempre queda mas cerca de cero.
//
//      Para un circuito de perdida eso es lo peor posible: subestima la perdida
//      del dia y el freno dispara TARDE, o no dispara. Justo el sesgo que uno
//      no quiere en la unica proteccion que tiene.
//
// Ahora sale de resultadoOficial (src/pnl_oficial.js), igual que todo lo demas.
//
// ⚠️ LOS OTROS DOS "FRENOS" NO EXISTEN, y conviene tenerlo escrito acá:
//
//   riskPctPerTrade   La reversion usa `const contracts = 1` fijo desde el
//                     2026-07-27: ese porcentaje no sizea nada.
//   maxStopsPerDay    No hay una sola linea que lo lea desde esa misma fecha.
//
// Los dos siguen guardados en spx_config.json con valores que parecen
// protecciones (1 y 2). Una config que dice cosas que el robot no hace es peor
// que una incompleta: se toman decisiones creyendo que hay protecciones
// puestas. `frenosDeclarados()` los devuelve marcados como decorativos para que
// ninguna pantalla ni ningun agente los reporte como si frenaran.

const { resultadoOficial } = require('./pnl_oficial');

const MAX_DRAWDOWN_POR_DEFECTO = 3.5;

/**
 * Circuito diario: ¿hay que dejar de operar hoy?
 *
 * @param {object[]} ejecuciones  todas las ejecuciones (se filtran acá)
 * @param {object}   opts
 * @param {string}   opts.familia        familia a evaluar (p.ej. 'REVERSION')
 * @param {string}   opts.fecha          'YYYY-MM-DD'
 * @param {number}   opts.capital        equity de la cuenta
 * @param {number}   opts.maxDrawdownPct limite en % (positivo, p.ej. 3.5)
 * @returns {{bloquea:boolean, pnlHoy:number, drawdownPct:number, limitePct:number,
 *            trades:number, conLibro:number, sinLibro:number, motivo:string|null,
 *            fuente:string}}
 */
function evaluarCircuitoDiario(ejecuciones, opts = {}) {
  const familia = opts.familia || 'REVERSION';
  const fecha = opts.fecha;
  const limite = Number.isFinite(+opts.maxDrawdownPct) ? Math.abs(+opts.maxDrawdownPct)
                                                       : MAX_DRAWDOWN_POR_DEFECTO;

  // Sin capital no hay porcentaje que calcular. Antes esto caia a un 10000 por
  // defecto en silencio, y con la cuenta real en ~100k eso hacia que el freno
  // disparara con una decima parte de la perdida: paraba el dia entero y el
  // motivo que quedaba escrito era "drawdown -35%", que es mentira.
  //
  // Frenar es la falla segura y se conserva, pero DICIENDO por que. Un freno que
  // para por la razon equivocada manda a buscar el problema al lugar equivocado.
  // Lo encontro el simulacro; en vivo habria costado una sesion de diagnostico.
  const capital = Number(opts.capital);
  if (!Number.isFinite(capital) || capital <= 0) {
    return {
      bloquea: true, pnlHoy: null, drawdownPct: null, limitePct: limite,
      trades: 0, conLibro: 0, sinLibro: 0, fuente: 'sin_capital',
      motivo: 'Circuito diario: no se pudo determinar el capital de la cuenta — se frena por precaucion, no por perdida',
    };
  }

  const delDia = (ejecuciones || []).filter(e =>
    e && e.strategyFamily === familia && (e.closedAt || '').slice(0, 10) === fecha);

  let pnlHoy = 0, conLibro = 0, sinLibro = 0;
  for (const e of delDia) {
    const r = resultadoOficial(e);
    // Lo que no fue una operacion no cuenta para el circuito: una orden fantasma
    // del sandbox no consumio riesgo.
    if (r.fuente === 'no_operacion') continue;
    if (r.pendiente || r.pnl == null) continue;
    pnlHoy += r.pnl;
    if (r.esCadenaReal) conLibro++; else sinLibro++;
  }

  const drawdownPct = capital > 0 ? (pnlHoy / capital) * 100 : 0;
  const bloquea = drawdownPct <= -limite;

  return {
    bloquea,
    pnlHoy: +pnlHoy.toFixed(2),
    drawdownPct: +drawdownPct.toFixed(3),
    limitePct: limite,
    trades: conLibro + sinLibro,
    conLibro,
    sinLibro,
    // Si parte del dia se midio con el broker, el numero del circuito es hibrido
    // y hay que decirlo: es la diferencia entre un freno que sabe donde esta y
    // uno que cree saberlo.
    fuente: sinLibro === 0 ? 'cadena_real' : (conLibro === 0 ? 'broker' : 'mixta'),
    motivo: bloquea
      ? `Circuito diario: drawdown ${drawdownPct.toFixed(2)}% (limite -${limite}%)`
      : null,
  };
}

/**
 * Los frenos que la configuracion declara, separando los que de verdad frenan
 * de los que solo estan escritos. Existe para que ninguna pantalla ni ningun
 * agente pueda reportar como proteccion algo que no lo es.
 */
function frenosDeclarados(cfgReversion = {}) {
  return [
    {
      clave: 'maxDailyDrawdownPct',
      valor: cfgReversion.maxDailyDrawdownPct ?? MAX_DRAWDOWN_POR_DEFECTO,
      activo: true,
      donde: 'src/frenos.js — evaluarCircuitoDiario, llamado en el ciclo de Reversion',
      nota: null,
    },
    {
      clave: 'riskPctPerTrade',
      valor: cfgReversion.riskPctPerTrade ?? null,
      activo: false,
      donde: null,
      nota: 'DECORATIVO: la reversion usa contracts = 1 fijo desde el 2026-07-27, este porcentaje no sizea nada',
    },
    {
      clave: 'maxStopsPerDay',
      valor: cfgReversion.maxStopsPerDay ?? null,
      activo: false,
      donde: null,
      nota: 'DECORATIVO: no hay una sola linea que lo lea desde el 2026-07-27',
    },
  ];
}

module.exports = { evaluarCircuitoDiario, frenosDeclarados, MAX_DRAWDOWN_POR_DEFECTO };
