// Informe diario de los cuatro libros del Demo Tasty (fase 2, paso 3 — 2026-11-16).
// Guillermo: "hagamos un informe automatico diario con las ejecuciones de cada uno de los 4 grupos para saber que
// trades se hicieron y el resultado del dia".
//
// Función PURA: recibe lo que cada libro ya publica y devuelve el día armado, una sección por libro. No calcula
// precios ni toca ningún libro. Los saldos NUNCA se suman entre libros. El día es la fecha de Nueva York.

const fechaET = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
};
const r2 = (n) => +(+n).toFixed(2);
const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null);
const NOMBRE_FAMILIA = { TENDENCIA: 'Direccional', MEDIODIA: 'Mediodía', NEUTRAL: 'Iron Condor', REVERSION: 'Reversión' };

// "SPXW261117P07400000" → "7400P"
function pataCorta(sym) {
  const m = /([CP])(\d{8})$/.exec(String(sym || ''));
  return m ? `${+(Number(m[2]) / 1000)}${m[1]}` : String(sym || '');
}
function textoPatas(patas) {
  if (!Array.isArray(patas) || !patas.length) return '';
  return patas.map((p) => `${p.q > 0 ? '+' : ''}${p.q} ${pataCorta(p.sym)}`).join(' / ');
}

// Fila común a los cuatro libros.
function fila(x) {
  return { grupo: x.grupo || '', descripcion: x.descripcion || '', abiertaAt: x.abiertaAt || null, cerradaAt: x.cerradaAt || null,
    entrada: num(x.entrada), salida: num(x.salida), comisiones: num(x.comisiones), neto: num(x.neto), latente: num(x.latente),
    estado: x.estado, motivo: x.motivo || null, nota: x.nota || null, extra: x.extra || null };
}

function seccion(libro, fecha, filas, { capital = 10000, saldo = null, pnlLibroHoy = null, esHoy = true, avisos = [] } = {}) {
  const cerradosHoy = filas.filter((f) => f.estado === 'cerrado' && fechaET(f.cerradaAt) === fecha);
  const abiertosHoy = filas.filter((f) => f.estado !== 'no_abierto' && fechaET(f.abiertaAt) === fecha);
  const abiertas = filas.filter((f) => f.estado === 'abierto');
  const noEntraron = filas.filter((f) => f.estado === 'no_abierto' && fechaET(f.abiertaAt || f.cerradaAt) === fecha);
  const pendientes = cerradosHoy.filter((f) => f.neto == null);
  const resultado = r2(cerradosHoy.reduce((a, f) => a + (f.neto || 0), 0));
  const av = [...avisos];
  if (pendientes.length) av.push(`${pendientes.length} cierre(s) de hoy todavía sin resultado asentado: no cuentan en el resultado del día`);
  // Si el libro publica su propio número del día y no coincide con la suma de los trades, se dice (no se esconde).
  if (esHoy && pnlLibroHoy != null && Math.abs(pnlLibroHoy - resultado) > 0.01) {
    av.push(`El libro reporta $${r2(pnlLibroHoy)} para hoy y la suma de los trades cerrados da $${resultado} (puede haber cierres parciales)`);
  }
  // movimientos del día: todo lo que abrió o cerró hoy, sin repetir
  const movimientos = filas.filter((f) => f.estado !== 'no_abierto' && (fechaET(f.abiertaAt) === fecha || fechaET(f.cerradaAt) === fecha))
    .sort((a, b) => String(a.abiertaAt).localeCompare(String(b.abiertaAt)));
  return { libro, capital, saldo, resultadoHoy: resultado, abiertosHoy: abiertosHoy.length, cerradosHoy: cerradosHoy.length,
    ganadosHoy: cerradosHoy.filter((f) => (f.neto || 0) > 0).length, abiertasAhora: abiertas.length,
    latente: abiertas.some((f) => f.latente != null) ? r2(abiertas.reduce((a, f) => a + (f.latente || 0), 0)) : null,
    movimientos, abiertas, noEntraron, avisos: av };
}

