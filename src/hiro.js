'use strict';
// ── HIRO propio (2026-11-20) ─────────────────────────────────────────────────
// Reconstrucción del indicador HIRO de SpotGamma con datos de TastyTrade (streaming dxLink, SOLO LECTURA):
// por cada operación de opciones 0DTE del SPX (evento TimeAndSale, que trae el lado agresor) se calcula
//     impacto = lado × delta × contratos × 100 × SPX
// lado: el cliente COMPRA = +1, VENDE = −1 (si dxFeed no trae el lado: precio vs. punto medio bid/ask).
//   Cliente compra call -> el creador de mercado queda corto en call -> COMPRA SPX para cubrirse (impacto +, alcista)
//   Cliente compra put  -> el creador queda corto en put -> VENDE SPX (impacto −, bajista)
// Se acumula en el día por minuto, separado en calls y puts (como el modo Put/Call de HIRO).
// No envía órdenes ni toca cuentas: solo abre una conexión de datos de mercado aparte de la del robot.
// Persistencia: DATA_DIR/hiro/AAAA-MM-DD.json (cada minuto); al reiniciar retoma el día.

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const cal = require('./calendario_nyse');

const RANGO = 150;            // strikes ±150 puntos del SPX
const RECENTRAR = 40;         // si el SPX se aleja 40 pts del centro, se suman strikes nuevos
const CAMPOS = {
  TimeAndSale: ['eventType', 'eventSymbol', 'time', 'price', 'size', 'aggressorSide', 'bidPrice', 'askPrice', 'eventFlags', 'spreadLeg'],
  Greeks: ['eventType', 'eventSymbol', 'delta'],
  Trade: ['eventType', 'eventSymbol', 'price'],
  Summary: ['eventType', 'eventSymbol', 'prevDayClosePrice'],
  Candle: ['eventType', 'eventSymbol', 'time', 'open', 'high', 'low', 'close'],
};
const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null);

function hmET(ms) {
  return new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
}
// Hora de Nueva York -> epoch ms, respetando el horario de verano (auditoría 20-nov: antes había "-05:00" fijo,
// que desde marzo corría todo una hora). fecha 'AAAA-MM-DD', hm 'HH:MM'.
function msET(fecha, hm) {
  const [y, mo, d] = fecha.split('-').map(Number), [h, mi] = hm.split(':').map(Number);
  let t = Date.UTC(y, mo - 1, d, h + 5, mi);
  for (let i = 0; i < 2; i++) {
    const [ph, pm] = hmET(t).split(':').map(Number);
    t -= ((ph % 24) * 60 + pm - (h * 60 + mi)) * 60000;
  }
  return t;
}
// Un manejador de mensajes del websocket nunca puede lanzar: en este proceso también corre el robot.
const seguro = (fn, log) => (...a) => { try { fn(...a); } catch (e) { log('mensaje ignorado: ' + e.message); } };
const N = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
function deltaBS(cp, S, K, T, iv) {
  if (T <= 0) return cp === 'C' ? (S > K ? 1 : 0) : (S < K ? -1 : 0);
  const d1 = (Math.log(S / K) + 0.5 * iv * iv * T) / (iv * Math.sqrt(T));
  return cp === 'C' ? N(d1) : N(d1) - 1;
}

class Hiro {
  constructor({ tt, dataDir, log = console.log }) {
    this.tt = tt; this.log = (m) => log('[HIRO] ' + m);
    this.dir = path.join(dataDir, 'hiro');
    this.ws = null; this.timer = null; this.ka = null;
    this.reset(cal.fechaET());
  }

