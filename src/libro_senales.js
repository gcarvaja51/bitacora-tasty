'use strict';
// ── Libro "Señales Sigma" de la Demo Tasty (Guillermo 2026-11-16) ─────────────────────────────────────────────────
//
// Réplica en demo de las señales que publican los profes en el canal "Notificaciones 5 de Opción Sigma".
// El lector (ironballs/lector.js, en Vultr o en el PC) barre el canal cada 2 min de 9:30 a 16:00 ET y manda el texto
// crudo a POST /api/libros/senales/alerta. Este módulo decide y registra en <DATA_DIR>/libro_senales.json.
//
// Reglas de Guillermo (16-nov-2026):
//   - Capital propio de $10.000, separado de los otros libros (Entradas Manuales, Robot SPX, Iron Balls).
//   - 30 minutos de vida: si no entra al demo en 30 min desde la publicación (o desde las 9:30 si se publicó con el
//     mercado cerrado) queda VENCIDA. Sin meta diaria: se toman todas las que se puedan.
//   - Precio = cadena real de TastyTrade CRUZANDO el spread (compra al ask, vende al bid). Comisiones = las del
//     dry-run contra la cuenta real. ESTE MÓDULO NUNCA MANDA UNA ORDEN: solo pide /orders/dry-run.
//   - El historial que ya existía (senales-sigma/datos/demo.json, 11 trades) se importa tal cual, "antes de la regla".
//
// Dependencias inyectadas (se prueban sin red): cotizar(simbolos) → { q: { sym: {bid, ask, mark} } } | null,
// dryRun(cuerpo) → { ok, fees, tipo, detalle }, calendario (src/calendario_nyse.js), ahora() → Date.

const fs = require('fs');
const path = require('path');
const sigma = require('./sigma_senales');

const CAPITAL = 10000;
const ESTADOS_VIVOS = ['pendiente_entrada', 'abierta', 'pendiente_cierre'];
const r2 = (x) => +Number(x).toFixed(2);
const r3 = (x) => +Number(x).toFixed(3);

// Valor por acción de cruzar la estructura. + = entra plata.
//   abrir:  compro al ask (pago), vendo al bid (cobro)
//   cerrar: vendo lo comprado al bid, recompro lo vendido al ask
function netoCruzando(patas, q, lado) {
  let v = 0;
  for (const p of patas) {
    const c = q[p.sym];
    if (!c || c.bid == null || c.ask == null) return null;
    if (lado === 'abrir') v += p.q > 0 ? -p.q * c.ask : -p.q * c.bid;
    else v += p.q > 0 ? p.q * c.bid : p.q * c.ask;
  }
  return r3(v);
}
function netoAlMedio(patas, q, lado) {
  let v = 0;
  for (const p of patas) {
    const c = q[p.sym];
    if (!c || c.mark == null) return null;
    v += (lado === 'abrir' ? -1 : 1) * p.q * c.mark;
  }
  return r3(v);
}

// Orden multi-pata en el formato de TastyTrade para el dry-run. `neto` por acción, + = crédito.
function cuerpoOrden(patas, neto, abrir) {
  const tasty = (s) => { const m = String(s).match(/^([A-Z]+)(\d{6}[CP]\d{8})$/); return m ? m[1].padEnd(6, ' ') + m[2] : null; };
  return {
    'time-in-force': 'Day', 'order-type': 'Limit',
    price: Math.max(0.01, Math.abs(Number(neto) || 0)).toFixed(2),
    'price-effect': neto >= 0 ? 'Credit' : 'Debit',
    legs: patas.map((p) => ({
      'instrument-type': 'Equity Option', symbol: tasty(p.sym), quantity: Math.abs(p.q),
      action: p.q > 0 ? (abrir ? 'Buy to Open' : 'Sell to Close') : (abrir ? 'Sell to Open' : 'Buy to Close'),
    })),
  };
}

