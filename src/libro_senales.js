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
// Cuenta MARGIN (Guillermo 18-nov-2026: "debemos emular una cuenta margin… el buying power no necesariamente es el
// 100% de lo que exige el broker"):
//   - Cada posición aparta el MARGEN que pide TastyTrade para esa orden sola (isolated-order-margin-requirement del
//     dry-run), no la pérdida máxima publicada. Un put vendido pide ~25-30% del strike, no el 100%.
//     Si el dry-run no trae margen, se aparta la pérdida máxima publicada (lo conservador).
//   - Tope de uso: el margen total no pasa del 75% del saldo (decisión de Guillermo, 18-nov). Señal que no cabe → rechazada.
//   - Una vez al día (desde las 10:00 ET) se vuelve a pedir el margen de lo abierto: el de una pata vendida sube si el
//     subyacente va en contra. Si el margen supera el valor de la cuenta (saldo + latente) = LLAMADA DE MARGEN:
//     no se abre nada nuevo hasta que baje.
//
// Rolls y ajustes (Guillermo 18-nov): lo que el profe rola o ajusta, el demo lo replica sobre la MISMA posición
// (cierra las patas que él cierra y abre las nuevas, cruzando el spread). El P&L es de la operación completa: el
// efectivo de cada ajuste se acumula y se realiza al cierre final. Si no tenemos la posición base, se anota
// (ROLL_SIN_BASE) y no se abre nada.
//
// Dependencias inyectadas (se prueban sin red): cotizar(simbolos) → { q: { sym: {bid, ask, mark} } } | null,
// dryRun(cuerpo) → { ok, fees, margen, tipo, detalle }, calendario (src/calendario_nyse.js), ahora() → Date,
// interpretar({ texto, imagenB64, mime }) → gestión de sigma_gestion.aGestion (opcional: sin él, las gestiones en texto
// libre o en foto quedan a REVISION).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sigma = require('./sigma_senales');

const CAPITAL = 10000;
const TOPE_MARGEN = 0.75;   // máximo del saldo comprometido como margen (Guillermo 18-nov-2026)
const HORA_AJUSTES = 600;   // rolls/ajustes desde las 10:00 ET, con la cadena estable (Guillermo 18-nov-2026)
// Cierre a decisión de Guillermo (19-nov-2026): "si el profe envía un cierre y hay una diferencia mayor al 30% entre
// el valor enviado por el profe vs el posible cierre, me envías el dato a mi WhatsApp y al correo para que yo tome la
// decisión". Sin su clic NO se cierra; a las 15:30 ET se le recuerda (una vez al día).
const UMBRAL_DECISION = 0.30;
const HORA_RECORDATORIO = 930;   // 15:30 ET
const ESTADOS_VIVOS = ['pendiente_entrada', 'abierta', 'pendiente_cierre', 'pendiente_ajuste', 'pendiente_decision'];
const ESTADOS_ABIERTOS = ['abierta', 'pendiente_cierre', 'pendiente_ajuste', 'pendiente_decision'];
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

// Efectivo neto acumulado de la operación en $ (después de comisiones): la entrada más cada ajuste.
// El P&L al cerrar = caja + valor de cierre × 100 − comisiones del cierre.
function cajaDe(t) {
  if (!t.entrada) return 0;
  const base = t.entrada.precio * 100 - (t.entrada.fees || 0);
  return r2(base + (t.ajustes || []).reduce((a, x) => a + (x.caja || 0), 0));
}

// ¿Nuestro cierre es más de 30% peor que el que publicó el profe? Precios por acción con signo (+ = entra plata):
// el profe "Cerrado a 0.60 de débito" = -0.60; el nuestro, cruzando el spread, -1.15 → peor en 0.55 = 92%.
// Solo cuenta si el nuestro es PEOR; si es igual o mejor se cierra solo. Base mínima 0.05 para precios casi cero.
function compararConProfe(cp, neto) {
  if (!cp || cp.precio == null || !cp.efecto || neto == null) return null;
  const profe = cp.efecto === 'debito' ? -Math.abs(cp.precio) : Math.abs(cp.precio);
  const peor = r3(profe - neto);
  const pct = peor > 0 ? Math.round(1000 * peor / Math.max(Math.abs(profe), 0.05)) / 1000 : 0;
  return { profe, nuestro: neto, peor, pct };
}

// Copia del trade sin la clave del link (lo que se muestra en pantallas públicas).
function sinClave(t) {
  if (!t || !t.decision || t.decision.clave === undefined) return t;
  const { clave, ...d } = t.decision;
  return { ...t, decision: d };
}

// Lo que aparta cada posición abierta: el margen de TastyTrade si se conoce; si no, la pérdida máxima publicada.
const margenDe = (t) => (t.margen != null ? t.margen : (t.riesgoUsd || 0));