// ── Entradas Manuales: clicReal.demo() ──
function filasManual(demo) {
  return (demo?.lista || []).map((x) => fila({
    grupo: x.sesion && x.sesion !== 'regular' ? `Manual (${x.sesion})` : 'Manual',
    descripcion: `${x.nombre || x.estructura || ''} ${x.strikes || ''}${x.contratos > 1 ? ' x' + x.contratos : ''}`.trim(),
    abiertaAt: x.abiertaEn, cerradaAt: x.cerradaEn, entrada: x.entrada, salida: x.salida, comisiones: x.comisiones, neto: x.pnlNeto,
    estado: x.estado === 'cerrada' ? 'cerrado' : (x.estado === 'abierta' || x.estado === 'cerrando') ? 'abierto' : 'no_abierto',
    motivo: x.motivo,
  }));
}

// ── Señales Sigma: libroSenales.resumen() ──
function filasSenales(s) {
  const una = (t) => {
    const fees = (t.entrada?.fees || 0) + (t.salida?.fees || 0);
    const entro = !!t.entrada;
    return fila({
      grupo: t.profe || '', descripcion: `${t.activo || ''} ${t.estrategia || ''}`.trim(), extra: textoPatas(t.patas),
      abiertaAt: t.entrada?.at || t.mensajeAt, cerradaAt: t.cerradaAt, entrada: t.entrada?.precio, salida: t.salida?.precio,
      comisiones: entro ? r2(fees) : null, neto: t.estado === 'cerrada' ? t.pnlRealizado : null, latente: t.latenteCruzando,
      estado: t.estado === 'cerrada' ? 'cerrado' : (entro && !t.cerradaAt) ? 'abierto' : 'no_abierto',
      motivo: t.motivo, nota: t.antesDeLaRegla ? 'importada del demo anterior' : null,
    });
  };
  return [...(s?.abiertas || []), ...(s?.pendientes || []), ...(s?.historial || [])].map(una);
}

// ── Robot SPX: ejecuciones con broker tasty_demo + gemelos del espejo ──
function filasRobot(ejecuciones, gemelos, pnlDe) {
  const out = [];
  for (const e of (ejecuciones || []).filter((x) => x.broker === 'tasty_demo' && !x.espejo)) {
    const fees = (Number(e.feesApertura) || 0) + (Number(e.feesCierre) || 0);
    const bruto = e.status === 'closed' ? pnlDe(e) : null;
    const st = e.strikes || {};
    out.push(fila({
      grupo: NOMBRE_FAMILIA[e.strategyFamily || 'TENDENCIA'] || e.strategyFamily,
      descripcion: `${String(e.strategy || '').replace(/_/g, ' ')} ${st.longStrike ?? ''}/${st.shortStrike ?? ''}${e.contracts > 1 ? ' x' + e.contracts : ''}`.trim(),
      abiertaAt: e.filledAt || e.timestamp, cerradaAt: e.closedAt, entrada: e.entryFillPrice, salida: e.paperExit?.neto,
      comisiones: r2(fees), neto: typeof bruto === 'number' ? r2(bruto - fees) : null,
      estado: e.status === 'closed' ? 'cerrado' : e.status === 'filled' ? 'abierto' : 'no_abierto', motivo: e.closeReason,
    }));
  }
  for (const g of gemelos || []) {
    const fees = (Number(g.feesApertura) || 0) + (Number(g.feesCierre) || 0);
    out.push(fila({
      grupo: (NOMBRE_FAMILIA[g.strategyFamily] || g.strategyFamily) + ' (espejo)',
      descripcion: textoPatas(g.patas) || String(g.strategy || ''),
      abiertaAt: g.filledAt || g.timestamp, cerradaAt: g.closedAt, entrada: g.entrada?.precio, salida: g.salida?.precio,
      comisiones: r2(fees), neto: g.status === 'closed' ? g.pnlNeto : null,
      estado: g.status === 'closed' ? 'cerrado' : g.status === 'filled' ? 'abierto' : 'no_abierto',
      motivo: g.status === 'no_abierta' ? g.motivo : g.closeReason,
      nota: g.salidaDeTradier ? 'asentado con el resultado de Tradier (sin precio para cerrar)' : null,
      extra: { tradierPnl: num(g.tradierPnl), tradierEntrada: num(g.tradierEntrada), retrasoSeg: num(g.retrasoSeg), salidaDeTradier: !!g.salidaDeTradier },
    }));
  }
  return out;
}