  reset(fecha) {
    this.fecha = fecha;
    this.min = {};          // 'HH:MM' -> { c, p, spx }
    this.velas = {};        // 'HH:MM' -> { o, h, l, c } (velas de 1 min del SPX, de dxLink)
    this.greeks = {};       // símbolo -> delta
    this.simbolos = new Set();
    this.centro = null; this.spx = null; this.cierrePrevio = null; this.ultimoMs = 0;
    this.nTrades = 0; this.exp = null; this.cadena = null; this.conectadoDesde = null; this.error = null;
    const f = path.join(this.dir, fecha + '.json');
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      this.min = d.min || {}; this.velas = d.velas || {}; this.cierrePrevio = d.cierrePrevio || null; this.ultimoMs = d.ultimoMs || 0; this.nTrades = d.nTrades || 0;
    } catch { /* día nuevo */ }
  }

  guardar() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, this.fecha + '.json'),
        JSON.stringify({ fecha: this.fecha, min: this.min, velas: this.velas, cierrePrevio: this.cierrePrevio, ultimoMs: this.ultimoMs, nTrades: this.nTrades }));
    } catch (e) { this.log('no se pudo guardar: ' + e.message); }
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((e) => { this.error = e.message; this.log('tick: ' + e.message); }), 30000);
    this.timer.unref();
    setInterval(() => { if (this.ws) this.guardar(); }, 60000).unref();
    this.tick().catch((e) => { this.error = e.message; });
  }

  // En horario (9:29–16:01 ET de día de mercado) mantiene la conexión; fuera de horario la cierra.
  async tick() {
    const ahora = new Date();
    const fecha = cal.fechaET(ahora);
    if (fecha !== this.fecha) { this.cerrar(); this.reset(fecha); }
    const m = cal.minutosET(ahora);
    const abierto = cal.esDiaDeMercado(ahora) && m >= 9 * 60 + 29 && m <= cal.horaCierreMin(ahora) + 1;
    if (!abierto) { if (this.ws) { this.guardar(); this.cerrar(); this.log('fuera de horario: desconectado'); } return; }
    // conexión muda (TCP medio abierto): sin mensajes en 90 s se cierra y se reconecta en el próximo ciclo
    if (this.ws && Date.now() - (this.ultimoMsg || Date.now()) > 90000) { this.log('sin mensajes hace 90 s: reconectando'); this.guardar(); this.cerrar(); }
    if (!this.ws && !this._conectando) {
      // una sola conexión a la vez, con tiempo máximo (si no, dos sockets podían contar doble)
      this._conectando = true;
      const intento = this._intento = (this._intento || 0) + 1;
      try {
        await Promise.race([this.conectar(intento), new Promise((_, ko) => setTimeout(() => ko(new Error('conectar: más de 25 s')), 25000).unref())]);
      } catch (e) { if (this._intento === intento) this._intento++; throw e; } finally { this._conectando = false; }
    }
  }

  cerrar() {
    clearInterval(this.ka); this.ka = null;
    if (this.ws) { try { this.ws.close(); } catch {} }
    this.ws = null; this.conectadoDesde = null;
    // al reconectar hay que volver a suscribir los contratos (antes quedaban marcados y el HIRO dejaba de contar)
    this.simbolos = new Set(); this.centro = null; this.autorizado = false;
  }

  async conectar(intento) {
    const q = (await this.tt._req('/api-quote-tokens')).data;
    const cadena = (await this.tt._req('/option-chains/SPX/nested')).data;
    if (intento !== undefined && intento !== this._intento) return;   // llegó tarde: ya se dio por vencido este intento
    const exps = cadena.items.flatMap((it) => it.expirations.map((e) => ({ ...e, root: it['root-symbol'] })));
    this.exp = exps.find((e) => e['expiration-date'] === this.fecha && e.root === 'SPXW') || exps.find((e) => e['expiration-date'] === this.fecha);
    if (!this.exp) throw new Error('sin vencimiento 0DTE para ' + this.fecha);
    const ws = new WebSocket(q['dxlink-url']);
    this.ws = ws;
    const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
    this.send = send;
    ws.on('open', () => send({ type: 'SETUP', channel: 0, keepaliveTimeout: 60, acceptKeepaliveTimeout: 60, version: '0.1-bitacora-hiro' }));
    this.ultimoMsg = Date.now();
    ws.on('message', seguro((raw) => { if (this.ws !== ws) return; this.ultimoMsg = Date.now(); this.mensaje(JSON.parse(raw.toString()), q.token); }, this.log));
    ws.on('close', () => { if (this.ws === ws) { this.log('conexión cerrada (se reintenta en el próximo ciclo)'); this.guardar(); this.cerrar(); } });
    ws.on('error', (e) => { this.error = e.message; this.log('ws: ' + e.message); });
    this.ka = setInterval(() => send({ type: 'KEEPALIVE', channel: 0 }), 25000);
    this.ka.unref();
    this.conectadoDesde = new Date().toISOString();
    this.log(`conectando (vencimiento ${this.exp['expiration-date']} ${this.exp.root})`);
  }

  mensaje(d, token) {
    const send = this.send;
    if (d.type === 'AUTH_STATE' && d.state === 'UNAUTHORIZED') {
      // si ya estaba autorizado, el token venció: se cierra y el próximo ciclo pide uno nuevo (antes reenviaba el viejo)
      if (this.autorizado) { this.log('token vencido: reconectando'); this.cerrar(); return; }
      send({ type: 'AUTH', channel: 0, token });
    } else if (d.type === 'AUTH_STATE' && d.state === 'AUTHORIZED') { this.autorizado = true; send({ type: 'CHANNEL_REQUEST', channel: 1, service: 'FEED', parameters: { contract: 'AUTO' } }); }
    else if (d.type === 'CHANNEL_OPENED') {
      send({ type: 'FEED_SETUP', channel: 1, acceptAggregationPeriod: 0.5, acceptDataFormat: 'COMPACT', acceptEventFields: CAMPOS });
      // 20-nov: velas de 1 min del SPX con historial desde la apertura (el precio queda completo aunque el colector arranque tarde)
      send({ type: 'FEED_SUBSCRIPTION', channel: 1, reset: true, add: [{ type: 'Trade', symbol: 'SPX' }, { type: 'Summary', symbol: 'SPX' },
        { type: 'Candle', symbol: 'SPX{=1m}', fromTime: msET(this.fecha, '09:30') }] });
    } else if (d.type === 'FEED_DATA') {
      for (let i = 0; i < d.data.length; i += 2) {
        const tipo = d.data[i], v = d.data[i + 1], campos = CAMPOS[tipo];
        if (!campos) continue;
        for (let j = 0; j + campos.length <= v.length; j += campos.length) {
          const o = {}; campos.forEach((c, k) => { o[c] = v[j + k]; });
          this.evento(tipo, o);
        }
      }
    } else if (d.type === 'ERROR') { this.error = d.message || d.error; this.log('dxLink: ' + JSON.stringify(d).slice(0, 200)); }
  }

  suscribirStrikes() {
    if (!this.exp || !this.spx) return;
    const nuevos = [];
    for (const s of this.exp.strikes) {
      if (Math.abs(+s['strike-price'] - this.spx) > RANGO) continue;
      for (const sym of [s['call-streamer-symbol'], s['put-streamer-symbol']]) {
        if (!this.simbolos.has(sym)) { this.simbolos.add(sym); nuevos.push(sym); }
      }
    }
    this.centro = this.spx;
    if (!nuevos.length) return;
    // fromTime: retoma desde el último trade guardado (tras un reinicio); en un día nuevo, desde ahora.
    const desde = this.ultimoMs ? this.ultimoMs + 1 : Date.now();
    this.send({ type: 'FEED_SUBSCRIPTION', channel: 1, add: [
      ...nuevos.map((s) => ({ type: 'TimeAndSale', symbol: s, fromTime: desde })),
      ...nuevos.map((s) => ({ type: 'Greeks', symbol: s })),
    ] });
    this.log(`suscritos ${nuevos.length} contratos nuevos (total ${this.simbolos.size}) alrededor de ${this.spx.toFixed(0)}`);
  }

  evento(tipo, o) {
    if (tipo === 'Trade' && o.eventSymbol === 'SPX') {
      const p = num(o.price); if (!p) return;
      this.spx = p;
      const hm = hmET(Date.now());
      const f = this.min[hm] = this.min[hm] || { c: 0, p: 0, spx: p };
      // vela de 1 minuto del SPX (para la vista en velas de la página)
      f.spx = p; if (f.o == null) f.o = p; f.h = Math.max(f.h ?? p, p); f.l = Math.min(f.l ?? p, p);
      if (this.centro === null || Math.abs(p - this.centro) > RECENTRAR) this.suscribirStrikes();
    } else if (tipo === 'Candle') {
      this.vela(o, this.velas, this.fecha);
    } else if (tipo === 'Summary' && o.eventSymbol === 'SPX') {
      this.cierrePrevio = num(o.prevDayClosePrice) || this.cierrePrevio;
    } else if (tipo === 'Greeks') {
      const dl = num(o.delta); if (dl !== null) this.greeks[o.eventSymbol] = dl;
    } else if (tipo === 'TimeAndSale') {
      const t = num(o.time), size = num(o.size), precio = num(o.price);
      if (!t || !size || !this.spx || ((o.eventFlags || 0) & 2) || t <= this.ultimoMs - 120000) return;
      // Patas de spreads/combos: dxFeed marca TODAS las patas con el mismo lado agresor y precios fuera del bid/ask
      // (p. ej. un put spread 7060/7045 sale como dos COMPRAS). No dicen quién compró qué: se excluyen.
      if (o.spreadLeg === true) { this.nPatas = (this.nPatas || 0) + 1; return; }
      let lado = o.aggressorSide === 'BUY' ? 1 : o.aggressorSide === 'SELL' ? -1 : 0;
      if (!lado) { const b = num(o.bidPrice), a = num(o.askPrice); if (b !== null && a !== null && precio !== null) lado = precio >= (a + b) / 2 ? 1 : -1; }
      if (!lado) return;
      const sym = o.eventSymbol;                 // .SPXW261120C7050
      const m = /([CP])(\d+(?:\.\d+)?)$/.exec(sym); if (!m) return;
      const cp = m[1], K = +m[2];
      let dl = this.greeks[sym];
      if (dl === undefined) {
        const cierre = msET(this.fecha, '16:00');
        dl = deltaBS(cp, this.spx, K, Math.max(cierre - t, 60000) / (365 * 86400000), 0.25);
      }
      const imp = lado * dl * size * 100 * this.spx;
      const hm = hmET(t);
      const f = this.min[hm] = this.min[hm] || { c: 0, p: 0, spx: this.spx };
      if (cp === 'C') f.c += imp; else f.p += imp;
      this.nTrades++;
      if (t > this.ultimoMs) this.ultimoMs = t;
    }
  }

  vela(o, destino, fecha) {
    const t = num(o.time), op = num(o.open), hi = num(o.high), lo = num(o.low), cl = num(o.close);
    if (!t || !cl || !op) return;
    if (new Date(t).toLocaleString('en-CA', { timeZone: 'America/New_York' }).slice(0, 10) !== fecha) return;
    const hm = hmET(t);
    if (hm < '09:30' || hm > '16:15') return;   // TradingView incluye las velas del SPX hasta las 16:15
    destino[hm] = { o: op, h: hi ?? Math.max(op, cl), l: lo ?? Math.min(op, cl), c: cl };
  }

  // Velas de 1 min de los días ANTERIORES a una fecha (para calentar las EMA como TradingView). Caché por fecha.
  async velasPrevias(fecha, dias = 4) {
    if (fecha > cal.fechaET()) return [];
    const f = path.join(this.dir, `previas_${fecha}.json`);
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* sin caché */ }
    if (this._cargandoPrev) return null;
    this._cargandoPrev = true;
    try {
      const q = (await this.tt._req('/api-quote-tokens')).data;
      const desde = msET(fecha, '09:25') - dias * 2 * 86400000;
      const lista = [];
      await new Promise((ok) => {
        const ws = new WebSocket(q['dxlink-url']);
        const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
        let quieto = null;
        const fin = () => { clearTimeout(quieto); try { ws.close(); } catch {} ok(); };
        const tope = setTimeout(fin, 25000);
        ws.on('open', () => send({ type: 'SETUP', channel: 0, keepaliveTimeout: 60, acceptKeepaliveTimeout: 60, version: '0.1-bitacora-hiro-previas' }));
        ws.on('message', seguro((raw) => {
          const d = JSON.parse(raw.toString());
          if (d.type === 'AUTH_STATE' && d.state === 'UNAUTHORIZED') send({ type: 'AUTH', channel: 0, token: q.token });
          else if (d.type === 'AUTH_STATE' && d.state === 'AUTHORIZED') send({ type: 'CHANNEL_REQUEST', channel: 5, service: 'FEED', parameters: { contract: 'AUTO' } });
          else if (d.type === 'CHANNEL_OPENED') {
            send({ type: 'FEED_SETUP', channel: 5, acceptAggregationPeriod: 1, acceptDataFormat: 'COMPACT', acceptEventFields: { Candle: CAMPOS.Candle } });
            send({ type: 'FEED_SUBSCRIPTION', channel: 5, reset: true, add: [{ type: 'Candle', symbol: 'SPX{=1m}', fromTime: desde }] });
          } else if (d.type === 'FEED_DATA') {
            for (let i = 0; i < d.data.length; i += 2) {
              if (d.data[i] !== 'Candle') continue;
              const v = d.data[i + 1], n = CAMPOS.Candle.length;
              for (let j = 0; j + n <= v.length; j += n) {
                const t = num(v[j + 2]), o_ = num(v[j + 3]), h = num(v[j + 4]), l = num(v[j + 5]), c = num(v[j + 6]);
                if (!t || !c || !o_) continue;
                const dia = new Date(t).toLocaleString('en-CA', { timeZone: 'America/New_York' }).slice(0, 10), hm = hmET(t);
                if (dia < fecha && hm >= '09:30' && hm <= '16:15') lista.push({ dia, hora: hm, o: o_, h: h ?? Math.max(o_, c), l: l ?? Math.min(o_, c), c });
              }
            }
            if (lista.length) { clearTimeout(quieto); quieto = setTimeout(() => { clearTimeout(tope); fin(); }, 4000); }
          }
        }, this.log));
        ws.on('error', () => { clearTimeout(tope); fin(); });
      });
      const unicas = [...new Map(lista.map((x) => [x.dia + x.hora, x])).values()].sort((a, b) => (a.dia + a.hora).localeCompare(b.dia + b.hora));
      if (unicas.length) { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(f, JSON.stringify(unicas)); }
      return unicas;
    } catch (e) { this.log('velas previas: ' + e.message); return null; } finally { this._cargandoPrev = false; }
  }

  // Velas de 1 min de un día a pedido (con el mercado cerrado o un día pasado): conexión corta a dxLink, solo lectura.
  // Se guardan en DATA_DIR/hiro/velas_AAAA-MM-DD.json cuando el día ya cerró.
  async cargarVelas(fecha) {
    const f = path.join(this.dir, `velas_${fecha}.json`);
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* no hay caché */ }
    if (this._cargando) return null;
    if (this._sinVelas && this._sinVelas[fecha] && Date.now() - this._sinVelas[fecha] < 600000) return null;
    this._cargando = true;
    try {
      const q = (await this.tt._req('/api-quote-tokens')).data;
      const velas = {};
      await new Promise((ok) => {
        const ws = new WebSocket(q['dxlink-url']);
        const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
        let quieto = null;
        const fin = () => { clearTimeout(quieto); try { ws.close(); } catch {} ok(); };
        const tope = setTimeout(fin, 20000);
        ws.on('open', () => send({ type: 'SETUP', channel: 0, keepaliveTimeout: 60, acceptKeepaliveTimeout: 60, version: '0.1-bitacora-hiro-velas' }));
        ws.on('message', seguro((raw) => {
          const d = JSON.parse(raw.toString());
          if (d.type === 'AUTH_STATE' && d.state === 'UNAUTHORIZED') send({ type: 'AUTH', channel: 0, token: q.token });
          else if (d.type === 'AUTH_STATE' && d.state === 'AUTHORIZED') send({ type: 'CHANNEL_REQUEST', channel: 3, service: 'FEED', parameters: { contract: 'AUTO' } });
          else if (d.type === 'CHANNEL_OPENED') {
            send({ type: 'FEED_SETUP', channel: 3, acceptAggregationPeriod: 1, acceptDataFormat: 'COMPACT', acceptEventFields: { Candle: CAMPOS.Candle } });
            send({ type: 'FEED_SUBSCRIPTION', channel: 3, reset: true, add: [{ type: 'Candle', symbol: 'SPX{=1m}', fromTime: msET(fecha, '09:25') }] });
          } else if (d.type === 'FEED_DATA') {
            for (let i = 0; i < d.data.length; i += 2) {
              if (d.data[i] !== 'Candle') continue;
              const v = d.data[i + 1], n = CAMPOS.Candle.length;
              for (let j = 0; j + n <= v.length; j += n) { const o = {}; CAMPOS.Candle.forEach((c, k) => { o[c] = v[j + k]; }); this.vela(o, velas, fecha); }
            }
            // se espera a tener velas de la sesión (el primer paquete puede traer solo la de después del cierre)
            if (Object.keys(velas).length) { clearTimeout(quieto); quieto = setTimeout(() => { clearTimeout(tope); fin(); }, 4000); }
          }
        }, this.log));
        ws.on('error', () => { clearTimeout(tope); fin(); });
      });
      if (!Object.keys(velas).length) (this._sinVelas = this._sinVelas || {})[fecha] = Date.now();
      // se guarda en caché solo con el día terminado (las velas del SPX llegan hasta las 16:15)
      const cerrado = fecha < cal.fechaET() || cal.minutosET() > cal.horaCierreMin() + 20;
      if (Object.keys(velas).length && cerrado) { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(f, JSON.stringify(velas)); }
      return velas;
    } catch (e) { this.log('velas: ' + e.message); return null; } finally { this._cargando = false; }
  }

  // Serie acumulada para la página: [{hora, spx, calls, puts, total}] (miles de millones = valor/1e9 en el cliente)
  serie(fecha = this.fecha) {
    let min = this.min, cierrePrevio = this.cierrePrevio, velas = this.velas;
    if (fecha !== this.fecha) {
      min = {}; velas = {};
      try { const d = JSON.parse(fs.readFileSync(path.join(this.dir, fecha + '.json'), 'utf8')); min = d.min || {}; velas = d.velas || {}; cierrePrevio = d.cierrePrevio; } catch { /* sin HIRO ese día */ }
    }
    if (!Object.keys(velas).length) { try { velas = JSON.parse(fs.readFileSync(path.join(this.dir, `velas_${fecha}.json`), 'utf8')); } catch { /* sin velas en caché */ } }
    let c = 0, p = 0, spx = null;
    const filas = Object.keys(min).filter((hm) => hm >= '09:30' && hm <= '16:15').sort().map((hm) => {
      const b = min[hm]; c += b.c; p += b.p; spx = b.spx || spx;
      return { hora: hm, spx, o: b.o ?? spx, h: b.h ?? spx, l: b.l ?? spx, calls: Math.round(c), puts: Math.round(p), total: Math.round(c + p) };
    });
    // velas de 1 min del SPX de todo el día (dxLink); el precio de la página sale de aquí aunque el HIRO empiece tarde
    const listaVelas = Object.keys(velas).sort().map((hm) => ({ hora: hm, ...velas[hm] }));
    return {
      fecha, filas, cierrePrevio, velas: listaVelas,
      estado: { conectado: !!this.ws && fecha === this.fecha, desde: this.conectadoDesde, contratos: this.simbolos.size, trades: this.nTrades, patasExcluidas: this.nPatas || 0,
                ultimo: this.ultimoMs ? new Date(this.ultimoMs).toISOString() : null, error: this.error },
    };
  }
}

module.exports = { Hiro, deltaBS, msET };
