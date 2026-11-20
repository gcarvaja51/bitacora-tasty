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
};
const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null);

function hmET(ms) {
  return new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
}
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
    this.greeks = {};       // símbolo -> delta
    this.simbolos = new Set();
    this.centro = null; this.spx = null; this.cierrePrevio = null; this.ultimoMs = 0;
    this.nTrades = 0; this.exp = null; this.cadena = null; this.conectadoDesde = null; this.error = null;
    const f = path.join(this.dir, fecha + '.json');
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      this.min = d.min || {}; this.cierrePrevio = d.cierrePrevio || null; this.ultimoMs = d.ultimoMs || 0; this.nTrades = d.nTrades || 0;
    } catch { /* día nuevo */ }
  }

  guardar() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, this.fecha + '.json'),
        JSON.stringify({ fecha: this.fecha, min: this.min, cierrePrevio: this.cierrePrevio, ultimoMs: this.ultimoMs, nTrades: this.nTrades }));
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
    if (!this.ws) await this.conectar();
  }

  cerrar() {
    clearInterval(this.ka); this.ka = null;
    if (this.ws) { try { this.ws.close(); } catch {} }
    this.ws = null; this.conectadoDesde = null;
  }

  async conectar() {
    const q = (await this.tt._req('/api-quote-tokens')).data;
    const cadena = (await this.tt._req('/option-chains/SPX/nested')).data;
    const exps = cadena.items.flatMap((it) => it.expirations.map((e) => ({ ...e, root: it['root-symbol'] })));
    this.exp = exps.find((e) => e['expiration-date'] === this.fecha && e.root === 'SPXW') || exps.find((e) => e['expiration-date'] === this.fecha);
    if (!this.exp) throw new Error('sin vencimiento 0DTE para ' + this.fecha);
    const ws = new WebSocket(q['dxlink-url']);
    this.ws = ws;
    const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
    this.send = send;
    ws.on('open', () => send({ type: 'SETUP', channel: 0, keepaliveTimeout: 60, acceptKeepaliveTimeout: 60, version: '0.1-bitacora-hiro' }));
    ws.on('message', (raw) => this.mensaje(JSON.parse(raw.toString()), q.token));
    ws.on('close', () => { if (this.ws === ws) { this.log('conexión cerrada (se reintenta en el próximo ciclo)'); this.guardar(); this.cerrar(); } });
    ws.on('error', (e) => { this.error = e.message; this.log('ws: ' + e.message); });
    this.ka = setInterval(() => send({ type: 'KEEPALIVE', channel: 0 }), 25000);
    this.ka.unref();
    this.conectadoDesde = new Date().toISOString();
    this.log(`conectando (vencimiento ${this.exp['expiration-date']} ${this.exp.root})`);
  }

  mensaje(d, token) {
    const send = this.send;
    if (d.type === 'AUTH_STATE' && d.state === 'UNAUTHORIZED') send({ type: 'AUTH', channel: 0, token });
    else if (d.type === 'AUTH_STATE' && d.state === 'AUTHORIZED') send({ type: 'CHANNEL_REQUEST', channel: 1, service: 'FEED', parameters: { contract: 'AUTO' } });
    else if (d.type === 'CHANNEL_OPENED') {
      send({ type: 'FEED_SETUP', channel: 1, acceptAggregationPeriod: 0.5, acceptDataFormat: 'COMPACT', acceptEventFields: CAMPOS });
      send({ type: 'FEED_SUBSCRIPTION', channel: 1, reset: true, add: [{ type: 'Trade', symbol: 'SPX' }, { type: 'Summary', symbol: 'SPX' }] });
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
        const cierre = new Date(`${this.fecha}T16:00:00-05:00`).getTime();
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

  // Serie acumulada para la página: [{hora, spx, calls, puts, total}] (miles de millones = valor/1e9 en el cliente)
  serie(fecha = this.fecha) {
    let min = this.min, cierrePrevio = this.cierrePrevio;
    if (fecha !== this.fecha) {
      try { const d = JSON.parse(fs.readFileSync(path.join(this.dir, fecha + '.json'), 'utf8')); min = d.min || {}; cierrePrevio = d.cierrePrevio; }
      catch { return { fecha, filas: [], estado: { mensaje: 'sin datos para ese día' } }; }
    }
    let c = 0, p = 0, spx = null;
    const filas = Object.keys(min).sort().map((hm) => {
      const b = min[hm]; c += b.c; p += b.p; spx = b.spx || spx;
      return { hora: hm, spx, o: b.o ?? spx, h: b.h ?? spx, l: b.l ?? spx, calls: Math.round(c), puts: Math.round(p), total: Math.round(c + p) };
    });
    return {
      fecha, filas, cierrePrevio,
      estado: { conectado: !!this.ws && fecha === this.fecha, desde: this.conectadoDesde, contratos: this.simbolos.size, trades: this.nTrades, patasExcluidas: this.nPatas || 0,
                ultimo: this.ultimoMs ? new Date(this.ultimoMs).toISOString() : null, error: this.error },
    };
  }
}

module.exports = { Hiro, deltaBS };