// ── Iron Balls: las dos fuentes (Pipe y Alejandro), sin las pruebas ──
function filasIronBalls(pipe, ale) {
  const una = (fuente) => (x) => fila({
    grupo: x.fuenteSenal || fuente,
    descripcion: `${x.nombre || x.estrategia || ''} ${x.corto ?? ''}/${x.largo ?? ''}${x.contratos > 1 ? ' x' + x.contratos : ''}`.trim(),
    abiertaAt: x.abiertaEn || x.mensajeAt, cerradaAt: x.cerradaEn, entrada: x.precioEntrada, salida: x.precioSalida,
    comisiones: r2((x.feesApertura || 0) + (x.feesCierre || 0)), neto: x.estado === 'cerrada' ? x.pnlUsd : null,
    estado: x.estado === 'cerrada' ? 'cerrado' : x.estado === 'abierta' ? 'abierto' : 'no_abierto',
    motivo: x.motivoCierre || x.motivo,
  });
  const limpio = (r) => (r?.lista || []).filter((x) => !x.prueba);
  return [...limpio(pipe).map(una('Pipe')), ...limpio(ale).map(una('Alejandro'))];
}

/**
 * @param {object} d
 *   fecha 'AAAA-MM-DD' (ET), hoy (ET), diaDeMercado (bool), manual, senales, ejecuciones, gemelos, pnlDe(ex),
 *   robot (cuenta del libro), espejo (resumen), ironPipe, ironAle, ironLibro, errores {libro: mensaje}
 */
function armarDia(d) {
  const fecha = d.fecha, esHoy = !d.hoy || d.hoy === fecha;
  const err = d.errores || {};
  const con = (libro, f) => { try { return f(); } catch (e) { return { libro, error: e.message }; } };
  const libros = [];

  libros.push(err['Entradas Manuales'] ? { libro: 'Entradas Manuales', error: err['Entradas Manuales'] } : con('Entradas Manuales', () => {
    const m = d.manual || {}, av = [];
    if (esHoy && m.metaDia?.superada) av.push(`Meta del día superada: $${m.metaDia.pnlHoy} cerrados (meta $${m.metaDia.meta}). La ventana pregunta antes de cada entrada nueva`);
    const s = seccion('Entradas Manuales', fecha, filasManual(m), { capital: m.capital, saldo: m.saldo, pnlLibroHoy: m.metaDia?.pnlHoy, esHoy, avisos: av });
    if (esHoy && num(m.pnlAbierto) != null && s.abiertasAhora) s.latente = r2(m.pnlAbierto);
    return s;
  }));

  libros.push(err['Señales Sigma'] ? { libro: 'Señales Sigma', error: err['Señales Sigma'] } : con('Señales Sigma', () => {
    const s = d.senales || {}, av = [];
    const al = (s.alertas || []).filter((a) => fechaET(a.at || a.mensajeAt) === fecha);
    if (al.length) av.push(`${al.length} mensaje(s) del canal quedaron para revisión a mano`);
    return seccion('Señales Sigma', fecha, filasSenales(s), { capital: s.capital, saldo: s.saldo, pnlLibroHoy: s.pnlHoy, esHoy, avisos: av });
  }));

  libros.push(err['Robot SPX'] ? { libro: 'Robot SPX', error: err['Robot SPX'] } : con('Robot SPX', () => {
    const r = d.robot || {}, av = [];
    if (esHoy && r.metaAlcanzada) av.push(`Meta del día alcanzada: $${r.pnlHoy} cerrados (meta $${r.metaDia}). No abre más trades hasta mañana; lo abierto sigue su curso`);
    const filas = filasRobot(d.ejecuciones, d.gemelos, d.pnlDe || (() => null));
    const s = seccion('Robot SPX', fecha, filas, { capital: r.capital, saldo: r.saldo, pnlLibroHoy: r.pnlHoy, esHoy, avisos: av });
    // por estrategia, solo el día
    const pe = {};
    for (const f of s.movimientos) {
      const k = f.grupo.replace(' (espejo)', '');
      const o = pe[k] = pe[k] || { estrategia: k, abiertos: 0, cerrados: 0, ganados: 0, neto: 0 };
      if (fechaET(f.abiertaAt) === fecha) o.abiertos++;
      if (f.estado === 'cerrado' && fechaET(f.cerradaAt) === fecha) { o.cerrados++; if ((f.neto || 0) > 0) o.ganados++; o.neto = r2(o.neto + (f.neto || 0)); }
    }
    s.porEstrategiaHoy = Object.values(pe);
    // espejo del día: Tradier contra Demo, trade a trade
    const gem = filas.filter((f) => / \(espejo\)$/.test(f.grupo));
    const cerr = gem.filter((f) => f.estado === 'cerrado' && fechaET(f.cerradaAt) === fecha);
    const comp = cerr.filter((f) => f.neto != null && f.extra?.tradierPnl != null && !f.extra.salidaDeTradier);
    const retr = gem.filter((f) => f.estado !== 'no_abierto' && fechaET(f.abiertaAt) === fecha && f.extra?.retrasoSeg != null).map((f) => f.extra.retrasoSeg);
    s.espejo = { encendido: d.espejoActivo !== false, desde: d.espejo?.desde || null,
      copiadosHoy: gem.filter((f) => f.estado !== 'no_abierto' && fechaET(f.abiertaAt) === fecha).length,
      cerradosHoy: cerr.length, comparables: comp.length,
      demoNeto: r2(comp.reduce((a, f) => a + f.neto, 0)), tradierBruto: r2(comp.reduce((a, f) => a + f.extra.tradierPnl, 0)),
      retrasoProm: retr.length ? Math.round(retr.reduce((a, b) => a + b, 0) / retr.length) : null,
      noCopiadosHoy: s.noEntraron.filter((f) => / \(espejo\)$/.test(f.grupo)).length };
    if (!s.espejo.encendido) s.avisos.push('El espejo de Tradier está APAGADO: Mediodía, Iron Condor y Reversión no se copiaron');
    return s;
  }));

  libros.push(err['Iron Balls'] ? { libro: 'Iron Balls', error: err['Iron Balls'] } : con('Iron Balls', () =>
    seccion('Iron Balls', fecha, filasIronBalls(d.ironPipe, d.ironAle), { capital: d.ironLibro?.capital, saldo: d.ironLibro?.saldo, esHoy })));

  return { ok: true, fecha, esHoy, diaDeMercado: d.diaDeMercado !== false, generado: (d.ahora || new Date()).toISOString(),
    nota: 'Cuatro libros independientes de $10.000. Los saldos no se suman. Todo es demo: dry-run en TastyTrade, sin órdenes reales.',
    libros };
}

