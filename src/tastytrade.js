'use strict';

const BASE = 'https://api.tastyworks.com';
const HEADERS_BASE = {
  'Content-Type': 'application/json',
  'User-Agent':   'bitacora-tasty/1.0',
  Accept:         '*/*',
};

// ── Black-Scholes helpers ──────────────────────────────────────
function bsN(x) {
  const a1= 0.254829592, a2=-0.284496736, a3= 1.421413741,
        a4=-1.453152027, a5= 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t) * Math.exp(-x*x);
  return 0.5 * (1 + sign * y);
}
function bsPDF(x) { return Math.exp(-0.5*x*x) / Math.sqrt(2*Math.PI); }

class TastytradeClient {
  constructor({ clientSecret, refreshToken, accountNumber,
                // legacy — ignorados si hay OAuth
                username, password, rememberToken, sessionToken }) {
    this.accountNumber = accountNumber;

    // OAuth (nuevo)
    this.clientSecret  = clientSecret  || process.env.TT_CLIENT_SECRET  || null;
    this.refreshToken  = refreshToken  || process.env.TT_REFRESH_TOKEN  || null;

    // Legacy fallback (por si acaso)
    this.username      = username;
    this.password      = password;
    this.rememberToken = rememberToken;

    // Access token en memoria
    this.accessToken   = sessionToken || process.env.TT_SESSION_TOKEN || null;
    this.tokenExpiry   = 0; // timestamp ms cuando expira
    this._authPromise  = null;

    // Alias para compatibilidad con health check
    Object.defineProperty(this, 'sessionToken', {
      get: () => this.accessToken,
      set: (v) => { this.accessToken = v; },
    });
  }

