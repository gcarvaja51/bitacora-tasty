'use strict';
// ── Clic en TradingView → vertical 0DTE del SPX en TastyTrade REAL (Guillermo 2026-10-19) ──
//
// "hagamos el mismo bot pero ahora vamos con valores reales y dinero real, vamos a hacerlo hacia tastytrade".
// Mismo camino que CLIC_TV (estructura y strikes de processDirectionalEntry sobre la cadena real de TastyTrade,
// ancho 5, credito >= 1.20 / debito <= 3.80, 1 contrato), pero la orden sale a la cuenta REAL en dos pasos:
//   1. preview  -> elige el vertical, cotiza y hace el dry-run en TastyTrade (no manda nada)
//   2. ejecutar -> solo despues de que Guillermo lo aprueba en el PC; recotiza y, si el precio no se movio de mas,
//                  manda una orden LIMITE al medio y la persigue de a 0.05 hasta el natural; si no llena, la cancela.
// Cierre con el clic (quedar plano en TradingView) o, como seguro, a las 15:30 ET. Freno diario de $400.
//
// CLIC_REAL_MODO (env): 'apagado' (default) | 'dryrun' (todo igual pero la orden va a /orders/dry-run y el fill se
// simula al precio limite) | 'real'. Nada sale a la cuenta hasta que se ponga 'real' a proposito.

const fs = require('fs');
const path = require('path');