/**
 * Todos los trades de cada libro, con la misma fila que el informe diario (2026-11-17). Guillermo: "quiero que la
 * marca que tenga sirva para cada hoja de trabajo": Calendario, Historial, Posiciones, Reportes, Curvas y Hoy de la
 * Demo Tasty leen de aquí cuando el libro marcado no es el Robot SPX. Función PURA, mismos insumos que armarDia.
 * Cada fila lleva además `dia` y `diaApertura` (fecha de Nueva York del cierre y de la apertura).
 */
function armarLibros(d) {
  const err = d.errores || {};
  const con = (libro, clave, f) => {
    if (err[libro]) return { libro, clave, error: err[libro] };
    try {
      const x = f();
      const filas = x.filas.map((r) => ({ ...r, dia: fechaET(r.cerradaAt) || null, diaApertura: fechaET(r.abiertaAt) || null }));
      return { libro, clave, capital: x.capital ?? 10000, saldo: x.saldo ?? null, filas };
    } catch (e) { return { libro, clave, error: e.message }; }
  };
  return { ok: true, hoy: d.hoy || fechaET(d.ahora || new Date()), generado: (d.ahora || new Date()).toISOString(),
    libros: [
      con('Entradas Manuales', 'manual', () => ({ capital: d.manual?.capital, saldo: d.manual?.saldo, filas: filasManual(d.manual) })),
      con('Señales Sigma', 'senales', () => ({ capital: d.senales?.capital, saldo: d.senales?.saldo, filas: filasSenales(d.senales) })),
      con('Robot SPX', 'robot', () => ({ capital: d.robot?.capital, saldo: d.robot?.saldo, filas: filasRobot(d.ejecuciones, d.gemelos, d.pnlDe || (() => null)) })),
      con('Iron Balls', 'ironballs', () => ({ capital: d.ironLibro?.capital, saldo: d.ironLibro?.saldo, filas: filasIronBalls(d.ironPipe, d.ironAle) })),
    ] };
}

module.exports = { armarDia, armarLibros, filasManual, filasSenales, filasRobot, filasIronBalls, seccion, fechaET, textoPatas };