// Comisión estimada (la misma tabla que usaba senales-sigma/motor.py) para cuando el dry-run de cierre no responde.
const FEE_INDICE = { SPX: 0.60, SPXW: 0.60, VIX: 0.35, XSP: 0.0, NDX: 0.60, NDXP: 0.60, RUT: 0.60, RUTW: 0.60 };
function feesEstimadas(patas, abrir) {
  let f = 0;
  for (const p of patas) {
    const raiz = String(p.sym).match(/^[A-Z]+/)[0];
    f += Math.abs(p.q) * ((abrir ? 1.0 : 0) + 0.10 + 0.03 + (FEE_INDICE[raiz] || 0));
  }
  return r2(f);
}

// "SPX   261218P07490000" (demo.json) → pata del libro
function pataDesdeOcc(occ, q) {
  const s = String(occ).replace(/\s+/g, '');
  const m = s.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return null;
  return { sym: s, q, tipo: m[5], strike: Number(m[6]) / 1000, vto: `20${m[2]}-${m[3]}-${m[4]}` };
}

function crearLibroSenales({ dataDir, cotizar, dryRun, calendario, ahora = () => new Date(), capital = CAPITAL,
                             archivo = 'libro_senales.json', avisar = () => {} }) {
  const ARCHIVO = path.join(dataDir, archivo);
  const vacio = () => ({ capital, creado: ahora().toISOString(), trades: [], alertas: [] });
  const cargar = () => { try { return JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')); } catch (e) { return vacio(); } };
  const guardar = (L) => fs.writeFileSync(ARCHIVO, JSON.stringify(L, null, 1), 'utf8');

  // Serializa todo lo que escribe: nunca dos operaciones a la vez sobre el archivo.
  let cola = Promise.resolve();
  const enCola = (fn) => { const t = cola.then(fn, fn); cola = t.catch(() => {}); return t; };

  function saldo(L) {
    const realizado = L.trades.reduce((a, t) => a + (t.pnlRealizado || 0), 0);
    const reservado = L.trades.filter((t) => t.estado === 'abierta' || t.estado === 'pendiente_cierre')
      .reduce((a, t) => a + (t.riesgoUsd || 0), 0);
    const s = r2((L.capital || capital) + realizado);
    return { capital: L.capital || capital, saldo: s, realizado: r2(realizado), reservado: r2(reservado), disponible: r2(s - reservado) };
  }

  async function intentarAbrir(L, t) {
    const now = ahora();
    if (now > new Date(t.venceAt)) {
      t.estado = 'vencida'; t.motivo = t.ultimoIntento || 'no se pudo entrar en los 30 minutos';
      t.cerradaAt = now.toISOString();
      return 'VENCIDA';
    }
    if (!calendario.enHorarioDeMercado(now)) { t.ultimoIntento = 'mercado cerrado'; return 'ESPERA'; }
    if (t.riesgoUsd != null && t.riesgoUsd > saldo(L).disponible) {
      t.estado = 'rechazada'; t.motivo = `sin capital libre: riesgo $${t.riesgoUsd} > disponible $${saldo(L).disponible}`;
      t.cerradaAt = now.toISOString();
      return 'RECHAZADA';
    }
    const c = await cotizar(t.patas.map((p) => p.sym));
    const neto = c ? netoCruzando(t.patas, c.q, 'abrir') : null;
    if (neto == null) { t.ultimoIntento = 'TastyTrade no cotizó todas las patas'; return 'ESPERA'; }
    const dr = await dryRun(cuerpoOrden(t.patas, neto, true));
    if (!dr.ok) {
      if (dr.tipo === 'rechazo') {
        t.estado = 'rechazada'; t.motivo = `TastyTrade rechazó el dry-run: ${dr.detalle}`; t.cerradaAt = now.toISOString();
        return 'RECHAZADA';
      }
      t.ultimoIntento = `dry-run sin respuesta: ${dr.detalle || 'red'}`;
      return 'ESPERA';
    }
    t.estado = 'abierta';
    t.entrada = { at: now.toISOString(), precio: neto, alMedio: netoAlMedio(t.patas, c.q, 'abrir'),
                  fees: dr.fees != null ? dr.fees : feesEstimadas(t.patas, true), feesEstimadas: dr.fees == null,
                  minutosDesdeSenal: Math.round((now - new Date(t.mensajeAt)) / 60000) };
    delete t.ultimoIntento;
    avisar(`${t.profe} · ${t.activo} ${t.estrategia}: entra al demo a ${neto >= 0 ? 'crédito' : 'débito'} ${Math.abs(neto).toFixed(2)} ` +
           `(${t.entrada.minutosDesdeSenal} min después de la señal)`, `📗 Señales Sigma abrió (demo)`);
    return 'ABIERTA';
  }

  async function intentarCerrar(L, t) {
    const now = ahora();
    if (!calendario.enHorarioDeMercado(now)) { t.ultimoIntento = 'mercado cerrado'; return 'ESPERA'; }
    const c = await cotizar(t.patas.map((p) => p.sym));
    const neto = c ? netoCruzando(t.patas, c.q, 'cerrar') : null;
    if (neto == null) { t.ultimoIntento = 'TastyTrade no cotizó todas las patas'; return 'ESPERA'; }
    let dr = { ok: false };
    try { dr = await dryRun(cuerpoOrden(t.patas, neto, false)); } catch (e) { dr = { ok: false, detalle: e.message }; }
    const fees = dr.ok && dr.fees != null ? dr.fees : feesEstimadas(t.patas, false);
    const pnl = r2((t.entrada.precio + neto) * 100 - (t.entrada.fees || 0) - fees);
    t.salida = { at: now.toISOString(), precio: neto, fees, feesEstimadas: !(dr.ok && dr.fees != null) };
    t.pnlRealizado = r2((t.pnlRealizado || 0) + pnl);
    t.estado = 'cerrada'; t.cerradaAt = now.toISOString();
    delete t.ultimoIntento;
    avisar(`${t.profe} · ${t.activo} ${t.estrategia}: cierra en el demo, neto ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`,
           `${pnl >= 0 ? '✅' : '🔻'} Señales Sigma cerró (demo)`);
    return 'CERRADA';
  }

  // Lo que manda el lector. Idempotente por id del mensaje de WhatsApp.
  function procesarAlerta({ alertId, mensajeAt, texto, autorJid = '' }) {
    return enCola(async () => {
      const L = cargar();
      const previa = L.alertas.find((a) => a.alertId === alertId);
      if (previa) return { ok: true, repetida: true, estado: previa.estado, motivo: 'ya procesada' };
      const p = sigma.parsearSenalSigma(texto, { mensajeAt, autorJid });
      const reg = { alertId, mensajeAt, recibidaAt: ahora().toISOString(), profe: p.profe, tipo: p.tipo,
                    texto: String(texto).slice(0, 600) };
      let res;
      if (p.tipo === 'apertura' && !p.ok) {
        // No se entendió: queda a revisión y, si nadie la resuelve, vence a los 30 min como cualquier señal.
        res = { estado: 'REVISION', motivo: p.motivo };
      } else if (p.tipo === 'apertura') {
        const t = {
          id: `sig-${(L.trades.length + 1).toString().padStart(4, '0')}`, alertId, profe: p.profe, marca: `sigma-${p.profe.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()}`,
          activo: p.activo, estrategia: p.estrategia, patas: p.patas, netoPublicado: p.netoPublicado, riesgoUsd: p.riesgoUsd,
          pop: p.pop, mensajeAt, venceAt: sigma.venceVentana(mensajeAt, calendario).toISOString(), estado: 'pendiente_entrada',
        };
        L.trades.push(t);
        const r = await intentarAbrir(L, t);
        res = { estado: r, id: t.id, motivo: t.motivo || t.ultimoIntento || null };
      } else if (p.tipo === 'cierre' && p.ok) {
        const vivo = L.trades.find((t) => (t.estado === 'abierta') && sigma.coincideCierre(t, p));
        const pendiente = L.trades.find((t) => t.estado === 'pendiente_entrada' && sigma.coincideCierre(t, p));
        if (vivo) {
          vivo.estado = 'pendiente_cierre';
          vivo.cierrePublicado = { alertId, mensajeAt, pct: p.pctPublicado, precio: p.precioCierre, pnlUsd: p.pnlPublicadoUsd };
          const r = await intentarCerrar(L, vivo);
          res = { estado: r === 'CERRADA' ? 'CIERRE_DEMO' : 'CIERRE_PENDIENTE', id: vivo.id, motivo: vivo.ultimoIntento || null };
        } else if (pendiente) {
          pendiente.estado = 'no_ejecutada'; pendiente.motivo = 'el profe la cerró antes de que el demo pudiera entrar';
          pendiente.cerradaAt = ahora().toISOString();
          res = { estado: 'NO_EJECUTADA', id: pendiente.id };
        } else {
          res = { estado: 'CIERRE_SIN_POSICION', motivo: 'no hay en el demo una posición con ese activo y esos strikes' };
        }
      } else if (p.tipo === 'cierre') {
        res = { estado: 'REVISION', motivo: p.motivo || 'cierre en texto libre' };
      } else {
        res = { estado: 'IGNORADA', motivo: p.motivo };
      }
      Object.assign(reg, res);
      L.alertas.unshift(reg);
      L.alertas = L.alertas.slice(0, 3000);
      guardar(L);
      return { ok: true, ...res };
    });
  }

  // Reintenta lo pendiente (aperturas dentro de su ventana, cierres sin precio). Lo llama el servidor cada minuto.
  function tick() {
    return enCola(async () => {
      const L = cargar();
      let cambios = 0;
      for (const t of L.trades) {
        if (t.estado === 'pendiente_entrada') { const r = await intentarAbrir(L, t); if (r !== 'ESPERA') cambios++; }
        else if (t.estado === 'pendiente_cierre') { const r = await intentarCerrar(L, t); if (r !== 'ESPERA') cambios++; }
      }
      // Revisiones sin resolver: a los 30 min quedan vencidas
      for (const a of L.alertas) {
        if (a.estado === 'REVISION' && ahora() > sigma.venceVentana(a.mensajeAt, calendario)) {
          a.estado = 'VENCIDA'; a.motivo = `${a.motivo || 'sin leer'} — nadie la resolvió en 30 minutos`; cambios++;
        }
      }
      if (cambios) guardar(L);
      return { cambios };
    });
  }

  // Carga única del historial de senales-sigma/datos/demo.json. No pisa nada: si ya hay trades importados, no hace nada.
  function importarDemoJson(demo, senalesPorId = {}) {
    return enCola(async () => {
      const L = cargar();
      if (L.trades.some((t) => t.antesDeLaRegla)) return { ok: false, motivo: 'el historial ya estaba importado' };
      const conv = (lista) => (lista || []).map(([occ, q]) => pataDesdeOcc(occ, q)).filter(Boolean);
      let n = 0;
      for (const d of demo.trades || []) {
        const s = senalesPorId[d.senal] || {};
        const patas = conv(d.patas);
        const estado = { abierta: 'abierta', cerrada: 'cerrada', rechazada: 'rechazada', no_ejecutada: 'no_ejecutada',
                         pendiente_cierre: 'pendiente_cierre', pendiente_roll: 'abierta', pendiente_entrada: 'vencida' }[d.estado] || d.estado;
        const et = (x) => (x ? new Date(String(x).replace(' ', 'T') + ':00-05:00').toISOString() : null);
        L.trades.push({
          id: `sig-h${String(d.senal).padStart(3, '0')}`, senalOriginal: d.senal, antesDeLaRegla: true,
          profe: d.profe, marca: d.marca, activo: d.activo, estrategia: d.estrategia || d.detalle, patas,
          riesgoUsd: d.riesgo ?? null, netoPublicado: s.credito ?? null, mensajeAt: s.abierta ? et(s.abierta) : null,
          estado, motivo: d.motivo || null,
          entrada: d.entrada ? { at: et(d.entrada.cuando), precio: d.entrada.precio, fees: d.entrada.fees, feesEstimadas: true } : null,
          salida: d.salida ? { at: et(d.salida.cuando), precio: d.salida.precio, fees: d.salida.fees, feesEstimadas: true } : null,
          pnlRealizado: d.pnl_realizado ?? 0, cerradaAt: d.salida ? et(d.salida.cuando) : null,
          historia: d.historia || [],
        });
        n++;
      }
      guardar(L);
      return { ok: true, importados: n };
    });
  }

  // Resumen para la pantalla. `marcar` = true valora las abiertas con la cadena de TastyTrade (una sola llamada).
  async function resumen({ marcar = true } = {}) {
    const L = cargar();
    const s = saldo(L);
    const hoy = calendario.fechaET(ahora());
    const mes = hoy.slice(0, 7);
    const cerradas = L.trades.filter((t) => t.estado === 'cerrada');
    const fechaCierre = (t) => (t.cerradaAt ? calendario.fechaET(new Date(t.cerradaAt)) : '');
    const pnlHoy = r2(cerradas.filter((t) => fechaCierre(t) === hoy).reduce((a, t) => a + t.pnlRealizado, 0));
    const pnlMes = r2(cerradas.filter((t) => fechaCierre(t).startsWith(mes)).reduce((a, t) => a + t.pnlRealizado, 0));
    const ganadas = cerradas.filter((t) => t.pnlRealizado > 0).length;
    const abiertas = L.trades.filter((t) => t.estado === 'abierta' || t.estado === 'pendiente_cierre');
    if (marcar && abiertas.length) {
      try {
        const syms = [...new Set(abiertas.flatMap((t) => t.patas.map((p) => p.sym)))];
        const c = await cotizar(syms, { permitirParcial: true });
        for (const t of abiertas) {
          const x = c ? netoCruzando(t.patas, c.q, 'cerrar') : null;
          const m = c ? netoAlMedio(t.patas, c.q, 'cerrar') : null;
          t.latenteCruzando = x == null ? null : r2((t.entrada.precio + x) * 100 - (t.entrada.fees || 0) - feesEstimadas(t.patas, false));
          t.latenteMedio = m == null ? null : r2((t.entrada.precio + m) * 100 - (t.entrada.fees || 0));
        }
      } catch (e) { /* sin marca: la pantalla muestra "sin precio" */ }
    }
    const porProfe = {};
    for (const t of L.trades) {
      const e = porProfe[t.profe] = porProfe[t.profe] || { profe: t.profe, cerradas: 0, ganadas: 0, pnl: 0, abiertas: 0, vencidas: 0 };
      if (t.estado === 'cerrada') { e.cerradas++; if (t.pnlRealizado > 0) e.ganadas++; e.pnl = r2(e.pnl + t.pnlRealizado); }
      if (t.estado === 'abierta' || t.estado === 'pendiente_cierre') e.abiertas++;
      if (t.estado === 'vencida' || t.estado === 'no_ejecutada') e.vencidas++;
    }
    // curva: saldo al cierre de cada día con cierres
    const porDia = {};
    for (const t of cerradas) { const d = fechaCierre(t); porDia[d] = r2((porDia[d] || 0) + t.pnlRealizado); }
    let acum = s.capital;
    const curva = Object.keys(porDia).sort().map((d) => ({ fecha: d, pnl: porDia[d], saldo: r2(acum += porDia[d]) }));
    return {
      ok: true, libro: 'Señales Sigma', ...s, pnlHoy, pnlMes,
      cerradas: cerradas.length, ganadas, winRate: cerradas.length ? Math.round(100 * ganadas / cerradas.length) : null,
      latente: r2(abiertas.reduce((a, t) => a + (t.latenteCruzando || 0), 0)),
      abiertas, pendientes: L.trades.filter((t) => t.estado === 'pendiente_entrada'),
      historial: L.trades.filter((t) => !ESTADOS_VIVOS.includes(t.estado)).sort((a, b) => String(b.cerradaAt).localeCompare(String(a.cerradaAt))),
      porProfe: Object.values(porProfe).sort((a, b) => b.pnl - a.pnl), curva,
      alertas: L.alertas.slice(0, 50),
    };
  }

  return { procesarAlerta, tick, importarDemoJson, resumen, _cargar: cargar };
}

module.exports = { crearLibroSenales, netoCruzando, netoAlMedio, cuerpoOrden, feesEstimadas, pataDesdeOcc, CAPITAL };