const ACCION = {
  BULL_CALL_SPREAD: { tipo: 'C', credito: false, nombre: 'Bull Call Spread' },
  BEAR_PUT_SPREAD:  { tipo: 'P', credito: false, nombre: 'Bear Put Spread' },
  BULL_PUT_SPREAD:  { tipo: 'P', credito: true,  nombre: 'Bull Put Spread' },
  BEAR_CALL_SPREAD: { tipo: 'C', credito: true,  nombre: 'Bear Call Spread' },
};
const TICK = 0.05;
const r05 = (x, arriba) => +((arriba ? Math.ceil(x / TICK - 1e-9) : Math.floor(x / TICK + 1e-9)) * TICK).toFixed(2);
const fechaET = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function crearClicReal({ tt, dataDir, horaETmin, isMarketHours, obtenerSenal, avisar = () => {} }) {
  const ARCHIVO = path.join(dataDir, 'clic_real.json');
  const modo = () => String(process.env.CLIC_REAL_MODO || 'apagado').toLowerCase();
  // Real o demo por trade (Guillermo 2026-10-22: "un botón, última validación antes de enviar el trade, que me pregunte
  // si va por real o por demo"). CLIC_REAL_MODO pasa a ser el techo: 'dryrun' solo deja la demo; 'real' deja elegir
  // las dos en cada trade; 'apagado' ninguna. El modo de cada trade queda en su registro (rec.modo).
  const permitidos = () => modo() === 'real' ? ['real', 'dryrun'] : modo() === 'dryrun' ? ['dryrun'] : [];
  const soloDemo = () => permitidos().length === 1 && permitidos()[0] === 'dryrun';
  const frenoUsd = () => Number(process.env.CLIC_REAL_FRENO_USD || 400);
  // Varios contratos (2026-11-05, Guillermo: "que me permita poner 1, 2, 3, 5, 10 contratos... igual en el cierre"):
  // la cantidad sale de la del Paper Trading del US500; agregar va a los MISMOS strikes (precio promedio) y cerrar
  // puede ser parcial. Tope: 5 contratos ("3. 5 contratos").
  const maxContratos = () => Math.max(1, Number(process.env.CLIC_MAX_CONTRATOS || 5));
  const nContratos = (c) => Math.max(1, Math.min(maxContratos(), Math.round(Number(c) || 1)));
  // comisiones de los contratos que siguen abiertos (feesApertura queda como total pagado al abrir, para los informes)
  const feesAbiertas = (rec) => (rec.feesAbiertas ?? rec.feesApertura ?? 0);
  // Guillermo 2026-10-20: "no abre porque he perdido mucho, quita la restricción": el freno diario ya no frena la DEMO
  // (dryrun); sigue frenando la cuenta real (modo 'real') hasta que él diga otra cosa.
  const frenado = (m = 'real') => m === 'real' && pnlHoy('real') <= -frenoUsd();
  const tolPts = () => Number(process.env.CLIC_REAL_TOL_PTS || 0.15);
  const cuenta = () => process.env.CLIC_REAL_CUENTA || tt.accountNumber;
  // Cuenta demo (Guillermo 2026-10-19: "abramos una cuenta demo en tastytrade de 2000 dolares y la monitoreamos en la
  // bitacora"): en modo dryrun los trades se llevan contra un capital ficticio que arranca en CLIC_DEMO_DESDE.
  // Reinicio 2026-10-22 (Guillermo: "dejar en la sombra los trades demo hechos hasta ahora y reiniciar con 2000 dólares
  // desde hoy, esos trades eran los necesarios para afinar el algoritmo"): la demo nunca arranca antes de DEMO_REINICIO,
  // aunque CLIC_DEMO_DESDE en Railway diga una fecha anterior. Los de antes quedan como sombra (no se borran).
  // Reinicio 2026-11-05 (Guillermo: "vamos a reiniciar el demo, vamos a empezar de cero nuevamente... deja estos en la
  // sombra"): los 23 trades del 22-oct al 5-nov (-$418.88, saldo $1,581.12) pasan a la sombra; vuelve a $2,000.
  const DEMO_REINICIO = '2026-11-05T17:15:00Z';                   // 12:15 ET del 5-nov
  const demoCapital = () => Number(process.env.CLIC_DEMO_CAPITAL || 2000);
  const demoDesde = () => [process.env.CLIC_DEMO_DESDE || '', DEMO_REINICIO].sort().pop();
  const previews = new Map();
  let ocupado = false;

  // ── Sesión nocturna de práctica (Guillermo 2026-10-19: "solo para un tema didáctico, pongamos en demo después de las
  // 5 pm hora NY para que podamos hacer ejercicios"). Las opciones del SPX vuelven a cotizar en la sesión global de Cboe
  // (GTH, desde las 20:15 ET, con vencimiento del día hábil siguiente); entre 16:15 y 20:15 no hay precios. Solo en
  // modo dryrun: nunca sale una orden real de noche. El SPX contado no se mueve fuera de horario, así que el precio del
  // subyacente se saca de las opciones (paridad put-call en el strike ATM: S = K + C - P).
  const NOCHE_DESDE = 20 * 60 + 15, NOCHE_HASTA = 23 * 60 + 30;
  const diaSemET = () => new Date(fechaET() + 'T12:00:00Z').getUTCDay();          // 0 = domingo
  const nocturna = () => permitidos().includes('dryrun') && String(process.env.CLIC_NOCHE || 'on').toLowerCase() !== 'off'
    && diaSemET() <= 4 && horaETmin() >= NOCHE_DESDE && horaETmin() <= NOCHE_HASTA;  // domingo a jueves en la noche
  const proximoHabil = () => {
    for (let i = 1; i <= 5; i++) {
      const f = fechaET(new Date(Date.now() + i * 86400000));
      const w = new Date(f + 'T12:00:00Z').getUTCDay();
      if (w >= 1 && w <= 5) return f;
    }
    return null;
  };
  let cacheSint = { ts: 0, v: null };
  async function spxSintetico(vence) {
    if (Date.now() - cacheSint.ts < 15000 && cacheSint.v) return cacheSint.v;
    const exp = vence.replace(/-/g, '').slice(2);
    const occ = (t, k) => `SPXW  ${exp}${t}${String(Math.round(k * 1000)).padStart(8, '0')}`;
    let s = Number((await tt._req('/market-data?symbols[]=SPX'))?.data?.items?.[0]?.last) || null;
    if (!s) throw new Error('sin precio de referencia del SPX');
    for (let i = 0; i < 3; i++) {
      const k = Math.round(s / 5) * 5;
      const d = await tt._req(`/market-data?symbols[]=${encodeURIComponent(occ('C', k))}&symbols[]=${encodeURIComponent(occ('P', k))}`);
      const q = {};
      for (const it of d?.data?.items || []) q[it.symbol] = (Number(it.bid) + Number(it.ask)) / 2;
      const c = q[occ('C', k)], p = q[occ('P', k)];
      if (!Number.isFinite(c) || !Number.isFinite(p)) throw new Error('las opciones del SPX no cotizan ahora');
      s = +(k + c - p).toFixed(2);
      if (Math.abs(s - k) <= 2.5) break;
    }
    cacheSint = { ts: Date.now(), v: s };
    return s;
  }               // una orden a la vez: un segundo pedido mientras otro corre se rechaza

  const cargar = () => { try { return JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')); } catch (e) { return []; } };
  const guardar = (l) => fs.writeFileSync(ARCHIVO, JSON.stringify(l, null, 2), 'utf8');

  // ── Correcciones puntuales de fills demo (una sola vez, idempotente; queda el original en rec.correccion) ──
  // 2026-11-06 (Guillermo: "dale"): Bull Call 7415/7420 x2 cerrado a 2.40 por una pata atrasada (ver
  // teoricoSincronizado). SPX 7436.06 al cerrar: Black-Scholes 2.86-3.07 (IV 14-22 %); 2.90 justo - 0.05 de la regla
  // demo = 2.85. Solo se aplica si el registro sigue con los valores originales.
  const CORRECCIONES = [
    { id: 'cr-1793976369118', modo: 'dryrun', antes: { precioSalida: 2.4, pnlUsd: -53.76 }, salida: 2.85,
      motivo: 'fill demo de cierre con una pata atrasada (SPX 7443->7431 en el minuto); 2.40 corregido a 2.85 (teorico 2.90 - 0.05)' },
  ];
  (function aplicarCorrecciones() {
    try {
      const l = cargar();
      let cambio = false;
      for (const c of CORRECCIONES) {
        const r = l.find((x) => x.id === c.id && x.modo === c.modo && x.estado === 'cerrada');
        if (!r || r.correccion || r.precioSalida !== c.antes.precioSalida || r.pnlUsd !== c.antes.pnlUsd) continue;
        const fees = (r.feesApertura || 0) + (r.feesCierre || 0);
        const bruto = Math.round((r.credito ? r.precioEntrada - c.salida : c.salida - r.precioEntrada) * 100 * r.contratos);
        r.correccion = { en: new Date().toISOString(), motivo: c.motivo, precioSalidaOriginal: r.precioSalida,
                         pnlBrutoOriginal: r.pnlBrutoUsd, pnlUsdOriginal: r.pnlUsd };
        r.precioSalida = c.salida;
        r.pnlBrutoUsd = bruto;
        r.pnlUsd = +(bruto - fees).toFixed(2);
        cambio = true;
        console.log(`[clic_real] corrección ${c.id}: salida ${r.correccion.precioSalidaOriginal} -> ${c.salida}, neto ${r.correccion.pnlUsdOriginal} -> ${r.pnlUsd}`);
      }
      if (cambio) guardar(l);
    } catch (e) { console.warn('[clic_real] correcciones:', e.message); }
  })();
  // Ranuras (Guillermo 2026-10-20: "ajusta para que me permita abrir el IB adicional a la posición que tengo"):
  // 'principal' = la del clic de TradingView (vertical, o IB con BUY de 2 desde plano) y 'adicional' = el Iron Butterfly
  // que se abre con el botón IB del gráfico, sin tocar la posición de Paper Trading. Una posición por ranura.
  // una posición por ranura, sea real o demo (2026-10-22: el modo ya no es global sino de cada trade)
  const enCurso = (x) => x.estado === 'abierta' || x.estado === 'cerrando';
  const abierta = (ranura = 'principal') => cargar().find((x) => enCurso(x) && (x.ranura || 'principal') === ranura);
  const abiertas = () => cargar().filter(enCurso);

  // patas: [{ sym, lado }] con lado +1 = comprada, -1 = vendida (vertical: 2 patas; Iron Butterfly: 4). Los registros
  // de antes del 2026-10-19 traen { comprada, vendida } y se convierten aca.
  const patas = (legs) => Array.isArray(legs) ? legs : [{ sym: legs.comprada, lado: 1 }, { sym: legs.vendida, lado: -1 }];

  // cotizacion de la estructura: solo sus patas, directo de TastyTrade /market-data (< 1 s; la cadena entera ~35 s).
  // Todo en "valor de comprar la estructura": positivo = debito, negativo = credito.
  async function cotizar(legs) {
    const L = patas(legs);
    const d = await tt._req(`/market-data?${L.map((x) => `symbols[]=${encodeURIComponent(x.sym)}`).join('&')}`);
    const q = {};
    for (const it of d?.data?.items || []) q[it.symbol] = { bid: Number(it.bid), ask: Number(it.ask), delta: Number(it.delta || 0), iv: Number(it.volatility),
                                                         ts: Date.parse(it['updated-at']) || null };
    let medio = 0, compraNat = 0, ventaNat = 0, deltaNeto = 0;
    const patasQ = [];     // por pata: strike, tipo, lado, medio, iv y hora de la cotización (para teoricoSincronizado)
    const ivs = L.map((x) => q[x.sym]?.iv).filter((v) => Number.isFinite(v) && v > 0);
    const iv = ivs.length ? +(ivs.reduce((a, b) => a + b, 0) / ivs.length).toFixed(4) : null;
    const vendidas = [];   // Guillermo 2026-10-20: "solo el delta de la put o call vendida" (el IB trae dos)
    for (const x of L) {
      const c = q[x.sym];
      if (!c || !Number.isFinite(c.bid) || !Number.isFinite(c.ask)) throw new Error(`sin cotizacion de ${x.sym}`);
      if (x.lado < 0) {
        const m = /([CP])(\d{8})$/.exec(String(x.sym).trim());
        vendidas.push({ tipo: m ? (m[1] === 'C' ? 'call' : 'put') : null, strike: m ? Number(m[2]) / 1000 : null, delta: +c.delta.toFixed(3) });
      }
      medio += x.lado * (c.bid + c.ask) / 2;
      {
        const m = /([CP])(\d{8})$/.exec(String(x.sym).trim());
        const f = /(\d{6})[CP]\d{8}$/.exec(String(x.sym).trim());
        if (m) patasQ.push({ tipo: m[1], strike: Number(m[2]) / 1000, lado: x.lado, medio: (c.bid + c.ask) / 2, iv: c.iv, ts: c.ts,
                             vence: f ? `20${f[1].slice(0, 2)}-${f[1].slice(2, 4)}-${f[1].slice(4, 6)}` : null });
      }
      // compraNat: abrir ya (lo comprado al ask, lo vendido al bid); en un credito, -compraNat es lo que se cobra al
      // abrir ya. ventaNat: deshacer ya (lo comprado al bid, lo vendido al ask); en un credito, -ventaNat es lo que
      // cuesta recomprarlo ya.
      compraNat += x.lado > 0 ? c.ask : -c.bid;
      ventaNat += x.lado > 0 ? c.bid : -c.ask;
      deltaNeto += x.lado * c.delta;
    }
    const res = { medio: +medio.toFixed(2), compraNat: +compraNat.toFixed(2), ventaNat: +ventaNat.toFixed(2), deltaNeto: +deltaNeto.toFixed(3), vendidas, iv,
                  patas: patasQ };
    try { registrarCalib(L, res); } catch (e) { /* solo calibración */ }
    return res;
  }

  // ── Valor teórico SINCRONIZADO de la estructura (2026-11-06, Guillermo: "hice una posición que pensaba estaba en
  // positivo y me la reporta en negativo"). Bull Call 7415/7420 x2: el SPX subió 12 pts (7423.8 -> 7436.1) y la demo
  // la cerró a 2.40 contra 2.60 de entrada (-$53.76); con el SPX en 7436 valía ~2.85-3.05. En ese minuto el SPX tocó
  // 7443 y cayó a 7431, y /market-data trae cada pata con su propia hora: una pata ya con la caída y la otra todavía
  // arriba dan un medio del spread que no existió. Arreglo: de la pata cotizada MÁS RECIENTE se despeja el SPX que su
  // precio implica (con su propia IV, que ya trae la sonrisa) y TODAS las patas se revalúan con Black-Scholes a ese
  // mismo SPX. Devuelve null si no se puede (sin IV, sin hora, pata casi sin delta).
  const Nc = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
  function bs(tipo, S, K, T, v) {
    const sT = v * Math.sqrt(T), d1 = (Math.log(S / K) + 0.5 * v * v * T) / sT, d2 = d1 - sT;
    return tipo === 'C' ? { p: S * Nc(d1) - K * Nc(d2), d: Nc(d1) } : { p: K * Nc(-d2) - S * Nc(-d1), d: Nc(d1) - 1 };
  }
  // años (calendario, como la IV de TastyTrade) hasta las 16:00 ET del vencimiento
  function aniosAlVence(vence) {
    if (!vence) return null;
    const guess = Date.parse(`${vence}T21:00:00Z`);
    const hET = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date(guess)));
    const fin = guess + (16 - hET) * 3600000;
    const T = (fin - Date.now()) / (365 * 86400000);
    return T > 60 / (365 * 86400) ? T : null;        // menos de 1 min al vencimiento: sin modelo
  }
  function teoricoSincronizado(q, vence) {
    const L = q && q.patas;
    const T = aniosAlVence(vence || (L && L[0] && L[0].vence));
    if (!T || !L || L.length < 2 || L.some((x) => !(x.iv > 0) || !x.ts || !(x.medio > 0))) return null;
    const fresca = L.reduce((a, b) => (b.ts > a.ts ? b : a));
    let S = fresca.strike;
    for (let i = 0; i < 30; i++) {                     // Newton: S tal que BS(S) = medio de la pata fresca
      const r = bs(fresca.tipo, S, fresca.strike, T, fresca.iv);
      if (Math.abs(r.d) < 0.03 || Math.abs(r.d) > 0.97) return null;   // casi sin delta: el SPX implícito no es confiable
      const paso = (r.p - fresca.medio) / r.d;
      S -= Math.max(-50, Math.min(50, paso));
      if (Math.abs(paso) < 1e-4) break;
    }
    if (!Number.isFinite(S)) return null;
    const v = L.reduce((a, x) => a + x.lado * bs(x.tipo, S, x.strike, T, x.iv).p, 0);
    const ts = L.map((x) => x.ts);
    return { valor: +v.toFixed(3), spxImplicito: +S.toFixed(2), desfaseSeg: +((Math.max(...ts) - Math.min(...ts)) / 1000).toFixed(1) };
  }
  // tolerancia entre el medio de mercado y el teórico sincronizado antes de corregir el fill demo
  const tolTeo = () => Number(process.env.CLIC_DEMO_TOL_TEO || 0.35);
  // Sesgo fijo modelo-mercado (medido en vivo el 6-nov): con las patas frescas (desfase 0,5 s) el Bull Call ATM da
  // medio 2.95 y teórico 2.64; en puts ~0. La IV de TastyTrade no reproduce exacto el medio de cada pata. Por eso el
  // teórico nunca se usa solo: se le suma el sesgo (medio - teórico) medido en lecturas FRESCAS (desfase <= 1 s) de las
  // mismas patas en los últimos 2 min (la tabla del trade cotiza cada ~2 s, el preview y la ejecución también).
  const DESFASE_FRESCO = 1.0;
  const calib = new Map();          // clave de patas -> [{ ts, off }]
  const clavePatas = (legs) => patas(legs).map((x) => `${x.lado}${x.sym}`).join('|');
  function registrarCalib(legs, q) {
    const t = teoricoSincronizado(q);
    if (!t || t.desfaseSeg > DESFASE_FRESCO) return;
    const k = clavePatas(legs), ahora = Date.now();
    const l = (calib.get(k) || []).filter((x) => ahora - x.ts <= 120000);
    l.push({ ts: ahora, off: q.medio - t.valor });
    calib.set(k, l.slice(-60));
    if (calib.size > 50) for (const [kk, v] of calib) if (!v.some((x) => ahora - x.ts <= 120000)) calib.delete(kk);
  }
  function sesgoCalib(legs) {
    const ahora = Date.now();
    const l = (calib.get(clavePatas(legs)) || []).filter((x) => ahora - x.ts <= 120000);
    return l.length ? mediana(l.map((x) => x.off)) : null;
  }

  // Cotizacion estable para los PRECIOS QUE VE GUILLERMO (2026-11-05): mediana de `n` lecturas separadas ~300 ms.
  // Con una sola lectura la ventana ofrecio el Bear Put protegido 7390/7385 a 1.25 y el ATM 7385/7380 a 3.80 (al
  // reves de lo posible); al ejecutar se recotizo a 2.40 y luego 2.70 y pidio validar dos veces.
  async function cotizarEstable(legs, n = 3) {
    const l = [];
    for (let i = 0; i < n; i++) {
      try { l.push(await cotizar(legs)); } catch (e) { if (i === n - 1 && !l.length) throw e; }
      if (i < n - 1) await dormir(300);
    }
    const med = (k) => +mediana(l.map((q) => q[k])).toFixed(2);
    const ult = l[l.length - 1];
    return { ...ult, medio: med('medio'), compraNat: med('compraNat'), ventaNat: med('ventaNat') };
  }

  // P&L abierto estable (2026-11-05, Guillermo: "veo unos saltos raros en el p&l"). Bear Put 7455/7450 con el SPX
  // cayendo 50 pts: cada pata tiene delta ~-0.58 ($58/pt) pero el spread ~$2/pt, y /market-data trae cada pata con su
  // propia hora (4 s de desfase medido). Con el SPX moviéndose rápido eso daba saltos de -$171 a +$138 entre lecturas
  // de 5 s. Arreglo: (1) el valor de la estructura se acota a lo que puede valer [0, ancho]; (2) mediana de las lecturas
  // de los últimos 20 s. El P&L principal va al MEDIO (como el P/L de TastyTrade); el natural se da aparte como
  // "si cierras ya".
  const lecturas = new Map();   // rec.id -> [{ ts, medio, ventaNat }]
  const mediana = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  function valorEstable(rec, q) {
    const n = rec.contratos || 1;
    const tope = rec.riesgoMaxUsd != null && rec.gananciaMaxUsd != null ? (rec.riesgoMaxUsd + rec.gananciaMaxUsd) / (100 * n) : null;
    // en "valor de comprar la estructura": debito >= 0, credito <= 0
    const acota = (v) => (tope == null ? v : rec.credito ? Math.min(0, Math.max(-tope, v)) : Math.max(0, Math.min(tope, v)));
    const ahora = Date.now();
    const l = (lecturas.get(rec.id) || []).filter((x) => ahora - x.ts <= 20000);
    l.push({ ts: ahora, medio: acota(q.medio), ventaNat: acota(q.ventaNat) });
    lecturas.set(rec.id, l);
    for (const k of [...lecturas.keys()]) if (k !== rec.id && !(lecturas.get(k) || []).some((x) => ahora - x.ts <= 60000)) lecturas.delete(k);
    return { medio: mediana(l.map((x) => x.medio)), ventaNat: mediana(l.map((x) => x.ventaNat)), n: l.length };
  }

  function cuerpoOrden(rec, precio, abrir) {
    const credito = rec.credito;
    // abrir debito = Debit; abrir credito = Credit; cerrar al reves
    const efecto = (abrir ? !credito : credito) ? 'Debit' : 'Credit';
    return {
      'time-in-force': 'Day', 'order-type': 'Limit', price: Math.abs(precio).toFixed(2), 'price-effect': efecto,
      legs: patas(rec.legs).map((x) => ({
        'instrument-type': 'Equity Option', symbol: x.sym, quantity: rec.contratos,
        action: x.lado > 0 ? (abrir ? 'Buy to Open' : 'Sell to Close') : (abrir ? 'Sell to Open' : 'Buy to Close'),
      })),
    };
  }

  async function dryRun(cuerpo) {
    return tt._req(`/accounts/${cuenta()}/orders/dry-run`, { method: 'POST', body: JSON.stringify(cuerpo) });
  }

  function precioLleno(o, rec) {
    let neto = 0, n = 0;
    for (const l of o.legs || []) for (const f of l.fills || []) {
      const v = Number(f['fill-price']) * Number(f.quantity);
      neto += /^Buy/.test(l.action) ? v : -v; n++;
    }
    return n ? +(Math.abs(neto) / rec.contratos).toFixed(2) : null;
  }
  const leerOrden = async (id) => (await tt._req(`/accounts/${cuenta()}/orders/${id}`))?.data || {};

  // medio de la estructura para el fill simulado, en precio positivo (débito pagado / crédito cobrado): mediana de 4
  // lecturas en ~1,2 s, más el medio del preview al abrir y las lecturas de los últimos 20 s de la tabla al cerrar.
  async function medioDemo(rec, abrir) {
    const n = rec.contratos || 1;
    const tope = rec.ancho || (rec.riesgoMaxUsd != null && rec.gananciaMaxUsd != null ? (rec.riesgoMaxUsd + rec.gananciaMaxUsd) / (100 * n) : null);
    const pos = (v) => { const x = rec.credito ? -v : v; return tope ? Math.max(0, Math.min(tope, x)) : Math.max(0, x); };
    const crudas = [];
    for (let i = 0; i < 4; i++) {
      try { const q = await cotizar(rec.legs); crudas.push({ q, t: teoricoSincronizado(q, rec.vence) }); } catch (e) { /* una lectura menos */ }
      if (i < 3) await dormir(400);
    }
    // 2026-11-06: una lectura con las patas desfasadas (> 1 s) y cuyo medio se aleja más de la tolerancia del teórico
    // sincronizado + sesgo trae una pata atrasada -> vale el teórico + sesgo. Sin sesgo medido, solo se corrige si el
    // desvío es grande (2x la tolerancia) y se usa el teórico solo. Las lecturas frescas valen tal cual.
    const sesgo = sesgoCalib(rec.legs);           // ya incluye las lecturas frescas de este mismo lote
    const vals = [], refs = [], detalle = [];
    let corregidas = 0;
    for (const { q, t } of crudas) {
      const mkt = pos(q.medio);
      const ref = t ? pos(t.valor + (sesgo ?? 0)) : null;
      const desf = t ? t.desfaseSeg : null;
      const malo = ref != null && desf > DESFASE_FRESCO && Math.abs(mkt - ref) > (sesgo == null ? 2 : 1) * tolTeo();
      if (ref != null && sesgo != null) refs.push(ref);
      if (malo) corregidas++;
      vals.push(malo ? ref : mkt);
      detalle.push({ mkt: +mkt.toFixed(2), ref: ref == null ? null : +ref.toFixed(2), spx: t ? t.spxImplicito : null, desfaseSeg: desf });
    }
    // el precio del preview (al abrir) y las lecturas de la tabla (al cerrar) solo entran si son coherentes con el
    // teórico + sesgo (o, sin referencia, con la mediana de las lecturas de ahora)
    const teoMed = refs.length ? mediana(refs) : (vals.length ? mediana(vals) : null);
    const ok = (v) => teoMed == null || Math.abs(v - teoMed) <= tolTeo();
    const extras = [];
    if (abrir && Number.isFinite(rec.precioMedio)) extras.push(rec.precioMedio);
    if (!abrir && rec.id) for (const x of (lecturas.get(rec.id) || [])) if (Date.now() - x.ts <= 20000) extras.push(rec.credito ? -x.medio : x.medio);
    const descartadas = extras.filter((v) => !ok(v)).length;
    vals.push(...extras.filter(ok));
    const valor = vals.length ? mediana(vals) : null;
    ultimoAjusteDemo = { en: new Date().toISOString(), abrir, valor, referencia: teoMed, sesgo: sesgo == null ? null : +sesgo.toFixed(3),
                         corregidas, descartadas, lecturas: detalle };
    return valor;
  }
  let ultimoAjusteDemo = null;

  // manda la orden y la persigue: precios = [medio, ..., natural]. Devuelve {lleno, precio, orderId} o {lleno:false}
  async function mandarYPerseguir(rec, precios, abrir, esperaMs = 8000) {
    // comisiones que TastyTrade calcula para esta orden (dry-run); se descuentan del P&L (2026-10-19). En la apertura
    // ya vienen del dry-run del preview (rec.feesConocidas): no se repite esa llamada (2026-10-20, meta de 5 s)
    const fees = rec.feesConocidas != null ? Number(rec.feesConocidas)
      : Number((await dryRun(cuerpoOrden(rec, precios[0], abrir)))?.data?.['fee-calculation']?.['total-fees'] || 0);
    if (rec.modo !== 'real') {          // solo un registro marcado 'real' manda órdenes; cualquier otro se simula
      // demo (Guillermo 2026-10-19): llena al medio + 0.05 en contra (el segundo escalon), un deslizamiento tipico
      // de los spreads 0DTE del SPX; si el natural esta al medio, al natural.
      // 2026-11-05: el medio sale de la MEDIANA de varias lecturas (ver medioDemo), no de una sola. Con las patas
      // cotizadas a horas distintas, el Bear Put 7460/7455 ofrecido a 1.95 se "llenó" a 1.35 y el 7415/7410 ofrecido a
      // 2.30 a 1.35: la demo regalaba o quitaba $60-100 por trade que en la real no existen.
      let precio = precios[Math.min(1, precios.length - 1)];
      ultimoAjusteDemo = null;
      try {
        const m = await medioDemo(rec, abrir);
        if (m != null) {
          // abrir: se paga más / se cobra menos; cerrar: se cobra menos / se paga más
          const contra = abrir ? (rec.credito ? -TICK : TICK) : (rec.credito ? TICK : -TICK);
          precio = Math.max(TICK, r05(m + contra, contra > 0));
        }
      } catch (e) { /* sin cotizacion: la escalera de siempre */ }
      return { lleno: true, precio, orderId: 'DRYRUN', simulado: true, fees, fillDemo: ultimoAjusteDemo };
    }
    let orderId = null;
    for (let i = 0; i < precios.length; i++) {
      const cuerpo = cuerpoOrden(rec, precios[i], abrir);
      if (!orderId) {
        const r = await tt._req(`/accounts/${cuenta()}/orders`, { method: 'POST', body: JSON.stringify(cuerpo) });
        orderId = r?.data?.order?.id;
        if (!orderId) throw new Error('TastyTrade no devolvio id de orden');
        console.log(`[CLIC_REAL] orden ${orderId} ${abrir ? 'apertura' : 'cierre'} a ${precios[i]}`);
      } else {
        try {   // subir/bajar el precio = reemplazar la orden (TastyTrade le da id nuevo)
          const r = await tt._req(`/accounts/${cuenta()}/orders/${orderId}`, { method: 'PUT', body: JSON.stringify(cuerpo) });
          orderId = r?.data?.order?.id || r?.data?.id || orderId;
          console.log(`[CLIC_REAL] orden ${orderId} reemplazada a ${precios[i]}`);
        } catch (e) {
          const o = await leerOrden(orderId);          // si ya se lleno, el reemplazo falla: se toma el fill
          if (o.status === 'Filled') return { lleno: true, precio: precioLleno(o, rec) ?? precios[i - 1], orderId, fees };
          throw e;
        }
      }
      const fin = Date.now() + esperaMs;
      while (Date.now() < fin) {
        await dormir(1500);
        const o = await leerOrden(orderId);
        if (o.status === 'Filled') return { lleno: true, precio: precioLleno(o, rec) ?? precios[i], orderId, fees };
        if (['Rejected', 'Cancelled', 'Expired'].includes(o.status)) {
          return { lleno: false, orderId, motivo: `orden ${o.status}${o['reject-reason'] ? ': ' + o['reject-reason'] : ''}` };
        }
      }
    }
    try { await tt._req(`/accounts/${cuenta()}/orders/${orderId}`, { method: 'DELETE' }); } catch (e) { /* ya se lleno o murio */ }
    await dormir(1500);
    const o = await leerOrden(orderId);                 // pudo llenarse justo al cancelar
    if (o.status === 'Filled') return { lleno: true, precio: precioLleno(o, rec) ?? precios[precios.length - 1], orderId, fees };
    return { lleno: false, orderId, motivo: 'no se lleno persiguiendo hasta el natural; cancelada' };
  }

  function cuentaDemo() {
    const desde = demoDesde();
    const l = cargar().filter((x) => x.modo === 'dryrun' && x.abiertaEn >= desde && x.estado !== 'no_llenada').reverse();
    const cerr = l.filter((x) => x.estado === 'cerrada' && x.pnlUsd != null);
    const abiertos = l.filter((x) => x.estado === 'abierta' || x.estado === 'cerrando');
    // lo realizado incluye los cierres parciales de los clics que siguen abiertos (2026-11-05)
    const realizado = cerr.reduce((a, x) => a + x.pnlUsd, 0) + abiertos.reduce((a, x) => a + (x.pnlParcialUsd || 0), 0);
    const reservado = abiertos.reduce((a, x) => a + (x.riesgoMaxUsd || 0) + 2 * feesAbiertas(x), 0);
    let eq = demoCapital(), pico = eq, dd = 0;
    const curva = [{ t: desde, saldo: eq }];
    for (const x of cerr) { eq += x.pnlUsd; pico = Math.max(pico, eq); dd = Math.max(dd, pico - eq); curva.push({ t: x.cerradaEn, saldo: +eq.toFixed(2) }); }
    const saldo = +(demoCapital() + realizado).toFixed(2);
    return { capital: demoCapital(), desde, saldo, disponible: +(saldo - reservado).toFixed(2), reservado: +reservado.toFixed(2),
             realizado: +realizado.toFixed(2), maxDrawdown: +dd.toFixed(2), curva, trades: l, abiertos };
  }

  function pnlHoy(m = 'real') {
    const hoy = fechaET();
    // solo los del modo pedido: las pruebas en dry-run no cuentan para el freno del dinero real
    return cargar().filter((x) => x.fecha === hoy && x.pnlUsd != null && x.modo === m).reduce((a, x) => a + x.pnlUsd, 0);
  }

  // ventana de clics: la regular (9:31-15:15 ET) o, en demo, la nocturna de práctica (20:15-23:30 ET)
  // m = modo del trade; en el preview, antes de elegir, se usa el más amplio de los permitidos
  const modoAmplio = () => permitidos().includes('dryrun') ? 'dryrun' : 'real';
  function fueraDeVentana(m = modoAmplio()) {
    if (nocturna()) return m === 'real' ? 'la práctica nocturna es solo en demo' : null;
    if (!isMarketHours()) return 'mercado cerrado (práctica nocturna en demo: 20:15-23:30 ET, domingo a jueves)';
    const t = horaETmin();
    // Guillermo 2026-10-20 ("quita la restricción, para ver cómo nos va"): en la DEMO se puede abrir hasta las 15:55 ET
    // (las 0DTE vencen a las 16:00); en la cuenta real sigue 9:31-15:15
    const hasta = m === 'dryrun' ? 15 * 60 + 55 : 15 * 60 + 15;
    if (t < 9 * 60 + 31 || t > hasta) return `fuera de la ventana de clics ${m === 'dryrun' ? 'demo' : 'real'} (9:31-${m === 'dryrun' ? '15:55' : '15:15'} ET; práctica nocturna en demo: 20:15-23:30 ET)`;
    return null;
  }

  async function preview(direccion, contratos = 1) {
    if (!permitidos().length) return { ok: false, error: 'clic real apagado (CLIC_REAL_MODO)' };
    const nC = nContratos(contratos);
    const fuera = fueraDeVentana();
    if (fuera) return { ok: false, error: fuera };
    const noche = nocturna();
    if (abierta()) return { ok: false, error: 'ya hay un clic abierto (real o demo): hay que cerrarlo primero' };
    // el freno de la real y el saldo de la demo se miran al ejecutar, cuando ya se eligió el modo; si solo hay demo, acá
    if (soloDemo() && cuentaDemo().disponible < 100) return { ok: false, error: `cuenta demo sin saldo disponible ($${cuentaDemo().disponible})` };
    let out;
    if (noche) {
      // de noche no corre el motor de la Bitácora (sin contexto del SPX contado): débito ATM, como el clic de día en
      // tendencia (Bull Call / Bear Put), vencimiento del día hábil siguiente
      const vence = proximoHabil();
      const spxN = await spxSintetico(vence);
      const atmN = Math.round(spxN / 5) * 5;
      const alc = direccion === 'BULLISH';
      out = { signal: { strategy: alc ? 'BULL_CALL_SPREAD' : 'BEAR_PUT_SPREAD',
                        strikes: { expiry: vence, shortStrike: atmN, longStrike: alc ? atmN - 5 : atmN + 5 } },
              ctx: { spxPrice: spxN } };
    } else {
      var _ts = Date.now();
      out = await obtenerSenal(direccion);
      var _senalMs = Date.now() - _ts;
    }
    const sig = out.signal;
    if (!sig?.strikes) return { ok: false, error: out.reason || 'no se pudo armar el vertical' };
    const a = ACCION[sig.strategy];
    if (!a) return { ok: false, error: `estructura no soportada: ${sig.strategy}` };
    const k = sig.strikes;
    const exp = k.expiry.replace(/-/g, '').slice(2);
    const occ = (strike) => `SPXW  ${exp}${a.tipo}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
    const ancho = Math.abs(k.shortStrike - k.longStrike) || 5;
    // Dos opciones para la pata VENDIDA (Guillermo 2026-10-19): "at the money" (el strike mas cercano al precio) o
    // "a 5 puntos del precio" del lado fuera del dinero (calls arriba, puts abajo): mas protegido, menos credito /
    // debito mas barato. La estructura (credito o debito) la sigue eligiendo la Bitacora; la comprada va a +-ancho.
    const spx = out.ctx?.spxPrice ?? null;
    const atm = Math.round((spx || (k.shortStrike + k.longStrike) / 2) / 5) * 5;
    // 2026-11-05 (Guillermo: "el objetivo de estar a 5 puntos es estar un poco mas protegidos... hagamos el cambio"):
    // en un CREDITO, alejar la vendida fuera del dinero protege; en un DEBITO hacia lo contrario (Bear Put 7400/7395
    // con el SPX en 7400: mas barato pero necesita mas caida). En el debito la opcion protegida va 5 pts DENTRO del
    // dinero (Bear Put 7410/7405, Bull Call 7390/7395): cuesta mas y gana menos, pero gana con el SPX quieto.
    const otm = (a.tipo === 'C' ? 5 : -5) * (a.credito ? 1 : -1);
    const lejos = (corto) => (a.tipo === 'C') === a.credito ? corto + ancho : corto - ancho;   // la comprada
    const armar = async (clave, etiqueta, corto) => {
      const largo = lejos(corto);
      const rec = { credito: a.credito, contratos: nC, legs: { comprada: occ(largo), vendida: occ(corto) } };
      const q = await cotizarEstable(rec.legs);
      const precioMedio = a.credito ? r05(-q.medio, false) : r05(q.medio, true);
      const dr = await dryRun(cuerpoOrden(rec, precioMedio, true));
      const v = {
        id: 'pv-' + Date.now() + '-' + clave, creado: Date.now(), direccion, estrategia: sig.strategy, nombre: a.nombre,
        credito: a.credito, legs: rec.legs, contratos: nC, vence: k.expiry, corto, largo, ancho, ubicacion: clave, etiqueta,
        precioMedio, natural: a.credito ? r05(-q.compraNat, false) : r05(q.compraNat, true), deltaNeto: q.deltaNeto,
        spx, sesion: noche ? 'nocturna' : 'regular', bp: dr?.data?.['buying-power-effect']?.['change-in-buying-power'] ?? null,
        fees: dr?.data?.['fee-calculation']?.['total-fees'] ?? null, avisosDryRun: dr?.data?.warnings || [],
      };
      v.riesgoMaxUsd = Math.round((v.credito ? ancho - precioMedio : precioMedio) * 100 * nC);
      v.gananciaMaxUsd = Math.round((v.credito ? precioMedio : ancho - precioMedio) * 100 * nC);
      // mismas reglas del clic: credito >= 1.20 / debito <= 3.80; si no cumple, la opcion no se ofrece
      if (v.credito ? precioMedio < 1.20 - 1e-9 : precioMedio > 3.80 + 1e-9) {
        v.noCumple = v.credito ? `crédito $${precioMedio.toFixed(2)} < $1.20` : `débito $${precioMedio.toFixed(2)} > $3.80`;
      }
      if (!v.noCumple && v.riesgoMaxUsd > cuentaDemo().disponible) {
        if (soloDemo()) v.noCumple = 'no cabe en el saldo de la cuenta demo';
        else v.noCabeDemo = `no cabe en el saldo de la demo ($${cuentaDemo().disponible})`;   // sí puede ir por real
      }
      previews.set(v.id, v);
      return v;
    };
    // las dos en paralelo (2026-10-20, meta de 5 s del clic a la orden): cada una cotiza y hace su dry-run
    const _tv = Date.now();
    const variantes = await Promise.all([armar('ATM', 'At the money', atm), armar('OTM5', 'A 5 puntos del precio', atm + otm)]);
    const tiempos = { ...(out.diag || {}), senalMs: typeof _senalMs === 'number' ? _senalMs : null, variantesMs: Date.now() - _tv };
    for (const [kk, v] of previews) if (Date.now() - v.creado > 6 * 3600 * 1000) previews.delete(kk);
    if (variantes.every((v) => v.noCumple)) {
      return { ok: false, error: `ninguna opcion cumple las reglas del clic (ATM: ${variantes[0].noCumple}; a 5 pts: ${variantes[1].noCumple})` };
    }
    const p = variantes.find((v) => !v.noCumple);
    return { ok: true, modo: modo(), modosPermitidos: permitidos(), cuenta: cuenta(), preview: p, variantes, venceEnSeg: null, tiempos };
  }

  // Iron Butterfly (Guillermo 2026-10-19: "IB pero que yo decida el strike y las alas"): vende put y call en el centro y
  // compra las alas a +-alas, 0DTE, 1 contrato. Credito; riesgo maximo = alas - credito.
  async function previewIB(centro, alas, ranura = 'principal') {
    if (!permitidos().length) return { ok: false, error: 'clic real apagado (CLIC_REAL_MODO)' };
    const fuera = fueraDeVentana();
    if (fuera) return { ok: false, error: fuera };
    const noche = nocturna();
    centro = Math.round(Number(centro) / 5) * 5; alas = Math.round(Number(alas) / 5) * 5;
    if (!(centro > 1000) || !(alas >= 5 && alas <= 100)) return { ok: false, error: `centro ${centro} / alas ${alas} invalidos (alas de 5 a 100, multiplo de 5)` };
    if (abierta(ranura)) return { ok: false, error: ranura === 'adicional' ? 'ya hay un IB adicional abierto: hay que cerrarlo primero'
                                                                      : 'ya hay un clic abierto (real o demo): hay que cerrarlo primero' };
    const vence = noche ? proximoHabil() : fechaET();
    const exp = vence.replace(/-/g, '').slice(2);
    const occ = (t, k) => `SPXW  ${exp}${t}${String(Math.round(k * 1000)).padStart(8, '0')}`;
    const legs = [{ sym: occ('P', centro), lado: -1 }, { sym: occ('C', centro), lado: -1 },
                  { sym: occ('P', centro - alas), lado: 1 }, { sym: occ('C', centro + alas), lado: 1 }];
    const rec = { credito: true, contratos: 1, legs };
    const q = await cotizarEstable(legs);
    if (q.medio >= 0) return { ok: false, error: 'el Iron Butterfly no da credito con esos strikes' };
    const precioMedio = r05(-q.medio, false);
    const dr = await dryRun(cuerpoOrden(rec, precioMedio, true));
    let spx = null;
    try { spx = noche ? await spxSintetico(vence) : (await tt._req('/market-data?symbols[]=SPX'))?.data?.items?.[0]?.last ?? null; } catch (e) { /* informativo */ }
    const p = {
      id: 'pv-' + Date.now(), creado: Date.now(), direccion: 'NEUTRAL', estrategia: 'IRON_BUTTERFLY', estructura: 'IB',
      nombre: 'Iron Butterfly', credito: true, legs, contratos: 1, vence, sesion: noche ? 'nocturna' : 'regular', corto: centro, largo: alas, ancho: alas,
      strikesTxt: `${centro - alas}/${centro}/${centro + alas}`, precioMedio, natural: r05(-q.compraNat, false),
      deltaNeto: q.deltaNeto, spx: spx != null ? Number(spx) : null, ranura,
      bp: dr?.data?.['buying-power-effect']?.['change-in-buying-power'] ?? null,
      fees: dr?.data?.['fee-calculation']?.['total-fees'] ?? null, avisosDryRun: dr?.data?.warnings || [],
    };
    p.riesgoMaxUsd = Math.round((alas - precioMedio) * 100);
    p.gananciaMaxUsd = Math.round(precioMedio * 100);
    if (p.riesgoMaxUsd > cuentaDemo().disponible) {
      const msg = `cuenta demo: el riesgo del IB ($${p.riesgoMaxUsd}) supera el saldo disponible ($${cuentaDemo().disponible})`;
      if (soloDemo()) return { ok: false, error: msg };
      p.noCabeDemo = msg;                                    // sí puede ir por real
    }
    previews.set(p.id, p);
    return { ok: true, modo: modo(), modosPermitidos: permitidos(), cuenta: cuenta(), preview: p, venceEnSeg: null };
  }

  // modoPedido: 'real' | 'dryrun', lo que eligió Guillermo en el último botón del PC. Sin modo solo se acepta si hay uno
  // solo permitido (la demo): con la real habilitada, nunca se adivina.
  async function ejecutar(previewId, modoPedido) {
    if (!permitidos().length) return { ok: false, error: 'clic real apagado' };
    const p = previews.get(previewId);
    if (!p) return { ok: false, error: 'preview inexistente o vencido: hay que volver a pedirlo' };
    const m = String(modoPedido || (permitidos().length === 1 ? permitidos()[0] : '')).toLowerCase();
    if (!permitidos().includes(m)) {
      return { ok: false, error: `modo ${m || '(sin elegir)'} no permitido (CLIC_REAL_MODO=${modo()}: ${permitidos().join(' o ')})` };
    }
    if (m === 'real' && p.sesion === 'nocturna') return { ok: false, error: 'la práctica nocturna es solo en demo' };
    const fueraM = p.sesion === 'nocturna' ? null : fueraDeVentana(m);
    if (fueraM) return { ok: false, error: fueraM };
    // sin vencimiento (Guillermo 2026-10-19: "no le pongas límite de tiempo a la aprobación"): al ejecutar se recotiza y,
    // si el precio se movió más de la tolerancia, vuelve un precio nuevo para una segunda confirmación
    if (ocupado) return { ok: false, error: 'ya hay una orden en curso' };
    if (abierta(p.ranura || 'principal')) return { ok: false, error: 'ya hay un clic abierto en esa ranura (real o demo)' };
    if (frenado(m)) return { ok: false, error: `freno diario de la real: P&L de hoy ${pnlHoy('real').toFixed(0)} <= -${frenoUsd()}` };
    ocupado = true;
    previews.delete(previewId);
    try {
      const q = await cotizarEstable(p.legs);
      const medio = p.credito ? r05(-q.medio, false) : r05(q.medio, true);
      const nat = p.credito ? r05(-q.compraNat, false) : r05(q.compraNat, true);
      const peor = p.credito ? p.precioMedio - medio : medio - p.precioMedio;
      // 2026-10-22 (Guillermo: "fue un poco lento"): un IB de ~$16 se movió 0.20 en 6 s y pidió segunda confirmación.
      // En el IB la tolerancia escala con el crédito (2 %); en los verticales sigue fija (CLIC_REAL_TOL_PTS, 0.15)
      const tol = p.estructura === 'IB' ? Math.max(tolPts(), r05(0.02 * p.precioMedio, false)) : tolPts();
      if (peor > tol + 1e-9) {
        // 2026-10-19: en un movimiento rapido el spread se encarecio 0.35 en 7 s y la entrada se perdio. En vez de
        // rechazar seco, se devuelve un preview nuevo con el precio de ahora para que Guillermo decida otra vez.
        const fuera = p.estructura === 'IB' ? false : p.credito ? medio < 1.20 - 1e-9 : medio > 3.80 + 1e-9;
        const msg = `el precio se movio ${peor.toFixed(2)} pts en contra desde el preview (${p.precioMedio} -> ${medio})`;
        if (fuera) return { ok: false, error: `${msg} y quedo fuera de los limites del clic (${p.credito ? 'credito < 1.20' : 'debito > 3.80'})` };
        const p2 = { ...p, id: 'pv-' + Date.now(), creado: Date.now(), precioAnterior: p.precioMedio, precioMedio: medio, natural: nat,
                     deltaNeto: q.deltaNeto };
        p2.riesgoMaxUsd = Math.round((p2.credito ? p2.ancho - medio : medio) * 100 * (p2.contratos || 1));
        p2.gananciaMaxUsd = Math.round((p2.credito ? medio : p2.ancho - medio) * 100 * (p2.contratos || 1));
        previews.set(p2.id, p2);
        return { ok: false, recotizado: true, error: msg, preview: p2, modo: m, modosPermitidos: permitidos(), cuenta: cuenta() };
      }
      // escalera: medio, medio+0.05, ... hasta el natural, sin pasar de los limites del clic
      const tope = p.estructura === 'IB' ? (p.credito ? 0.05 : 1e9) : p.credito ? 1.20 : 3.80;
      const precios = [];
      for (let x = medio; p.credito ? x >= nat - 1e-9 : x <= nat + 1e-9; x = +(x + (p.credito ? -TICK : TICK)).toFixed(2)) {
        if (p.credito ? x < tope - 1e-9 : x > tope + 1e-9) break;
        precios.push(x);
        if (precios.length >= 4) break;
      }
      if (!precios.length) return { ok: false, error: `fuera de los limites del clic (${p.credito ? 'credito < 1.20' : 'debito > 3.80'})` };
      if (m === 'dryrun') {
        const riesgo = Math.round((p.credito ? p.ancho - precios[0] : precios[0]) * 100 * (p.contratos || 1));
        const disp = cuentaDemo().disponible;
        if (riesgo > disp) return { ok: false, error: `cuenta demo: el riesgo del vertical ($${riesgo}) supera el saldo disponible ($${disp})` };
      }
      const t0 = Date.now();
      const r = await mandarYPerseguir({ ...p, modo: m, feesConocidas: p.fees ?? null }, precios, true);
      const segEjec = +((Date.now() - t0) / 1000).toFixed(1);
      const lista = cargar();
      const rec = {
        id: 'cr-' + Date.now(), modo: m, cuenta: cuenta(), fecha: fechaET(), direccion: p.direccion, estrategia: p.estrategia,
        nombre: p.nombre, credito: p.credito, legs: p.legs, contratos: p.contratos || 1, vence: p.vence, corto: p.corto, largo: p.largo,
        ancho: p.ancho, spxEntrada: p.spx, deltaEntrada: q.deltaNeto, vendidasEntrada: q.vendidas || null, ordenApertura: r.orderId, abiertaEn: new Date().toISOString(),
        estructura: p.estructura || 'VERTICAL', strikesTxt: p.strikesTxt || null, sesion: p.sesion || 'regular',
        ranura: p.ranura || 'principal',
      };
      if (!r.lleno) {
        lista.unshift({ ...rec, estado: 'no_llenada', motivo: r.motivo, precios });
        guardar(lista);
        return { ok: false, error: r.motivo, orderId: r.orderId };
      }
      Object.assign(rec, { estado: 'abierta', precioEntrada: r.precio, simulado: !!r.simulado, feesApertura: r.fees || 0,
                           feesAbiertas: r.fees || 0, contratosMax: rec.contratos, segEjecApertura: segEjec });
      if (r.fillDemo) rec.fillDemoApertura = r.fillDemo;
      rec.riesgoMaxUsd = Math.round((p.credito ? p.ancho - r.precio : r.precio) * 100 * rec.contratos);
      rec.gananciaMaxUsd = Math.round((p.credito ? r.precio : p.ancho - r.precio) * 100 * rec.contratos);
      lista.unshift(rec);
      guardar(lista);
      avisar(`${p.nombre} ${p.strikesTxt || `${p.largo}/${p.corto}`} · ${rec.contratos} contrato(s) · ${p.credito ? 'crédito' : 'débito'} $${r.precio.toFixed(2)} · `
             + `riesgo máx $${rec.riesgoMaxUsd} · ganancia máx $${rec.gananciaMaxUsd}${r.simulado ? ' · DEMO (dry-run)' : ''}`,
             `Clic SPX abierto: ${p.nombre}${r.simulado ? ' (demo)' : ''}`, 'chart_with_upwards_trend');
      return { ok: true, registro: rec };
    } finally {
      ocupado = false;
    }
  }

  // ── Agregar contratos al clic abierto, a los MISMOS strikes (2026-11-05, Guillermo: "1. a los mismos") ──
  // cotizarAgregar: precio y riesgo de los k contratos nuevos, para que Guillermo lo apruebe en el PC.
  async function cotizarAgregar(k) {
    const rec = abierta('principal');
    if (!rec) return { ok: false, error: 'no hay un clic abierto al que agregar' };
    if (rec.estructura === 'IB') return { ok: false, error: 'al Iron Butterfly no se le agregan contratos' };
    const libres = maxContratos() - (rec.contratos || 1);
    if (libres <= 0) return { ok: false, error: `ya tienes ${rec.contratos} contratos (máximo ${maxContratos()})` };
    k = Math.min(Math.max(1, Math.round(Number(k) || 1)), libres);
    const q = await cotizarEstable(rec.legs);
    const precioMedio = rec.credito ? r05(-q.medio, false) : r05(q.medio, true);
    const natural = rec.credito ? r05(-q.compraNat, false) : r05(q.compraNat, true);
    const riesgo = Math.round((rec.credito ? rec.ancho - precioMedio : precioMedio) * 100 * k);
    return { ok: true, contratos: k, contratosAhora: rec.contratos, precioMedio, natural, riesgoAdicionalUsd: riesgo,
             nombre: rec.nombre, strikes: rec.strikesTxt || `${rec.largo}/${rec.corto}`, credito: rec.credito, modo: rec.modo,
             precioEntradaAhora: rec.precioEntrada, disponibleDemo: rec.modo === 'dryrun' ? cuentaDemo().disponible : null };
  }

  async function agregar(k) {
    const rec0 = abierta('principal');
    if (!rec0) return { ok: false, error: 'no hay un clic abierto al que agregar' };
    if (rec0.estructura === 'IB') return { ok: false, error: 'al Iron Butterfly no se le agregan contratos' };
    if (ocupado) return { ok: false, error: 'ya hay una orden en curso' };
    const libres = maxContratos() - (rec0.contratos || 1);
    if (libres <= 0) return { ok: false, error: `ya tienes ${rec0.contratos} contratos (máximo ${maxContratos()})` };
    k = Math.min(Math.max(1, Math.round(Number(k) || 1)), libres);
    if (rec0.modo === 'real' && frenado('real')) return { ok: false, error: `freno diario de la real: P&L de hoy ${pnlHoy('real').toFixed(0)} <= -${frenoUsd()}` };
    ocupado = true;
    try {
      const q = await cotizarEstable(rec0.legs);
      const medio = rec0.credito ? r05(-q.medio, false) : r05(q.medio, true);
      const nat = rec0.credito ? r05(-q.compraNat, false) : r05(q.compraNat, true);
      const precios = [];
      for (let x = medio; rec0.credito ? x >= nat - 1e-9 : x <= nat + 1e-9; x = +(x + (rec0.credito ? -TICK : TICK)).toFixed(2)) {
        precios.push(x);
        if (precios.length >= 4) break;
      }
      if (!precios.length) precios.push(medio);
      if (rec0.modo === 'dryrun') {
        const riesgo = Math.round((rec0.credito ? rec0.ancho - precios[0] : precios[0]) * 100 * k);
        const disp = cuentaDemo().disponible;
        if (riesgo > disp) return { ok: false, error: `cuenta demo: el riesgo de ${k} contrato(s) más ($${riesgo}) supera el saldo disponible ($${disp})` };
      }
      const r = await mandarYPerseguir({ ...rec0, contratos: k, precioMedio: medio, feesConocidas: null }, precios, true);
      if (!r.lleno) return { ok: false, error: r.motivo };
      const lista = cargar();
      const rec = lista.find((x) => x.id === rec0.id);
      const n = rec.contratos || 1;
      rec.precioEntrada = +((rec.precioEntrada * n + r.precio * k) / (n + k)).toFixed(3);   // precio promedio
      rec.contratos = n + k;
      rec.contratosMax = Math.max(rec.contratosMax || n, rec.contratos);
      rec.feesApertura = +((rec.feesApertura || 0) + (r.fees || 0)).toFixed(2);
      rec.feesAbiertas = +(feesAbiertas(rec0) + (r.fees || 0)).toFixed(2);
      rec.riesgoMaxUsd = Math.round((rec.credito ? rec.ancho - rec.precioEntrada : rec.precioEntrada) * 100 * rec.contratos);
      rec.gananciaMaxUsd = Math.round((rec.credito ? rec.precioEntrada : rec.ancho - rec.precioEntrada) * 100 * rec.contratos);
      (rec.agregados = rec.agregados || []).push({ en: new Date().toISOString(), contratos: k, precio: r.precio, fees: r.fees || 0, orden: r.orderId });
      guardar(lista);
      avisar(`+${k} contrato(s) a ${r.precio.toFixed(2)} · ahora ${rec.contratos} a ${rec.precioEntrada.toFixed(2)} promedio · `
             + `riesgo máx $${rec.riesgoMaxUsd}${r.simulado ? ' · DEMO (dry-run)' : ''}`,
             `Clic SPX: agregados ${k} a ${rec.nombre}${r.simulado ? ' (demo)' : ''}`, 'heavy_plus_sign');
      return { ok: true, agregados: k, precio: r.precio, registro: rec };
    } finally {
      ocupado = false;
    }
  }

  // contratos: null = todo; k < contratos abiertos = cierre PARCIAL (2026-11-05: "poder cerrar 1, 2, 4, 5 o mas")
  async function cerrar(motivo = 'CIERRE_CLIC', ranura = 'principal', contratos = null) {
    const rec0 = abierta(ranura);
    if (!rec0) return { ok: true, nada: true };
    if (ocupado) return { ok: false, error: 'ya hay una orden en curso' };
    const kParcial = contratos != null && Math.round(Number(contratos)) > 0 && Math.round(Number(contratos)) < (rec0.contratos || 1)
      ? Math.round(Number(contratos)) : null;
    if (kParcial) return cerrarParcial(rec0, kParcial, motivo);
    ocupado = true;
    try {
      let lista = cargar();
      let rec = lista.find((x) => x.id === rec0.id);
      rec.estado = 'cerrando'; rec.cierrePedido = new Date().toISOString(); rec.motivoCierre = motivo;
      guardar(lista);
      const q = await cotizarEstable(rec.legs);
      // cerrar: un debito se VENDE (recibo, baja hacia ventaNat); un credito se RECOMPRA (pago, sube hacia compraNat)
      const medio = rec.credito ? r05(-q.medio, true) : r05(q.medio, false);
      const nat = rec.credito ? r05(-q.ventaNat, true) : r05(Math.max(0, q.ventaNat), false);
      const precios = [];
      for (let x = medio; rec.credito ? x <= nat + 1e-9 : x >= nat - 1e-9; x = +(x + (rec.credito ? TICK : -TICK)).toFixed(2)) {
        precios.push(Math.max(0.05, x));
        if (precios.length >= 6) break;
      }
      if (!precios.length) precios.push(Math.max(0.05, nat));
      const t0 = Date.now();
      // el SPX de salida (para el informe) se pide a la vez que se manda la orden, no después (2026-10-20)
      const spxSal = (rec.sesion === 'nocturna' ? spxSintetico(rec.vence)
        : tt._req('/market-data?symbols[]=SPX').then((d) => Number(d?.data?.items?.[0]?.last) || null)).catch(() => null);
      const r = await mandarYPerseguir({ ...rec }, precios, false, 7000);
      const segEjecCierre = +((Date.now() - t0) / 1000).toFixed(1);
      lista = cargar();
      rec = lista.find((x) => x.id === rec0.id);
      if (!r.lleno) {
        rec.estado = 'abierta';
        rec.ultimoIntentoCierre = { en: new Date().toISOString(), motivo: r.motivo };
        guardar(lista);
        avisar(`${r.motivo}. Revisar en TastyTrade.`, '⚠️ Clic SPX: NO se pudo cerrar', 'warning');
        return { ok: false, error: r.motivo };
      }
      rec.estado = 'cerrada'; rec.cerradaEn = new Date().toISOString(); rec.precioSalida = r.precio; rec.ordenCierre = r.orderId;
      rec.segEjecCierre = segEjecCierre;
      if (r.fillDemo) rec.fillDemoCierre = r.fillDemo;
      // con cierres parciales antes: el resultado del trade suma lo realizado en cada parte (2026-11-05)
      const brutoFinal = Math.round((rec.credito ? rec.precioEntrada - r.precio : r.precio - rec.precioEntrada) * 100 * rec.contratos);
      const netoFinal = brutoFinal - feesAbiertas(rec) - (r.fees || 0);
      rec.feesCierre = +((rec.feesCierreParcial || 0) + (r.fees || 0)).toFixed(2);
      rec.contratosCierreFinal = rec.contratos;
      if (rec.contratosMax) rec.contratos = rec.contratosMax;       // los informes muestran el tamaño máximo del trade
      rec.feesAbiertas = 0;
      rec.pnlBrutoUsd = Math.round(brutoFinal + (rec.pnlParcialBrutoUsd || 0));
      rec.pnlUsd = +(netoFinal + (rec.pnlParcialUsd || 0)).toFixed(2);   // neto de comisiones
      rec.dayTrade = rec.fecha === fechaET();
      rec.spxSalida = await spxSal;          // SPX al cerrar, para el informe del trade (informativo)
      guardar(lista);
      // Guillermo 2026-10-19: el resultado en dolares tiene que verse en la notificacion -> va en el titulo
      const usd = (v) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
      // y cuanto duro el trade y cuanto se le pago a TastyTrade (Guillermo 2026-10-19)
      const seg = Math.round((new Date(rec.cerradaEn) - new Date(rec.abiertaEn)) / 1000);
      const dur = seg >= 3600 ? `${Math.floor(seg / 3600)} h ${Math.floor(seg % 3600 / 60)} min` : `${Math.floor(seg / 60)} min ${seg % 60} s`;
      const pago = (rec.feesApertura || 0) + rec.feesCierre;
      avisar(`${rec.nombre} ${rec.strikesTxt || `${rec.largo}/${rec.corto}`}: ${rec.precioEntrada.toFixed(2)} → ${r.precio.toFixed(2)}
`
             + `Resultado bruto: ${usd(rec.pnlBrutoUsd)}
`
             + `Pago a TastyTrade: -$${pago.toFixed(2)} (apertura $${(rec.feesApertura || 0).toFixed(2)} + cierre $${rec.feesCierre.toFixed(2)})
`
             + `Resultado NETO: ${usd(rec.pnlUsd)}
`
             + `Tiempo en el trade: ${dur}
`
             + `Ejecución de las órdenes: apertura ${rec.segEjecApertura ?? '?'} s · cierre ${segEjecCierre} s
`
             + `Motivo: ${motivo}${rec.simulado ? ' · DEMO (dry-run)' : ''}`,
             `${rec.pnlUsd >= 0 ? '✅ GANÓ' : '🔻 PERDIÓ'} ${usd(rec.pnlUsd)} neto en ${dur} · Clic SPX${rec.simulado ? ' (demo)' : ''}`,
             rec.pnlUsd >= 0 ? 'white_check_mark' : 'small_red_triangle_down');
      return { ok: true, registro: rec };
    } finally {
      ocupado = false;
    }
  }

  // cierre parcial: se deshacen k de los n contratos, se registra lo realizado y el resto sigue abierto
  async function cerrarParcial(rec0, k, motivo) {
    ocupado = true;
    try {
      const q = await cotizarEstable(rec0.legs);
      const medio = rec0.credito ? r05(-q.medio, true) : r05(q.medio, false);
      const nat = rec0.credito ? r05(-q.ventaNat, true) : r05(Math.max(0, q.ventaNat), false);
      const precios = [];
      for (let x = medio; rec0.credito ? x <= nat + 1e-9 : x >= nat - 1e-9; x = +(x + (rec0.credito ? TICK : -TICK)).toFixed(2)) {
        precios.push(Math.max(0.05, x));
        if (precios.length >= 6) break;
      }
      if (!precios.length) precios.push(Math.max(0.05, nat));
      const r = await mandarYPerseguir({ ...rec0, contratos: k, feesConocidas: null }, precios, false, 7000);
      if (!r.lleno) {
        avisar(`${r.motivo}. Revisar en TastyTrade.`, `⚠️ Clic SPX: NO se pudo cerrar ${k} contrato(s)`, 'warning');
        return { ok: false, error: r.motivo };
      }
      const lista = cargar();
      const rec = lista.find((x) => x.id === rec0.id);
      const n = rec.contratos || 1;
      const feesParte = +(feesAbiertas(rec) * k / n).toFixed(2);           // la parte de la apertura de estos k
      const bruto = Math.round((rec.credito ? rec.precioEntrada - r.precio : r.precio - rec.precioEntrada) * 100 * k);
      const neto = +(bruto - feesParte - (r.fees || 0)).toFixed(2);
      rec.contratos = n - k;
      rec.feesAbiertas = +(feesAbiertas(rec) - feesParte).toFixed(2);
      rec.feesCierreParcial = +((rec.feesCierreParcial || 0) + (r.fees || 0)).toFixed(2);
      rec.pnlParcialBrutoUsd = Math.round((rec.pnlParcialBrutoUsd || 0) + bruto);
      rec.pnlParcialUsd = +((rec.pnlParcialUsd || 0) + neto).toFixed(2);
      rec.riesgoMaxUsd = Math.round((rec.credito ? rec.ancho - rec.precioEntrada : rec.precioEntrada) * 100 * rec.contratos);
      rec.gananciaMaxUsd = Math.round((rec.credito ? rec.precioEntrada : rec.ancho - rec.precioEntrada) * 100 * rec.contratos);
      (rec.parciales = rec.parciales || []).push({ en: new Date().toISOString(), contratos: k, precio: r.precio, pnlUsd: neto,
                                                   fees: r.fees || 0, motivo, orden: r.orderId });
      guardar(lista);
      const usd = (v) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
      avisar(`${rec.nombre} ${rec.strikesTxt || `${rec.largo}/${rec.corto}`}: cerrados ${k} de ${n} a ${r.precio.toFixed(2)} `
             + `(entrada ${rec.precioEntrada.toFixed(2)}) = ${usd(neto)} neto · quedan ${rec.contratos}${r.simulado ? ' · DEMO (dry-run)' : ''}`,
             `Clic SPX: cierre parcial ${usd(neto)}${r.simulado ? ' (demo)' : ''}`, neto >= 0 ? 'white_check_mark' : 'small_red_triangle_down');
      return { ok: true, parcial: true, cerrados: k, quedan: rec.contratos, precio: r.precio, pnlUsd: neto, registro: rec };
    } finally {
      ocupado = false;
    }
  }

  let cacheEstado = { ts: 0, data: null };
  async function estado() {
    // 1,5 s (era 4): la tabla de TV pide cada 2 s y el P&L no debe tener más de ~3,5 s (Guillermo 2026-10-20)
    if (Date.now() - cacheEstado.ts < 1500 && cacheEstado.data) return cacheEstado.data;
    const hoy = fechaET();
    const l = cargar();
    const rec = abierta() || l.find((x) => x.fecha === hoy && x.estado === 'cerrada' && permitidos().includes(x.modo)
                                         && (x.ranura || 'principal') === 'principal');
    const vista = async (rec) => {
      let pnl = rec.pnlUsd ?? null, pnlNatural = null, iv = null, delta = rec.deltaEntrada, vendidas = rec.vendidasEntrada || null, spxAhora = null;
      if (rec.estado !== 'cerrada') {
        try {
          const q = await cotizar(rec.legs);
          const v = valorEstable(rec, q);
          // neto estimado con comisiones de ida + otras tantas de vuelta; valor = lo que da/cuesta deshacer la estructura
          const neto = (valor) => {
            const salida = rec.credito ? -valor : valor;
            return +(Math.round((rec.credito ? rec.precioEntrada - salida : salida - rec.precioEntrada) * 100 * rec.contratos)
                     - 2 * feesAbiertas(rec)).toFixed(2);
          };
          pnl = neto(v.medio);              // al medio, estable (ver valorEstable)
          pnlNatural = neto(v.ventaNat);    // si cierras ya, al natural
          iv = q.iv;
          delta = q.deltaNeto;
          vendidas = q.vendidas;
        } catch (e) { /* sin cotizacion: se muestra sin P&L */ }
        // SPX ahora: el bot lo usa para traducir el TP/SL que Guillermo pone en TradingView a P&L de las opciones
        try {
          spxAhora = rec.sesion === 'nocturna' ? await spxSintetico(rec.vence)
            : Number((await tt._req('/market-data?symbols[]=SPX'))?.data?.items?.[0]?.last) || null;
        } catch (e) { /* informativo */ }
      }
      return {
        id: rec.id, origen: 'CLIC_REAL', modo: rec.modo, estado: rec.estado === 'cerrada' ? 'closed' : 'filled',
        estructura: rec.nombre, direccion: rec.direccion, credito: rec.credito, contratos: rec.contratos, vence: rec.vence,
        strikes: rec.strikesTxt || `${rec.corto}/${rec.largo}`, primaPts: rec.precioEntrada, primaUsd: Math.round(rec.precioEntrada * 100 * rec.contratos),
        riesgoMaxUsd: rec.riesgoMaxUsd, gananciaMaxUsd: rec.gananciaMaxUsd, deltaEntrada: rec.deltaEntrada, deltaAhora: delta,
        vendidas, spxEntrada: rec.spxEntrada, abiertaEn: rec.abiertaEn, cerradaEn: rec.cerradaEn || null, motivoCierre: rec.motivoCierre || null,
        cierrePedido: rec.estado === 'cerrando', pnl, pnlNatural, ivAhora: iv, spxAhora, simulado: !!rec.simulado, sesion: rec.sesion || 'regular',
        // varios contratos (2026-11-05): pnl/pnlNatural son de los contratos ABIERTOS; lo ya cerrado en parciales, aparte
        pnlParcial: rec.estado !== 'cerrada' ? (rec.pnlParcialUsd || 0) : 0, parciales: (rec.parciales || []).length,
        agregados: (rec.agregados || []).length, maxContratos: maxContratos(),
        ranura: rec.ranura || 'principal',
      };
    };
    let trade = null;
    if (rec) trade = await vista(rec);
    const ad = abierta('adicional');
    const adicional = ad ? await vista(ad) : null;
    cacheEstado = { ts: Date.now(), data: { ok: true, modo: modo(), modosPermitidos: permitidos(), pnlHoy: pnlHoy('real'),
                                            pnlHoyDemo: pnlHoy('dryrun'), freno: frenoUsd(), trade, adicional } };
    return cacheEstado.data;
  }

  // resumen de los trades cerrados del modo vigente (o del pedido): hoy y acumulado
  function resumen(modoPedido) {
    const m = modoPedido || (modo() === 'real' ? 'real' : 'dryrun');
    const hoy = fechaET();
    const todos = cargar().filter((x) => x.modo === m && x.estado === 'cerrada' && x.pnlUsd != null);
    // demo: solo desde el reinicio; lo de antes es la sombra (afinamiento del algoritmo, 2026-10-19/20)
    const cerr = m === 'dryrun' ? todos.filter((x) => x.abiertaEn >= demoDesde()) : todos;
    const sombra = m === 'dryrun' ? todos.filter((x) => x.abiertaEn < demoDesde()) : [];
    const est = (l) => {
      const n = l.length, g = l.filter((x) => x.pnlUsd > 0).length, tot = l.reduce((a, x) => a + x.pnlUsd, 0);
      return { n, ganados: g, pctGanados: n ? Math.round(100 * g / n) : null, pnlNeto: +tot.toFixed(2),
               promedio: n ? +(tot / n).toFixed(2) : null,
               comisiones: +l.reduce((a, x) => a + (x.feesApertura || 0) + (x.feesCierre || 0), 0).toFixed(2) };
    };
    const deHoy = cerr.filter((x) => x.fecha === hoy);
    return { ok: true, modo: m, hoy: est(deHoy), acumulado: est(cerr), desde: cerr.length ? cerr[cerr.length - 1].fecha : null,
             ...(m === 'dryrun' ? { demoDesde: demoDesde(), sombra: est(sombra) } : {}),
             tradesHoy: deHoy.map((x) => ({ hora: x.abiertaEn, nombre: x.nombre, strikes: `${x.largo}/${x.corto}`, entrada: x.precioEntrada,
                                            salida: x.precioSalida, pnlNeto: x.pnlUsd, motivo: x.motivoCierre, strikesTxt: x.strikesTxt })) };
  }

  // vista de la cuenta demo para la web: saldo, curva, trades y la posicion abierta con su P&L en vivo
  async function demo() {
    const c = cuentaDemo();
    const cerr = c.trades.filter((x) => x.estado === 'cerrada');
    const g = cerr.filter((x) => x.pnlUsd > 0).length;
    let abierta = null, adicional = null;
    if (c.abiertos[0]) {
      const e = await estado();
      abierta = e.trade && e.trade.modo === 'dryrun' && e.trade.estado !== 'closed' ? e.trade : null;
      adicional = e.adicional && e.adicional.modo === 'dryrun' ? e.adicional : null;
    }
    // sombra: los trades demo de antes del reinicio del 22-oct (afinamiento), aparte y sin tocar el saldo
    const somb = cargar().filter((x) => x.modo === 'dryrun' && x.abiertaEn < c.desde && x.estado === 'cerrada' && x.pnlUsd != null);
    const sombra = { trades: somb.length, ganados: somb.filter((x) => x.pnlUsd > 0).length,
                     pnlNeto: +somb.reduce((a, x) => a + x.pnlUsd, 0).toFixed(2) };
    return { ok: true, modo: modo(), modosPermitidos: permitidos(), sombra, capital: c.capital, desde: c.desde, saldo: c.saldo, disponible: c.disponible, reservado: c.reservado,
             pnlRealizado: c.realizado, pnlAbierto: +((abierta?.pnl ?? 0) + (adicional?.pnl ?? 0)).toFixed(2), adicional, rendimientoPct: +(100 * c.realizado / c.capital).toFixed(2),
             trades: cerr.length, ganados: g, pctGanados: cerr.length ? Math.round(100 * g / cerr.length) : null,
             promedio: cerr.length ? +(c.realizado / cerr.length).toFixed(2) : null,
             comisiones: +cerr.reduce((a, x) => a + (x.feesApertura || 0) + (x.feesCierre || 0), 0).toFixed(2),
             maxDrawdown: c.maxDrawdown, curva: c.curva, abierta,
             lista: c.trades.slice().reverse().map((x) => ({ id: x.id, fecha: x.fecha, abiertaEn: x.abiertaEn, cerradaEn: x.cerradaEn || null,
               nombre: x.nombre, direccion: x.direccion, strikes: x.strikesTxt || `${x.largo}/${x.corto}`, credito: x.credito, entrada: x.precioEntrada,
               salida: x.precioSalida ?? null, spxEntrada: x.spxEntrada, pnlBruto: x.pnlBrutoUsd ?? null, pnlNeto: x.pnlUsd ?? null,
               comisiones: +((x.feesApertura || 0) + (x.feesCierre || 0)).toFixed(2), motivo: x.motivoCierre || null, estado: x.estado,
               // 2026-10-20 (Guillermo: "en la bitácora pongamos el pdf de cada posición"): lo que necesita el informe del bot
               estructura: x.estructura || 'VERTICAL', corto: x.corto, largo: x.largo, ancho: x.ancho, vence: x.vence,
               contratos: x.contratos, riesgoMaxUsd: x.riesgoMaxUsd, gananciaMaxUsd: x.gananciaMaxUsd, deltaEntrada: x.deltaEntrada,
               vendidasEntrada: x.vendidasEntrada || null, spxSalida: x.spxSalida ?? null, sesion: x.sesion || 'regular',
               feesApertura: x.feesApertura || 0, feesCierre: x.feesCierre || 0, segEjecApertura: x.segEjecApertura ?? null })) };
  }

  // seguro: a las 15:30 ET se cierra lo que quede abierto
  function vigilar() {
    setInterval(async () => {
      try {
        if (ocupado) return;
        const m = horaETmin();
        for (const rec of abiertas()) {             // todas las ranuras (principal y el IB adicional)
          const r = rec.ranura || 'principal';
          if (rec.sesion === 'nocturna') {
            // la práctica nocturna se cierra sola al terminar su ventana (23:30 ET)
            if (m > NOCHE_HASTA || m < NOCHE_DESDE) await cerrar('CIERRE_FIN_PRACTICA_NOCTURNA', r);
          } else if (m >= (rec.modo === 'real' ? 15 * 60 + 30 : 15 * 60 + 59)) {
            // seguro antes del vencimiento: 15:30 en la real; en la demo 15:59 (Guillermo 2026-10-20: ventana hasta 15:55)
            await cerrar(rec.modo === 'real' ? 'CIERRE_PRE_CLOSE_1530' : 'CIERRE_PRE_CLOSE_1559', r);
          }
        }
      } catch (e) { console.error('[CLIC_REAL] vigilancia:', e.message); }
    }, 20000);
  }

  return { preview, previewIB, ejecutar, cerrar, cotizarAgregar, agregar, maxContratos, estado, vigilar, modo, resumen, demo, _cuerpoOrden: cuerpoOrden, _r05: r05,
           _teoricoSincronizado: teoricoSincronizado, _medioDemo: medioDemo, _cotizar: cotizar, _ultimoAjusteDemo: () => ultimoAjusteDemo };
}

module.exports = { crearClicReal, ACCION };