// ¿Esta pata de la gestión es esta pata del demo? Mismo tipo y strike, y mismo vencimiento si la gestión lo trae.
function mismaPata(pg, pd, mensajeAt) {
  if (pg.tipo !== pd.tipo || Math.abs(Number(pg.strike) - Number(pd.strike)) > 1e-6) return false;
  if (pg.dia && pg.mes) {
    const anio = pg.anio || sigma.anioVto(pg.dia, pg.mes, mensajeAt);
    return pd.vto === sigma.fechaVto(pg.dia, pg.mes, anio);
  }
  return true;
}

function crearLibroSenales({ dataDir, cotizar, dryRun, calendario, ahora = () => new Date(), capital = CAPITAL,
                             archivo = 'libro_senales.json', avisar = () => {}, interpretar = null,
                             topeMargen = TOPE_MARGEN, pedirDecision = () => {} }) {
  const ARCHIVO = path.join(dataDir, archivo);
  const vacio = () => ({ capital, creado: ahora().toISOString(), trades: [], alertas: [] });
  const cargar = () => { try { return JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')); } catch (e) { return vacio(); } };
  const guardar = (L) => fs.writeFileSync(ARCHIVO, JSON.stringify(L, null, 1), 'utf8');

  // Serializa todo lo que escribe: nunca dos operaciones a la vez sobre el archivo.
  let cola = Promise.resolve();
  const enCola = (fn) => { const t = cola.then(fn, fn); cola = t.catch(() => {}); return t; };

  // reservado = margen de lo abierto; tope = 75% del saldo; disponible = tope − reservado.
  function saldo(L) {
    const realizado = L.trades.reduce((a, t) => a + (t.pnlRealizado || 0), 0);
    const reservado = L.trades.filter((t) => ESTADOS_ABIERTOS.includes(t.estado)).reduce((a, t) => a + margenDe(t), 0);
    const s = r2((L.capital || capital) + realizado);
    const tope = r2(s * topeMargen);
    return { capital: L.capital || capital, saldo: s, realizado: r2(realizado), reservado: r2(reservado),
             topeMargen: tope, topePct: Math.round(topeMargen * 100), disponible: r2(tope - reservado),
             usoMargenPct: s > 0 ? Math.round(1000 * reservado / s) / 10 : null };
  }
  const llamadaHoy = (L) => !!(L.margenDia && L.margenDia.llamada && L.margenDia.fecha === calendario.fechaET(ahora()));

  async function intentarAbrir(L, t) {
    const now = ahora();
    if (now > new Date(t.venceAt)) {
      t.estado = 'vencida'; t.motivo = t.ultimoIntento || 'no se pudo entrar en los 30 minutos';
      t.cerradaAt = now.toISOString();
      return 'VENCIDA';
    }
    if (!calendario.enHorarioDeMercado(now)) { t.ultimoIntento = 'mercado cerrado'; return 'ESPERA'; }
    if (t.noAntesDe && now < new Date(t.noAntesDe)) { t.ultimoIntento = `programada desde ${t.noAntesDe}`; return 'ESPERA'; }
    if (llamadaHoy(L)) {
      t.estado = 'rechazada'; t.motivo = `llamada de margen: el margen usado ($${L.margenDia.usado}) supera el valor de la cuenta ($${L.margenDia.valorCuenta})`;
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
    // Margen: el que pide TastyTrade para esta orden sola; si no viene, la pérdida máxima publicada.
    const margen = dr.margen != null ? r2(dr.margen) : t.riesgoUsd;
    const s = saldo(L);
    if (margen != null && margen > s.disponible) {
      t.estado = 'rechazada';
      t.motivo = `sin poder de compra: margen $${margen} > disponible $${s.disponible} (tope ${s.topePct}% del saldo = $${s.topeMargen}, usado $${s.reservado})`;
      t.margen = margen; t.cerradaAt = now.toISOString();
      return 'RECHAZADA';
    }
    t.margen = margen; t.margenFuente = dr.margen != null ? 'tastytrade' : 'perdida_maxima';
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
    // Cierre del profe con una diferencia de más del 30%: no se cierra, decide Guillermo (link por WhatsApp y correo).
    if (t.cierrePublicado && !(t.decision && t.decision.accion === 'cerrar')) {
      const ev = compararConProfe(t.cierrePublicado, neto);
      if (ev && ev.pct > UMBRAL_DECISION) {
        t.estado = 'pendiente_decision';
        t.decision = {
          clave: crypto.randomBytes(16).toString('hex'), pedidaAt: now.toISOString(), ...ev,
          pnlProfeUsd: t.cierrePublicado.pnlUsd ?? null,
          pnlNuestroEstimado: r2(cajaDe(t) + neto * 100 - feesEstimadas(t.patas, false)),
          avisos: [{ at: now.toISOString(), tipo: 'decision' }],
        };
        delete t.ultimoIntento;
        L.colaWs = L.colaWs || [];
        L.colaWs.push({ seq: (L.seqWs = (L.seqWs || 0) + 1), at: now.toISOString(), id: t.id, tipo: 'decision' });
        try { await pedirDecision(sinClave(t), { clave: t.decision.clave, recordatorio: false }); }
        catch (e) { t.decision.errorAviso = e.message; }
        return 'DECISION';
      }
    }
    let dr = { ok: false };
    try { dr = await dryRun(cuerpoOrden(t.patas, neto, false)); } catch (e) { dr = { ok: false, detalle: e.message }; }
    const fees = dr.ok && dr.fees != null ? dr.fees : feesEstimadas(t.patas, false);
    const pnl = r2(cajaDe(t) + neto * 100 - fees);
    t.salida = { at: now.toISOString(), precio: neto, fees, feesEstimadas: !(dr.ok && dr.fees != null) };
    t.pnlRealizado = r2((t.pnlRealizado || 0) + pnl);
    t.estado = 'cerrada'; t.cerradaAt = now.toISOString();
    delete t.ultimoIntento;
    avisar(`${t.profe} · ${t.activo} ${t.estrategia}: cierra en el demo, neto ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`,
           `${pnl >= 0 ? '✅' : '🔻'} Señales Sigma cerró (demo)`);
    return 'CERRADA';
  }

  // ── Rolls y ajustes ─────────────────────────────────────────────────────────────────────────────────────────────
  // Busca la posición del demo que la gestión toca. Devuelve { t, cerrar } (patas del demo a cerrar) o { motivo }.
  function resolverGestion(L, g, profe, mensajeAt) {
    const vivas = L.trades.filter((t) => ESTADOS_ABIERTOS.includes(t.estado) && t.activo === g.activo);
    if (!vivas.length) return { sinBase: true, motivo: `no tenemos en el demo una posición de ${g.activo}` };
    const candidatas = [];
    for (const t of vivas) {
      if (g.cerrar == null) { candidatas.push({ t, cerrar: t.patas.slice() }); continue; }   // "cierra todo" (formato alerta)
      const usadas = new Set();
      const cerrar = [];
      let ok = true;
      for (const pg of g.cerrar) {
        const i = t.patas.findIndex((pd, k) => !usadas.has(k) && mismaPata(pg, pd, mensajeAt) && Math.sign(pd.q) === Math.sign(pg.q || pd.q));
        if (i < 0) { ok = false; break; }
        usadas.add(i);
        cerrar.push(t.patas[i]);
      }
      if (ok) candidatas.push({ t, cerrar });
    }
    if (!candidatas.length) {
      return { sinBase: true, motivo: `tenemos ${g.activo} pero no con las patas que el profe cierra (${(g.cerrar || []).map((p) => `${p.q < 0 ? '-' : '+'}${p.tipo}${p.strike}`).join(' ')})` };
    }
    // Varias posibles: la del mismo profe; si sigue habiendo varias, la más reciente.
    const delProfe = candidatas.filter((c) => c.t.profe === profe);
    const lista = delProfe.length ? delProfe : candidatas;
    return lista.sort((a, b) => String(b.t.mensajeAt).localeCompare(String(a.t.mensajeAt)))[0];
  }

  function patasNuevas(g, activo, mensajeAt) {
    return (g.abrir || []).map((p) => {
      const anio = p.anio || sigma.anioVto(p.dia, p.mes, mensajeAt);
      return { sym: sigma.simbolo(activo, anio, p.mes, p.dia, p.tipo, p.strike), q: p.q, tipo: p.tipo, strike: p.strike,
               vto: sigma.fechaVto(p.dia, p.mes, anio) };
    });
  }

  // Ejecuta el ajuste pendiente de t (t.ajustePendiente): cierra unas patas y abre otras, cruzando el spread.
  async function intentarAjuste(L, t) {
    const now = ahora();
    const a = t.ajustePendiente;
    if (!a) { t.estado = 'abierta'; return 'ABIERTA'; }
    if (!calendario.enHorarioDeMercado(now)) { t.ultimoIntento = 'mercado cerrado'; return 'ESPERA'; }
    // Guillermo 18-nov: "hagámoslos después de las 10 am, cuando la cadena de opciones es más estable".
    if (calendario.minutosET(now) < HORA_AJUSTES) { t.ultimoIntento = 'espera a las 10:00 ET (cadena más estable)'; return 'ESPERA'; }
    const syms = [...new Set([...a.cerrar, ...a.abrir].map((p) => p.sym))];
    const c = await cotizar(syms);
    const netoC = a.cerrar.length ? (c ? netoCruzando(a.cerrar, c.q, 'cerrar') : null) : 0;
    const netoA = a.abrir.length ? (c ? netoCruzando(a.abrir, c.q, 'abrir') : null) : 0;
    if (netoC == null || netoA == null) { t.ultimoIntento = 'TastyTrade no cotizó todas las patas del ajuste'; return 'ESPERA'; }
    let feesC = 0, feesA = 0, estimadas = false;
    if (a.cerrar.length) {
      let dr = { ok: false };
      try { dr = await dryRun(cuerpoOrden(a.cerrar, netoC, false)); } catch (e) { dr = { ok: false }; }
      feesC = dr.ok && dr.fees != null ? dr.fees : (estimadas = true, feesEstimadas(a.cerrar, false));
    }
    if (a.abrir.length) {
      const dr = await dryRun(cuerpoOrden(a.abrir, netoA, true));
      if (!dr.ok && dr.tipo === 'rechazo') {
        // El broker no deja abrir la pata nueva: se registra y se sigue con lo que hay (no se cierra a medias).
        t.estado = 'abierta'; delete t.ajustePendiente;
        (t.ajustes = t.ajustes || []).push({ at: now.toISOString(), alertId: a.alertId, estado: 'rechazado', motivo: `TastyTrade rechazó la pata nueva: ${dr.detalle}` });
        return 'AJUSTE_RECHAZADO';
      }
      if (!dr.ok) { t.ultimoIntento = `dry-run del ajuste sin respuesta: ${dr.detalle || 'red'}`; return 'ESPERA'; }
      feesA = dr.fees != null ? dr.fees : (estimadas = true, feesEstimadas(a.abrir, true));
    }
    const caja = r2((netoC + netoA) * 100 - feesC - feesA);
    // Nuevas patas de la posición: se quitan las cerradas (una por una) y se suman las abiertas.
    const restantes = t.patas.slice();
    for (const pc of a.cerrar) {
      const i = restantes.findIndex((p) => p.sym === pc.sym && Math.sign(p.q) === Math.sign(pc.q));
      if (i >= 0) restantes.splice(i, 1);
    }
    t.patas = [...restantes, ...a.abrir];
    (t.ajustes = t.ajustes || []).push({
      at: now.toISOString(), alertId: a.alertId, mensajeAt: a.mensajeAt, accion: a.accion, formato: a.formato,
      cerradas: a.cerrar.map((p) => p.sym), abiertas: a.abrir.map((p) => p.sym),
      netoCierre: netoC, netoApertura: netoA, fees: r2(feesC + feesA), feesEstimadas: estimadas, caja,
      netoPublicadoUsd: a.netoPublicadoUsd ?? null,
      minutosDesdeSenal: a.mensajeAt ? Math.round((now - new Date(a.mensajeAt)) / 60000) : null,
    });
    delete t.ajustePendiente; delete t.ultimoIntento;
    const neto = r2((netoC + netoA) * 100);
    if (!t.patas.length) {   // el ajuste cerró todo: la operación termina con lo acumulado
      t.salida = { at: now.toISOString(), precio: 0, fees: 0, porAjuste: true };
      t.pnlRealizado = r2((t.pnlRealizado || 0) + cajaDe(t));
      t.estado = 'cerrada'; t.cerradaAt = now.toISOString();
      avisar(`${t.profe} · ${t.activo}: el ajuste cerró toda la posición, neto ${t.pnlRealizado >= 0 ? '+' : '-'}$${Math.abs(t.pnlRealizado).toFixed(2)}`,
             '🔁 Señales Sigma ajustó (demo)');
      return 'AJUSTE_CIERRA';
    }
    // Margen de la estructura que queda (si el dry-run lo da)
    try {
      if (t.patas.length <= 4 && c) {
        const m = netoAlMedio(t.patas, c.q, 'abrir');
        const dm = await dryRun(cuerpoOrden(t.patas, m == null ? 0.01 : m, true));
        if (dm.ok && dm.margen != null) { t.margen = r2(dm.margen); t.margenFuente = 'tastytrade'; }
      }
    } catch (e) { /* se queda con el margen anterior */ }
    t.estado = 'abierta';
    avisar(`${t.profe} · ${t.activo}: ${a.accion || 'roll'} en el demo, ${neto >= 0 ? 'crédito' : 'débito'} $${Math.abs(neto).toFixed(2)}` +
           (a.netoPublicadoUsd != null ? ` (el profe: ${a.netoPublicadoUsd >= 0 ? '+' : '-'}$${Math.abs(a.netoPublicadoUsd)})` : ''),
           '🔁 Señales Sigma ajustó (demo)');
    return 'AJUSTE_DEMO';
  }

  // Registra la gestión sobre la posición y la ejecuta si se puede. g = { activo, cerrar|null, abrir, accion, ... }.
  async function aplicarGestion(L, g, { alertId, mensajeAt, profe, formato }) {
    const r = resolverGestion(L, g, profe, mensajeAt);
    if (!r.t) return { estado: 'ROLL_SIN_BASE', motivo: r.motivo };
    const t = r.t;
    if (t.estado === 'pendiente_ajuste' || t.estado === 'pendiente_cierre') {
      return { estado: 'REVISION', id: t.id, motivo: `la posición ya tiene un ${t.estado === 'pendiente_cierre' ? 'cierre' : 'ajuste'} pendiente` };
    }
    let abrir;
    try { abrir = patasNuevas(g, t.activo, mensajeAt); } catch (e) { return { estado: 'REVISION', id: t.id, motivo: `patas nuevas ilegibles: ${e.message}` }; }
    t.ajustePendiente = { alertId, mensajeAt, accion: g.accion || 'roll', formato, cerrar: r.cerrar, abrir,
                          netoPublicadoUsd: g.netoPublicadoUsd ?? null };
    t.estado = 'pendiente_ajuste';
    const x = await intentarAjuste(L, t);
    return { estado: x === 'ESPERA' ? 'AJUSTE_PENDIENTE' : x, id: t.id, motivo: t.ultimoIntento || null };
  }

  // ── Margen del día: se vuelve a pedir el margen de lo abierto y se mira si hay llamada de margen ────────────────
  async function recalcularMargenInterno(L) {
    const abiertas = L.trades.filter((t) => t.estado === 'abierta' && t.patas && t.patas.length);
    let c = null;
    try { c = abiertas.length ? await cotizar([...new Set(abiertas.flatMap((t) => t.patas.map((p) => p.sym)))], { permitirParcial: true }) : null; } catch (e) { c = null; }
    let latente = 0, cambios = 0;
    for (const t of abiertas) {
      const cierre = c ? netoCruzando(t.patas, c.q, 'cerrar') : null;
      if (cierre != null) latente += cajaDe(t) + cierre * 100 - feesEstimadas(t.patas, false);
      if (t.patas.length > 4) continue;
      const m = c ? netoAlMedio(t.patas, c.q, 'abrir') : null;
      try {
        const dr = await dryRun(cuerpoOrden(t.patas, m == null ? 0.01 : m, true));
        if (dr.ok && dr.margen != null) {
          const nuevo = r2(dr.margen);
          if (nuevo !== t.margen) { (t.historiaMargen = t.historiaMargen || []).push({ at: ahora().toISOString(), antes: t.margen ?? null, ahora: nuevo }); cambios++; }
          t.margen = nuevo; t.margenFuente = 'tastytrade';
        }
      } catch (e) { /* sin margen nuevo: se queda el anterior */ }
    }
    const s = saldo(L);
    const valorCuenta = r2(s.saldo + latente);
    L.margenDia = { fecha: calendario.fechaET(ahora()), at: ahora().toISOString(), usado: s.reservado, valorCuenta,
                    latente: r2(latente), tope: s.topeMargen, llamada: s.reservado > valorCuenta, cambios };
    if (L.margenDia.llamada) {
      avisar(`Margen usado $${s.reservado} > valor de la cuenta $${valorCuenta}. No se abren señales nuevas hoy.`, '⚠️ Señales Sigma: llamada de margen (demo)');
    }
    return L.margenDia;
  }
  function recalcularMargen() {
    return enCola(async () => { const L = cargar(); const m = await recalcularMargenInterno(L); guardar(L); return m; });
  }

  // Lo que manda el lector. Idempotente por id del mensaje de WhatsApp.
  function procesarAlerta({ alertId, mensajeAt, texto, autorJid = '', imagenB64 = null, mime = 'image/jpeg' }) {
    return enCola(async () => {
      const L = cargar();
      const previa = L.alertas.find((a) => a.alertId === alertId);
      if (previa) return { ok: true, repetida: true, estado: previa.estado, motivo: 'ya procesada' };
      let p = sigma.parsearSenalSigma(texto, { mensajeAt, autorJid });
      if (imagenB64) p = { profe: p.profe, mensajeAt, tipo: 'gestion', ok: false, foto: true };   // una foto siempre es gestión a interpretar
      const reg = { alertId, mensajeAt, recibidaAt: ahora().toISOString(), profe: p.profe, tipo: p.tipo,
                    texto: String(texto).slice(0, 600), ...(imagenB64 ? { foto: true } : {}) };
      let res;
      if (p.tipo === 'roll' && p.ok !== false && (p.cerrar === null || (p.cerrar || []).length || (p.abrir || []).length)) {
        if (p.formato === 'alerta' && !p.abrir.length) res = { estado: 'REVISION', motivo: 'roll sin patas nuevas legibles' };
        else res = await aplicarGestion(L, p, { alertId, mensajeAt, profe: p.profe, formato: p.formato });
        reg.gestion = { formato: p.formato, activo: p.activo, cerrar: p.cerrar, abrir: p.abrir, netoPublicadoUsd: p.netoPublicadoUsd };
      } else if (p.tipo === 'gestion' || p.tipo === 'roll') {
        // Antes de gastar una lectura de Claude: ¿el mensaje nombra algún activo que tengamos abierto?
        const abiertos = [...new Set(L.trades.filter((t) => ESTADOS_ABIERTOS.includes(t.estado)).map((t) => t.activo))];
        const nombrados = abiertos.filter((a) => new RegExp(`(^|[^A-Z0-9])${a.replace('.', '\\.')}([^A-Z0-9]|$)`).test(String(texto)));
        if (!nombrados.length && !imagenB64) {
          res = { estado: 'ROLL_SIN_BASE', motivo: 'la gestión no nombra ningún activo que tengamos abierto en el demo' };
        } else if (!nombrados.length && imagenB64 && !/rol|ajust|gesti/i.test(String(texto))) {
          res = { estado: 'IGNORADA', motivo: 'foto sin roll/ajuste en el pie' };
        } else if (!nombrados.length && imagenB64 && (String(texto).match(/\b[A-Z]{1,5}\b/g) || []).length) {
          // "♻️ Roll de META" y no tenemos META: no se gasta la lectura de la foto
          res = { estado: 'ROLL_SIN_BASE', motivo: `la foto es de ${String(texto).match(/\b[A-Z]{1,5}\b/g).join('/')} y no lo tenemos abierto en el demo` };
        } else if (!interpretar) {
          res = { estado: 'REVISION', motivo: 'gestión en texto libre o foto: falta el intérprete (Claude)' };
        } else {
          let g;
          try { g = await interpretar({ texto, imagenB64, mime }); }
          catch (e) { g = { ok: false, motivo: `Claude no pudo leerla: ${e.message}` }; }
          reg.gestion = g;
          if (!g.ok) res = { estado: g.motivo === 'no es una gestión concreta' ? 'IGNORADA' : 'REVISION', motivo: g.motivo };
          else {
            // Una foto/texto puede traer varias gestiones (una por activo): se aplica cada una a su posición.
            const lista = Array.isArray(g.gestiones) ? g.gestiones : [g];
            const resultados = [];
            for (const x of lista) {
              const r = await aplicarGestion(L, x, { alertId, mensajeAt, profe: p.profe, formato: imagenB64 ? 'foto' : 'texto' });
              resultados.push({ activo: x.activo, ...r });
            }
            if (resultados.length === 1) { const { activo, ...r } = resultados[0]; res = r; }
            else {
              const aplicadas = resultados.filter((r) => r.estado !== 'ROLL_SIN_BASE' && r.estado !== 'REVISION');
              const principal = aplicadas[0] || resultados[0];
              res = { estado: principal.estado, id: principal.id,
                      motivo: resultados.map((r) => `${r.activo}: ${r.estado}${r.motivo ? ` (${r.motivo})` : ''}`).join(' · '),
                      gestiones: resultados };
            }
          }
        }
      } else if (p.tipo === 'apertura' && !p.ok) {
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
          vivo.cierrePublicado = { alertId, mensajeAt, pct: p.pctPublicado, precio: p.precioCierre, efecto: p.efectoCierre,
                                   pnlUsd: p.pnlPublicadoUsd };
          const r = await intentarCerrar(L, vivo);
          res = r === 'DECISION'
            ? { estado: 'CIERRE_A_DECISION', id: vivo.id, motivo: `nuestro cierre es ${Math.round(vivo.decision.pct * 100)}% peor que el del profe: decide Guillermo` }
            : { estado: r === 'CERRADA' ? 'CIERRE_DEMO' : 'CIERRE_PENDIENTE', id: vivo.id, motivo: vivo.ultimoIntento || null };
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
        else if (t.estado === 'pendiente_ajuste') { const r = await intentarAjuste(L, t); if (r !== 'ESPERA') cambios++; }
      }
      const hoy = calendario.fechaET(ahora());
      // Cierres esperando decisión: recordatorio a las 15:30 ET, una vez al día, si se pidió hace más de una hora.
      if (calendario.enHorarioDeMercado(ahora()) && calendario.minutosET(ahora()) >= HORA_RECORDATORIO) {
        for (const t of L.trades.filter((x) => x.estado === 'pendiente_decision' && x.decision)) {
          const d = t.decision;
          if (d.recordadoFecha === hoy || ahora() - new Date(d.pedidaAt) < 60 * 60000) continue;
          d.recordadoFecha = hoy;
          d.avisos = [...(d.avisos || []), { at: ahora().toISOString(), tipo: 'recordatorio' }];
          L.colaWs = L.colaWs || [];
          L.colaWs.push({ seq: (L.seqWs = (L.seqWs || 0) + 1), at: ahora().toISOString(), id: t.id, tipo: 'recordatorio' });
          try { await pedirDecision(sinClave(t), { clave: d.clave, recordatorio: true }); } catch (e) { d.errorAviso = e.message; }
          cambios++;
        }
      }
      // Margen del día: una vez, desde las 10:00 ET (la cadena ya está asentada)
      if (calendario.enHorarioDeMercado(ahora()) && calendario.minutosET(ahora()) >= 600 && (!L.margenDia || L.margenDia.fecha !== hoy)) {
        try { await recalcularMargenInterno(L); cambios++; } catch (e) { /* se reintenta el minuto siguiente */ }
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
    const abiertas = L.trades.filter((t) => ESTADOS_ABIERTOS.includes(t.estado));
    if (marcar && abiertas.length) {
      try {
        const syms = [...new Set(abiertas.flatMap((t) => t.patas.map((p) => p.sym)))];
        const c = await cotizar(syms, { permitirParcial: true });
        for (const t of abiertas) {
          const x = c ? netoCruzando(t.patas, c.q, 'cerrar') : null;
          const m = c ? netoAlMedio(t.patas, c.q, 'cerrar') : null;
          t.latenteCruzando = x == null ? null : r2(cajaDe(t) + x * 100 - feesEstimadas(t.patas, false));
          t.latenteMedio = m == null ? null : r2(cajaDe(t) + m * 100);
        }
      } catch (e) { /* sin marca: la pantalla muestra "sin precio" */ }
    }
    for (const t of abiertas) t.margenApartado = margenDe(t);
    const porProfe = {};
    for (const t of L.trades) {
      const e = porProfe[t.profe] = porProfe[t.profe] || { profe: t.profe, cerradas: 0, ganadas: 0, pnl: 0, abiertas: 0, vencidas: 0 };
      if (t.estado === 'cerrada') { e.cerradas++; if (t.pnlRealizado > 0) e.ganadas++; e.pnl = r2(e.pnl + t.pnlRealizado); }
      if (ESTADOS_ABIERTOS.includes(t.estado)) e.abiertas++;
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
      abiertas: abiertas.map(sinClave), pendientes: L.trades.filter((t) => t.estado === 'pendiente_entrada'),
      decisiones: L.trades.filter((t) => t.estado === 'pendiente_decision').map(sinClave),
      historial: L.trades.filter((t) => !ESTADOS_VIVOS.includes(t.estado)).map(sinClave)
        .sort((a, b) => String(b.cerradaAt).localeCompare(String(a.cerradaAt))),
      porProfe: Object.values(porProfe).sort((a, b) => b.pnl - a.pnl), curva,
      margenDia: L.margenDia || null,
      ajustes: L.trades.flatMap((t) => (t.ajustes || []).map((x) => ({ id: t.id, profe: t.profe, activo: t.activo, ...x })))
        .sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 50),
      alertas: L.alertas.slice(0, 50),
    };
  }

  // Reprograma una señal pendiente: no entra antes de `desde` y tiene 30 min desde ahí (Guillermo 18-nov: el IC de
  // SPX de Luis "después de las 10 am, cuando la cadena de opciones es más estable").
  function reprogramar(id, desde, motivo = '') {
    return enCola(async () => {
      const L = cargar();
      const t = L.trades.find((x) => x.id === id);
      if (!t) return { ok: false, motivo: `no existe ${id}` };
      if (t.estado !== 'pendiente_entrada') return { ok: false, motivo: `${id} está ${t.estado}, no pendiente` };
      const d = new Date(desde);
      if (isNaN(d)) return { ok: false, motivo: 'fecha "desde" inválida' };
      t.reprogramada = { at: ahora().toISOString(), venceAntes: t.venceAt, motivo: String(motivo).slice(0, 200) };
      t.noAntesDe = d.toISOString();
      t.venceAt = new Date(d.getTime() + sigma.VIDA_MIN * 60000).toISOString();
      guardar(L);
      return { ok: true, id, noAntesDe: t.noAntesDe, venceAt: t.venceAt };
    });
  }

  // ── Decisión de Guillermo sobre un cierre (19-nov-2026) ─────────────────────────────────────────────────────────
  // El link que le llega por WhatsApp/correo lleva el id y una clave de 32 hex propia de ese trade.
  const claveValida = (t, clave) => {
    const a = Buffer.from(String(t?.decision?.clave || '')), b = Buffer.from(String(clave || ''));
    return a.length === 32 && a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  // Para la página del link: el trade (sin clave) y, si hay cadena, lo que daría cerrar AHORA.
  async function verDecision(id, clave) {
    const t = cargar().trades.find((x) => x.id === id);
    if (!t || !claveValida(t, clave)) return { ok: false, motivo: 'link inválido o vencido' };
    let ahoraCierre = null;
    if (ESTADOS_ABIERTOS.includes(t.estado)) {
      try {
        const c = await cotizar(t.patas.map((p) => p.sym));
        const neto = c ? netoCruzando(t.patas, c.q, 'cerrar') : null;
        if (neto != null) ahoraCierre = { neto, pnlEstimado: r2(cajaDe(t) + neto * 100 - feesEstimadas(t.patas, false)),
                                          ...compararConProfe(t.cierrePublicado, neto) };
      } catch (e) { /* sin cadena: la página muestra el dato del aviso */ }
    }
    return { ok: true, trade: sinClave(t), ahoraCierre, mercadoAbierto: calendario.enHorarioDeMercado(ahora()) };
  }

  // accion: 'cerrar' (cierra ya, o al abrir el mercado) | 'mantener' (sigue abierta; el mismo link sirve para cerrar después).
  function decidir(id, clave, accion) {
    return enCola(async () => {
      const L = cargar();
      const t = L.trades.find((x) => x.id === id);
      if (!t || !claveValida(t, clave)) return { ok: false, motivo: 'link inválido o vencido' };
      const now = ahora().toISOString();
      if (accion === 'mantener') {
        if (t.estado !== 'pendiente_decision') return { ok: false, motivo: `la posición ya está ${t.estado}` };
        t.estado = 'abierta';
        Object.assign(t.decision, { accion: 'mantener', decididaAt: now });
        guardar(L);
        avisar(`${t.profe} · ${t.activo} ${t.estrategia}: Guillermo decidió MANTENERLA abierta`, '⏸️ Señales Sigma (demo)');
        return { ok: true, estado: 'MANTENIDA' };
      }
      if (accion !== 'cerrar') return { ok: false, motivo: 'acción desconocida' };
      if (!['pendiente_decision', 'abierta'].includes(t.estado)) return { ok: false, motivo: `la posición ya está ${t.estado}` };
      Object.assign(t.decision, { accion: 'cerrar', decididaAt: now });
      t.estado = 'pendiente_cierre';
      const r = await intentarCerrar(L, t);
      guardar(L);
      return r === 'CERRADA'
        ? { ok: true, estado: 'CERRADA', pnl: t.pnlRealizado, precio: t.salida.precio }
        : { ok: true, estado: 'CIERRE_PENDIENTE', motivo: t.ultimoIntento || 'se cierra en cuanto haya precio' };
    });
  }

  // Cola de WhatsApp: el lector del PC (que tiene GOWA) toma los avisos pendientes y los manda al chat de Guillermo.
  // `tomar` los marca como tomados en la misma operación (dos lectores no mandan el mismo aviso dos veces).
  function tomarAvisosWs() {
    return enCola(async () => {
      const L = cargar();
      const cola = (L.colaWs || []).filter((a) => !a.tomadoAt);
      const out = [];
      for (const a of cola) {
        const t = L.trades.find((x) => x.id === a.id);
        a.tomadoAt = ahora().toISOString();
        if (!t || !t.decision) continue;
        out.push({ seq: a.seq, tipo: a.tipo, trade: sinClave(t), clave: t.decision.clave });
      }
      L.colaWs = (L.colaWs || []).slice(-200);
      if (cola.length) guardar(L);
      return out;
    });
  }
  function devolverAvisoWs(seq) {
    return enCola(async () => {
      const L = cargar();
      const a = (L.colaWs || []).find((x) => x.seq === Number(seq));
      if (!a) return { ok: false };
      delete a.tomadoAt; a.reintentos = (a.reintentos || 0) + 1;
      guardar(L);
      return { ok: true };
    });
  }

  return { procesarAlerta, tick, importarDemoJson, resumen, recalcularMargen, reprogramar,
           verDecision, decidir, tomarAvisosWs, devolverAvisoWs, _cargar: cargar };
}

module.exports = { crearLibroSenales, netoCruzando, netoAlMedio, cuerpoOrden, feesEstimadas, pataDesdeOcc, cajaDe,
                   compararConProfe, CAPITAL, TOPE_MARGEN, UMBRAL_DECISION };