  // ── OAuth: obtener/renovar access token ─────────────────────
  async _oauthRefresh() {
    if (!this.clientSecret || !this.refreshToken) {
      throw new Error('Faltan TT_CLIENT_SECRET o TT_REFRESH_TOKEN en .env');
    }
    console.log('[TT OAuth] Renovando access token...');
    const res = await fetch(`${BASE}/oauth/token`, {
      method:  'POST',
      headers: { ...HEADERS_BASE },
      body:    JSON.stringify({
        grant_type:    'refresh_token',
        refresh_token: this.refreshToken,
        client_secret: this.clientSecret,
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`OAuth refresh falló ${res.status}: ${txt.slice(0, 200)}`);
    }
    const json = await res.json();
    this.accessToken = json.access_token;
    // expires_in en segundos, renovar 60s antes de que expire
    this.tokenExpiry = Date.now() + ((json.expires_in || 900) - 60) * 1000;
    console.log(`[TT OAuth] ✅ Access token renovado — expira en ${json.expires_in}s`);
    return this.accessToken;
  }

  async authenticate() {
    // Si ya tenemos OAuth configurado, usarlo
    if (this.clientSecret && this.refreshToken) {
      if (!this.accessToken || Date.now() >= this.tokenExpiry) {
        if (this._authPromise) return this._authPromise;
        this._authPromise = this._oauthRefresh().finally(() => { this._authPromise = null; });
        return this._authPromise;
      }
      return this.accessToken;
    }
    // Legacy fallback
    if (this.accessToken) {
      console.log('[TT] Usando session token existente (legacy)');
      return this.accessToken;
    }
    throw new Error('No hay credenciales OAuth. Configura TT_CLIENT_SECRET y TT_REFRESH_TOKEN en .env');
  }

  // ── Auto-renovación cada 14 minutos ─────────────────────────
  startAutoRefresh() {
    if (!this.clientSecret || !this.refreshToken) return;
    setInterval(async () => {
      try {
        await this._oauthRefresh();
      } catch(e) {
        console.log('[TT OAuth] Error en auto-refresh:', e.message);
      }
    }, 14 * 60 * 1000); // cada 14 minutos
    console.log('[TT OAuth] Auto-refresh activado cada 14 minutos');
  }

  // ── Request base ─────────────────────────────────────────────
  async _req(path, opts = {}, isRetry = false) {
    await this.authenticate();

    const res = await fetch(`${BASE}${path}`, {
      ...opts,
      headers: {
        ...HEADERS_BASE,
        Authorization: `Bearer ${this.accessToken}`,
        ...opts.headers,
      },
    });

    if (res.status === 401 && !isRetry) {
      console.log('[TT] 401 — renovando token y reintentando...');
      this.accessToken = null;
      this.tokenExpiry = 0;
      await this.authenticate();
      return this._req(path, opts, true);
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`TT API ${res.status} ${path}: ${txt}`);
    }
    return res.json();
  }

  async getBalances() {
    const d = await this._req(`/accounts/${this.accountNumber}/balances`);
    return d.data;
  }

  async getPositions() {
    const d = await this._req(`/accounts/${this.accountNumber}/positions`);
    return d.data?.items ?? [];
  }

  async getMarginRequirements() {
    const d = await this._req(`/accounts/${this.accountNumber}/margin-requirements`);
    return d.data;
  }

  async getGreeks(symbols = []) {
    if (!symbols.length) return {};

    // Intento 1: TastyTrade REST (solo mercado abierto)
    const params = symbols.map(s => `symbols[]=${encodeURIComponent(s)}`).join('&');
    try {
      const d     = await this._req(`/market-data/options?${params}`);
      const items = d.data?.items ?? [];
      if (items.length > 0) {
        const map = {};
        items.forEach(item => {
          map[item.symbol] = {
            delta: parseFloat(item.delta || 0),
            theta: parseFloat(item.theta || 0),
            gamma: parseFloat(item.gamma || 0),
            vega:  parseFloat(item.vega  || 0),
            iv:    parseFloat(item['implied-volatility'] || item.iv || 0),
            mark:  parseFloat(item.mark  || item['mid-price'] || 0),
            src:   'tt',
          };
        });
        console.log(`[Greeks] TastyTrade: ${items.length} opciones`);
        return map;
      }
    } catch(e) {}

    // Intento 2: Black-Scholes con Yahoo Finance
    console.log('[Greeks] Usando Black-Scholes + Yahoo Finance...');
    try {
      const underlyings = [...new Set(symbols.map(s => {
        const m = s.match(/^([A-Z]+)\s/);
        return m ? m[1] : s.replace(/\s.*/,'').replace(/\d.*/,'');
      }))];

      const priceMap = {};
      const ivMap    = {};
      for (const und of underlyings) {
        try {
          const qR = await fetch(
            `https://query1.finance.yahoo.com/v8/finance/chart/${und}?interval=1d&range=1d`,
            { headers: { 'User-Agent': 'Mozilla/5.0' } }
          );
          const qJ  = await qR.json();
          const cls = qJ.chart?.result?.[0]?.meta?.regularMarketPrice;
          if (cls) priceMap[und] = cls;

          const oR = await fetch(
            `https://query1.finance.yahoo.com/v7/finance/options/${und}`,
            { headers: { 'User-Agent': 'Mozilla/5.0' } }
          );
          const oJ  = await oR.json();
          const opts = [
            ...(oJ.optionChain?.result?.[0]?.options?.[0]?.calls || []),
            ...(oJ.optionChain?.result?.[0]?.options?.[0]?.puts  || []),
          ];
          if (opts.length > 0) {
            const ivs = opts.map(o => o.impliedVolatility).filter(v => v > 0 && v < 5);
            ivMap[und] = ivs.length > 0 ? ivs.reduce((a,b)=>a+b,0)/ivs.length : 0.4;
          }
        } catch(e) {}
      }

      const map = {};
      const R   = 0.0525;

      for (const sym of symbols) {
        const m = sym.match(/^([A-Z]+)\s+(\d{2})(\d{2})(\d{2})([CP])(\d+)/);
        if (!m) continue;
        const und    = m[1];
        const yr     = parseInt('20' + m[2]);
        const mo     = parseInt(m[3]) - 1;
        const dy     = parseInt(m[4]);
        const isCall = m[5] === 'C';
        const K      = parseInt(m[6]) / 1000;

        const S  = priceMap[und];
        if (!S) continue;

        const T  = Math.max((new Date(yr, mo, dy) - Date.now()) / (365.25 * 86400000), 0.001);
        const σ  = ivMap[und] || 0.35;

        const d1  = (Math.log(S/K) + (R + σ*σ/2) * T) / (σ * Math.sqrt(T));
        const d2  = d1 - σ * Math.sqrt(T);
        const Nd1 = bsN(d1);
        const Nd2 = bsN(d2);
        const nd1 = bsPDF(d1);

        const delta = isCall ? Nd1 : Nd1 - 1;
        const gamma = nd1 / (S * σ * Math.sqrt(T));
        const vega  = S * nd1 * Math.sqrt(T) / 100;
        const theta = isCall
          ? (-(S * nd1 * σ) / (2 * Math.sqrt(T)) - R * K * Math.exp(-R*T) * Nd2) / 365
          : (-(S * nd1 * σ) / (2 * Math.sqrt(T)) + R * K * Math.exp(-R*T) * bsN(-d2)) / 365;

        map[sym] = {
          delta: Math.round(delta * 1000) / 1000,
          theta: Math.round(theta * 10000) / 10000,
          gamma: Math.round(gamma * 10000) / 10000,
          vega:  Math.round(vega  * 1000) / 1000,
          iv:    Math.round(σ * 100 * 10) / 10,
          mark:  0,
          src:   'bs',
        };
      }
      console.log(`[Greeks] Black-Scholes: ${Object.keys(map).length}/${symbols.length} opciones`);
      return map;
    } catch(e) {
      console.log('[Greeks] Error Black-Scholes:', e.message);
      return {};
    }
  }

  async getTransactions({ startDate, endDate, perPage = 250, pageOffset = 0 } = {}) {
    let url = `/accounts/${this.accountNumber}/transactions?per-page=${perPage}&page-offset=${pageOffset}&sort=Desc`;
    if (startDate) url += `&start-date=${startDate}`;
    if (endDate)   url += `&end-date=${endDate}`;
    const d = await this._req(url);
    return { items: d.data?.items ?? [], pagination: d.pagination };
  }

  async getAllTransactions(startDate, endDate) {
    const all = [];
    let offset = 0, totalPages = 1;
    do {
      const d = await this.getTransactions({ startDate, endDate, pageOffset: offset });
      all.push(...d.items);
      totalPages = d.pagination?.['total-pages'] ?? 1;
      offset++;
      if (offset % 10 === 0) console.log(`[TT] Cargando transacciones... página ${offset}/${totalPages}`);
    } while (offset < totalPages);
    console.log(`[TT] Total transacciones cargadas: ${all.length}`);
    return all;
  }

  async getNLVHistory(timeBack = '1y') {
    const d = await this._req(`/accounts/${this.accountNumber}/net-liquidating-value-history?time-back=${timeBack}`);
    return d.data?.items ?? [];
  }
}

module.exports = { TastytradeClient };
