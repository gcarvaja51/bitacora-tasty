'use strict';
require('dotenv').config();
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { TastytradeClient }                              = require('./src/tastytrade');
const { TradierClient }                                 = require('./src/tradier');
const { buildMetrics, buildEquityCurve, buildCalendar } = require('./src/metrics');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── NLV History ────────────────────────────────────────────────
// Snapshots históricos obtenidos de TastyTrade (fin de mes)
// ── Directorio de datos persistentes ────────────────────────
// En Railway: agrega un volumen montado en /data para persistencia entre deploys
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
if (DATA_DIR !== __dirname) {
  try { require('fs').mkdirSync(DATA_DIR, { recursive: true }); } catch(e) {}
  console.log('[DATA] Usando volumen persistente:', DATA_DIR);
}

// ── Local vs produccion — evitar doble ejecucion real ───────
// El servidor local (npm run dev) y el de Railway corren el mismo codigo de
// forma independiente contra la MISMA cuenta de Tradier. Si ambos estan
// activos a la vez durante horario de mercado, los dos vigilan y pueden
// intentar operar por su cuenta sin saberlo el uno del otro (2026-07-07:
// el local ejecuto un Iron Condor real que quedo huerfano de seguimiento
// al caerse el proceso antes de confirmar el fill). Desde ahora, solo
// Railway (donde SI existe RAILWAY_VOLUME_MOUNT_PATH) ejecuta ordenes
// reales en Tradier — el local sigue generando/mostrando señales y
// corriendo el resto del sistema normalmente, solo sin tocar la cuenta.
const IS_PRODUCTION = !!process.env.RAILWAY_VOLUME_MOUNT_PATH;
if (!IS_PRODUCTION) {
  console.log('[SPX] Entorno LOCAL detectado — auto-ejecucion en Tradier deshabilitada (solo produccion/Railway opera la cuenta real).');
}

const NLV_FILE = path.join(DATA_DIR, 'nlv_history.json');
const NLV_SEED = {
  '2026-02-13': 10644.00,   // depósito inicial
  '2026-02-28': 11328.69,
  '2026-03-30': 9730.48,
  '2026-04-30': 9208.64,
};

function loadNlvHistory() {
  try {
    if (fs.existsSync(NLV_FILE)) {
      return { ...NLV_SEED, ...JSON.parse(fs.readFileSync(NLV_FILE, 'utf8')) };
    }
  } catch(e) { /* ignorar */ }
  return { ...NLV_SEED };
}

function saveNlvSnapshot(dateStr, nlv) {
  const history = loadNlvHistory();
  history[dateStr] = nlv;
  fs.writeFileSync(NLV_FILE, JSON.stringify(history, null, 2), 'utf8');
}

function computeWeeklyNlv(nlvHistory, currentNlv) {
  const entries = Object.entries(nlvHistory).sort((a,b) => a[0].localeCompare(b[0]));
  const today = new Date().toISOString().slice(0,10);
  const allEntries = [...entries, [today, currentNlv]];

  const byWeek = {};
  for (let i = 1; i < allEntries.length; i++) {
    const [prevDate, prevNlv] = allEntries[i-1];
    const [curDate,  curNlv]  = allEntries[i];
    const prevWk = weekKey(prevDate);
    const curWk  = weekKey(curDate);
    if (prevWk !== curWk) {
      // Cruce de semana — asignar el cambio completo a la semana actual
      if (!byWeek[curWk]) byWeek[curWk] = 0;
      byWeek[curWk] += curNlv - prevNlv;
    } else {
      // Misma semana
      if (!byWeek[curWk]) byWeek[curWk] = 0;
      byWeek[curWk] += curNlv - prevNlv;
    }
  }
  // Redondear
  Object.keys(byWeek).forEach(k => { byWeek[k] = +byWeek[k].toFixed(2); });
  return byWeek;
}

function computeMonthlyNlv(nlvHistory, currentNlv) {
  const entries = Object.entries(nlvHistory).sort((a,b) => a[0].localeCompare(b[0]));
  // Agregar snapshot de hoy
  const today = new Date().toISOString().slice(0,10);
  const allEntries = [...entries, [today, currentNlv]];

  const byMonth = {};
  for (let i = 1; i < allEntries.length; i++) {
    const [prevDate, prevNlv] = allEntries[i-1];
    const [curDate,  curNlv]  = allEntries[i];
    const mo = curDate.slice(0, 7);
    // Si están en meses distintos, calcular el cambio
    if (prevDate.slice(0,7) !== mo) {
      // El inicio de este mes = valor al final del mes anterior
      byMonth[mo] = (byMonth[mo] || 0) + curNlv - prevNlv;
    } else {
      byMonth[mo] = (byMonth[mo] || 0) + curNlv - prevNlv;
    }
  }
  // Simplificar: mes = último valor del mes - primer valor del mes
  const monthlyMap = {};
  const prevNlvByMonth = {};
  for (let i = 0; i < allEntries.length; i++) {
    const [date, nlv] = allEntries[i];
    const mo = date.slice(0, 7);
    if (!prevNlvByMonth[mo]) {
      // Primer dato de este mes: start = último valor del mes anterior
      const prevMoEntries = allEntries.filter(([d]) => d.slice(0,7) < mo);
      const prevVal = prevMoEntries.length ? prevMoEntries[prevMoEntries.length-1][1] : nlv;
      prevNlvByMonth[mo] = prevVal;
    }
    monthlyMap[mo] = +(nlv - prevNlvByMonth[mo]).toFixed(2);
  }
  return monthlyMap;
}

// ── Cliente TastyTrade ─────────────────────────────────────────
const tt = new TastytradeClient({
  clientSecret:  process.env.TT_CLIENT_SECRET,
  refreshToken:  process.env.TT_REFRESH_TOKEN,
  // legacy fallback por si acaso
  sessionToken:  process.env.TT_SESSION_TOKEN,
  accountNumber: process.env.TT_ACCOUNT_NUMBER,
});
tt.startAutoRefresh();

// ── Cliente Tradier (sandbox) — ejecución automática de spreads SPX ──
const tradier = new TradierClient({});

const _cache = new Map();
function cached(k, s, fn) {
  const h = _cache.get(k);
  if (h && Date.now() < h.exp) return Promise.resolve(h.v);
  return fn().then(v => { _cache.set(k, { v, exp: Date.now() + s * 1000 }); return v; });
}
function bustCache() { _cache.clear(); }

const todayStr = () => new Date().toISOString().slice(0, 10);
const daysAgo  = n  => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

app.use(express.json({ limit: '25mb', type: ['application/json', 'text/plain'] }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Balance + posiciones + Greeks
app.get('/api/overview', async (req, res) => {
  try {
    const data = await cached('overview', 60, async () => {
      const [balances, positions] = await Promise.all([tt.getBalances(), tt.getPositions()]);
      // Obtener Greeks + mark en tiempo real para posiciones de opciones
      const optionSymbols = positions
        .filter(p => p['instrument-type'] === 'Equity Option')
        .map(p => p.symbol);
      const greeks = await tt.getGreeks(optionSymbols);

      // Obtener mark-price en tiempo real via /market-data
      const markMap = {};
      try {
        const BATCH = 50;
        for (let i = 0; i < optionSymbols.length; i += BATCH) {
          const batch = optionSymbols.slice(i, i + BATCH);
          const params = batch.map(s => `symbols[]=${encodeURIComponent(s)}`).join('&');
          const d = await tt._req(`/market-data?${params}`);
          for (const item of (d.data?.items || [])) {
            const mk = parseFloat(item.mark || item.mid || 0);
            if (mk > 0) markMap[item.symbol] = mk;
          }
        }
      } catch(e) { /* si falla, usará average-daily como fallback */ }

      // Adjuntar Greeks y mark-price a cada posición
      const posWithGreeks = positions.map(p => ({
        ...p,
        greeks: greeks[p.symbol] || null,
        'mark-price': markMap[p.symbol] || null,
      }));
      return { balances, positions: posWithGreeks, ts: new Date().toISOString() };
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Curva de capital desde transacciones
// Solo incluye trades reales (excluye Money Movement = depósitos/retiros)
function weekKey(dateStr) {
  if (!dateStr) return '';
  const d    = new Date(dateStr + 'T12:00:00Z');
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - jan1) / 86400000) + jan1.getUTCDay() + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

app.get('/api/curve', async (req, res) => {
  try {
    const data = await cached('curve', 300, async () => {
      const allItems = await tt.getAllTransactions('2026-02-01', todayStr());

      // Excluir depósitos, retiros y movimientos de dinero
      // Curva mensual: Trade + Receive Deliver (incluye liquidaciones de asignaciones)
      const curveItems = allItems.filter(tx =>
        tx['transaction-type'] === 'Trade' ||
        tx['transaction-type'] === 'Receive Deliver' ||
        tx['transaction-type'] === 'Fee'
      );
      // Calendario diario: solo Trade (evita ruido de settlements en días sueltos)
      const calItems = allItems.filter(tx => tx['transaction-type'] === 'Trade');

      const byDay = {};
      curveItems.forEach(tx => {
        const d = (tx['transaction-date'] || '').slice(0, 10);
        if (!d) return;
        const val    = parseFloat(tx['net-value'] || tx['value'] || 0);
        const effect = tx['net-value-effect'] || tx['value-effect'] || 'Debit';
        byDay[d] = (byDay[d] || 0) + val * (effect === 'Credit' ? 1 : -1);
      });

      const calByDay = {};
      calItems.forEach(tx => {
        const d = (tx['transaction-date'] || '').slice(0, 10);
        if (!d) return;
        const v = parseFloat(tx['net-value'] || 0) * (tx['net-value-effect'] === 'Credit' ? 1 : -1);
        calByDay[d] = (calByDay[d] || 0) + v;
      });

      // NLV real (fuente de verdad) — obtener primero
      const currentNlv = await tt.getBalances().then(b => parseFloat(b?.['net-liquidating-value']||0)).catch(()=>0);
      const nlvHistory = loadNlvHistory();

      const initial = 10644;
      const labels  = Object.keys(byDay).sort();
      let running   = initial;
      const values  = labels.map(d => {
        running += byDay[d];
        return +running.toFixed(2);
      });
      if (values.length > 0 && currentNlv > 0) {
        values[values.length - 1] = +currentNlv.toFixed(2);
      }

      const calendar = {};
      Object.keys(calByDay).forEach(d => { calendar[d] = +calByDay[d].toFixed(2); });

      // Calcular drawdown sobre Net Liq real (snapshots), no sobre P&L acumulado
      let peak = initial, maxDD = 0, maxDDPct = 0;
      const nlvPoints = Object.entries(nlvHistory).sort((a,b)=>a[0].localeCompare(b[0])).map(([,v])=>v);
      if (currentNlv > 0) nlvPoints.push(currentNlv);
      const ddSource = nlvPoints.length >= 2 ? nlvPoints : values;
      ddSource.forEach(v => {
        if (v > peak) peak = v;
        const dd = peak - v;
        if (dd > maxDD) { maxDD = dd; maxDDPct = dd / peak * 100; }
      });

      // byMonth y byWeek desde datos completos (Trade + Receive Deliver)
      const byMonth = {};
      const byWeek  = {};
      Object.keys(byDay).forEach(d => {
        const mo = d.slice(0, 7);
        byMonth[mo] = (byMonth[mo] || 0) + byDay[d];
        const wk = weekKey(d);
        byWeek[wk]  = (byWeek[wk]  || 0) + byDay[d];
      });

      // NLV-based monthly P&L (fuente de verdad = Net Liq real)
      const nlvByMonth = computeMonthlyNlv(nlvHistory, currentNlv);

      const nlvByWeek = computeWeeklyNlv(nlvHistory, currentNlv);

      return {
        curve: { labels, values, initial, maxDD: +maxDD.toFixed(2), maxDDPct: +maxDDPct.toFixed(2) },
        calendar, byMonth, byWeek,
        nlvByMonth, nlvByWeek,
        nlvSnapshots: Object.entries(nlvHistory).sort((a,b)=>a[0].localeCompare(b[0])).concat([[todayStr(), currentNlv]]),
        ts: new Date().toISOString()
      };
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Transacciones + métricas (solo Trade para métricas)
app.get('/api/transactions', async (req, res) => {
  try {
    const sd = req.query.startDate || '2026-02-01';
    const ed = req.query.endDate   || todayStr();
    const ck = `txns_${sd}_${ed}`;
    const data = await cached(ck, 120, async () => {
      const allItems = await tt.getAllTransactions(sd, ed);
      // Pasar Trade + Receive Deliver al metrics (cash settlements, assignments, exercises)
      const tradeItems = allItems.filter(tx =>
        tx['transaction-type'] === 'Trade' ||
        tx['transaction-type'] === 'Receive Deliver'
      );
      const metrics = buildMetrics(tradeItems);
      return { items: allItems, metrics, ts: new Date().toISOString() };
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Operaciones de hoy
app.get('/api/today', async (req, res) => {
  try {
    const data = await cached('today', 30, async () => {
      const d = todayStr();
      return { items: await tt.getAllTransactions(d, d), ts: new Date().toISOString() };
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/refresh', (req, res) => { bustCache(); res.json({ ok: true }); });

// La Rueda — configuración de activos
const WHEEL_CFG = path.join(DATA_DIR, 'wheel_config.json');

function loadWheelConfig() {
  try {
    if (fs.existsSync(WHEEL_CFG)) return JSON.parse(fs.readFileSync(WHEEL_CFG,'utf8'));
  } catch(e) {}
  return { underlyings: ['JBLU','NU'] };
}
function saveWheelConfig(cfg) {
  fs.writeFileSync(WHEEL_CFG, JSON.stringify(cfg, null, 2), 'utf8');
}

app.get('/api/wheel-config', (req, res) => res.json(loadWheelConfig()));

app.post('/api/wheel-config', (req, res) => {
  const { action, underlying, startDate } = req.body;
  const cfg = loadWheelConfig();
  const sym = (underlying||'').toUpperCase().trim();
  if (!sym) return res.status(400).json({ error: 'Ticker requerido' });
  if (action === 'add') {
    const exists = cfg.underlyings.find(u => (typeof u === 'string' ? u : u.symbol) === sym);
    if (!exists) cfg.underlyings.push(startDate ? { symbol: sym, startDate } : sym);
    else if (startDate && typeof exists === 'string') {
      const idx = cfg.underlyings.indexOf(exists);
      cfg.underlyings[idx] = { symbol: sym, startDate };
    }
  }
  if (action === 'remove') cfg.underlyings = cfg.underlyings.filter(u => (typeof u === 'string' ? u : u.symbol) !== sym);
  if (action === 'setStartDate') {
    const idx = cfg.underlyings.findIndex(u => (typeof u === 'string' ? u : u.symbol) === sym);
    if (idx >= 0) cfg.underlyings[idx] = { symbol: sym, startDate: startDate || null };
  }
  saveWheelConfig(cfg);
  bustCache();
  res.json(cfg);
});

// Buying Power Dashboard
app.get('/api/bp-dashboard', async (req, res) => {
  try {
    const data = await cached('bp-dashboard', 60, async () => {
      const [balances, positions] = await Promise.all([tt.getBalances(), tt.getPositions()]);
      const cfg = loadWheelConfig();
      const wheelSymbols = new Set(cfg.underlyings.map(u => typeof u === 'string' ? u : u.symbol));

      const derivAvail  = parseFloat(balances['derivative-buying-power'] || 0);
      const equityAvail = parseFloat(balances['equity-buying-power'] || 0);
      const nlv         = parseFloat(balances['net-liquidating-value'] || 0);

      function parseSym(sym) {
        const m = (sym||'').trim().match(/([A-Z/ ]+?)\s*(\d{6})([CP])(\d{8})$/);
        if (!m) return {};
        return {
          optType: m[3],
          strike:  parseInt(m[4]) / 1000,
          expiry:  `20${m[2].slice(0,2)}-${m[2].slice(2,4)}-${m[2].slice(4,6)}`,
        };
      }

      // Separar equity (acciones) de opciones
      const equityPos = positions.filter(p => p['instrument-type'] === 'Equity');
      const optPos    = positions.filter(p => p['instrument-type'] === 'Equity Option');

      // Underlyings con acciones (para saber qué calls son CCs cubiertas)
      const stockUnds = new Set(equityPos.map(p => p['underlying-symbol']));

      // Agrupar opciones por (underlying, expiry, optType) para detectar spreads
      const optGroups = {};
      for (const p of optPos) {
        const und   = p['underlying-symbol'] || '';
        const parsed = parseSym(p.symbol || '');
        const key   = `${und}|${parsed.expiry}|${parsed.optType}`;
        if (!optGroups[key]) optGroups[key] = { und, expiry: parsed.expiry, optType: parsed.optType, shorts: [], longs: [] };
        const isShort = (p['quantity-direction'] || '').toLowerCase() === 'short';
        const entry = {
          sym: (p.symbol||'').trim(), strike: parsed.strike,
          qty: Math.abs(parseFloat(p.quantity || 0)),
          avgP: parseFloat(p['average-open-price'] || 0),
        };
        if (isShort) optGroups[key].shorts.push(entry);
        else          optGroups[key].longs.push(entry);
      }

      // Calcular BP de cada grupo de opciones (detectando spreads)
      const ruedaOptPos = [];
      const specOptPos  = [];

      for (const g of Object.values(optGroups)) {
        const isWheel = wheelSymbols.has(g.und);
        const arr = isWheel ? ruedaOptPos : specOptPos;
        const { shorts, longs, und, expiry, optType } = g;

        if (shorts.length > 0 && longs.length > 0) {
          // SPREAD: calcular ancho máximo de spread × 100 × qty mínima
          const shortStrikes = shorts.map(s => s.strike);
          const longStrikes  = longs.map(s => s.strike);
          const qty = Math.min(
            shorts.reduce((s,x) => s + x.qty, 0),
            longs.reduce((s,x)  => s + x.qty, 0)
          );
          let width;
          if (optType === 'P') {
            width = Math.max(...shortStrikes) - Math.min(...longStrikes);
          } else {
            width = Math.max(...longStrikes) - Math.min(...shortStrikes);
          }
          const bpUsed = Math.max(0, width) * 100 * qty;
          const sS = optType === 'P' ? Math.min(...shortStrikes) : Math.min(...shortStrikes);
          const lS = optType === 'P' ? Math.min(...longStrikes)  : Math.max(...longStrikes);
          arr.push({ underlying: und, type: 'Spread', qty, bpUsed: +bpUsed.toFixed(2),
            label: `${optType === 'P' ? 'Put' : 'Call'} spread $${lS}/$${Math.max(...shortStrikes)} (${expiry})` });

        } else if (shorts.length > 0) {
          // SHORT sin long: CSP/CC naked
          for (const s of shorts) {
            let bpUsed, label;
            if (optType === 'C' && (isWheel || stockUnds.has(und))) {
              bpUsed = 0;
              label  = `CC $${s.strike} cubierta (${expiry})`;
            } else {
              bpUsed = s.strike * 100 * s.qty;
              label  = `${optType === 'P' ? 'CSP' : 'Short Call'} $${s.strike} (${expiry})`;
            }
            arr.push({ underlying: und, type: 'Short Option', qty: s.qty, bpUsed: +bpUsed.toFixed(2), label });
          }
        }
        // Longs sin short: no consumen BP adicional (prima ya pagada)
      }

      // Acciones: avgPrice × qty (usan equity BP, no derivative)
      const ruedaStockPos = [];
      const specStockPos  = [];
      for (const p of equityPos) {
        const und  = p['underlying-symbol'] || p.symbol || '';
        const qty  = Math.abs(parseFloat(p.quantity || 0));
        const avgP = parseFloat(p['average-open-price'] || 0);
        const entry = { underlying: und, type: 'Equity', qty,
          bpUsed: +(avgP * qty).toFixed(2), label: `${qty} acc @ $${avgP.toFixed(2)}` };
        if (wheelSymbols.has(und)) ruedaStockPos.push(entry);
        else                       specStockPos.push(entry);
      }

      const ruedaOptBP   = ruedaOptPos.reduce((s, p)   => s + p.bpUsed, 0);
      const specOptBP    = specOptPos.reduce((s, p)    => s + p.bpUsed, 0);
      const ruedaStockBP = ruedaStockPos.reduce((s, p) => s + p.bpUsed, 0);
      const specStockBP  = specStockPos.reduce((s, p)  => s + p.bpUsed, 0);

      // Base del pie = total derivative BP (options used + options available)
      const optionsBase = ruedaOptBP + specOptBP + derivAvail || 1;
      const ruedaBP = ruedaOptBP + ruedaStockBP;
      const specBP  = specOptBP  + specStockBP;
      const libreBP = derivAvail;
      const base    = optionsBase;

      // Pie = derivative BP (options only): used_rueda + used_spec + available
      // Stocks se muestran por separado (equity BP pool diferente)
      const pctRueda = +(ruedaOptBP / base * 100).toFixed(1);
      const pctSpec  = +(specOptBP  / base * 100).toFixed(1);
      const pctLibre = +(libreBP    / base * 100).toFixed(1);

      return {
        base,                             // optionsBase = total derivative BP capacity
        ruedaBP:     +ruedaOptBP.toFixed(2),   // pie: solo opciones Rueda
        specBP:      +specOptBP.toFixed(2),    // pie: solo opciones Spec
        libreBP:     +libreBP.toFixed(2),      // pie: derivative BP disponible
        ruedaStockBP: +ruedaStockBP.toFixed(2), // info adicional: stocks Rueda
        specStockBP:  +specStockBP.toFixed(2),  // info adicional: stocks Spec
        nlv,
        pctRueda, pctSpec, pctLibre,
        derivAvail:  +derivAvail.toFixed(2),
        equityAvail: +equityAvail.toFixed(2),
        targets:  { rueda: 50, spec: 25, libre: 25 },
        ruedaPos:  [...ruedaOptPos, ...ruedaStockPos],
        specPos:   [...specOptPos,  ...specStockPos],
        ts: new Date().toISOString(),
      };
    });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// La Rueda — datos
app.get('/api/wheel', async (req, res) => {
  try {
    const data = await cached('wheel', 120, async () => {
      const { buildWheelData } = require('./src/wheel');
      const cfg = loadWheelConfig();
      const [items, positions] = await Promise.all([
        tt.getAllTransactions('2026-02-01', todayStr()),
        tt.getPositions(),
      ]);
      const underlyingSymbols = cfg.underlyings.map(u => typeof u === 'string' ? u : u.symbol);
      return { wheels: buildWheelData(items, positions, cfg.underlyings), underlyings: underlyingSymbols, ts: new Date().toISOString() };
    });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// NLV History — snapshots diarios
app.get('/api/nlv-history', (req, res) => {
  try {
    const history = loadNlvHistory();
    res.json({ history });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug-today-strategies', async (req, res) => {
  try {
    const today = todayStr();
    const txData = await tt.getAllTransactions(today, today);
    const { buildMetrics } = require('./src/metrics');
    const m = buildMetrics(txData);
    res.json({
      total: (m.strategies||[]).length,
      strategies: (m.strategies||[]).map(s => ({
        key:          s.key,
        underlying:   s.underlying,
        openDate:     s.openDate,
        closeDate:    s.closeDate,
        stratType:    s.stratType,
        pnl:          s.pnl,
        closeOrderId: s.closeOrderId,
      }))
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/margin-raw', async (req, res) => {
  try { res.json(await tt.getMarginRequirements()); }
  catch(e) { res.status(500).json({ error: e.message, stack: e.stack?.split('\n').slice(0,3) }); }
});

app.get('/api/health', (req, res) => res.json({
  ok: true, auth: !!tt.accessToken,
  tokenLen: (tt.accessToken || '').length,
  account: tt.accountNumber,
  ts: new Date().toISOString()
}));

// ── Reporte PDF ───────────────────────────────────────────────
app.get('/report', async (req, res) => {
  try {
    const [bal, positions, txData] = await Promise.all([
      tt.getBalances(),
      tt.getPositions(),
      tt.getAllTransactions('2026-02-01', todayStr()),
    ]);
    const { buildMetrics } = require('./src/metrics');
    const m        = buildMetrics(txData);
    const nlv      = parseFloat(bal?.['net-liquidating-value'] || 0);
    const initial  = 10644;
    const totalRet = ((nlv - initial) / initial * 100).toFixed(2);
    const nlvHist  = loadNlvHistory();
    const nlvByMonth = computeMonthlyNlv(nlvHist, nlv);
    const today    = todayStr();

    // Consolidar estrategias
    const allLegs  = m.strategies || [];
    const spreadMap = new Map();
    for (const leg of allLegs) {
      const isSpread = /Spread|Condor|Strangle/i.test(leg.stratType||'');
      const key = isSpread
        ? (leg.key || `${leg.underlying}_${leg.openDate}_${leg.closeDate}_${leg.stratType}`)
        : (leg.key || leg.symbol || Math.random().toString());
      if (!spreadMap.has(key)) spreadMap.set(key, { ...leg, pnl: 0, openValue: 0, closeValue: 0 });
      const s = spreadMap.get(key);
      s.pnl        += leg.pnl        || 0;
      s.openValue  += leg.openValue  || 0;
      s.closeValue += leg.closeValue || 0;
    }
    const trades = [...spreadMap.values()].sort((a,b) => new Date(b.closeDate)-new Date(a.closeDate));
    const recentTrades = trades.slice(0, 10);

    // Stats por estrategia
    const byStrat = {};
    trades.forEach(t => {
      const k = t.stratType || 'Otro';
      if (!byStrat[k]) byStrat[k] = { trades:0, wins:0, pnl:0 };
      byStrat[k].trades++;
      if (t.pnl > 0) byStrat[k].wins++;
      byStrat[k].pnl += t.pnl;
    });

    // Posiciones consolidadas
    const posMap = new Map();
    positions.filter(p => p['instrument-type'] !== 'Unknown').forEach(p => {
      const und = p['underlying-symbol'];
      if (!posMap.has(und)) posMap.set(und, { underlying:und, legs:[], pnlNoReal:0 });
      const op  = parseFloat(p['average-open-price']||0);
      const cp  = parseFloat(p['mark-price'] || p['average-daily-market-close-price'] || p['close-price']||0);
      const qty = parseFloat(p.quantity||0);
      const mul = parseFloat(p.multiplier||1);
      const dir = p['quantity-direction']==='Short' ? -1 : 1;
      const pnl = dir*(cp-op)*qty*mul;
      posMap.get(und).pnlNoReal += pnl;
      posMap.get(und).legs.push(p);
    });
    const openPositions = [...posMap.values()];
    const totalPnlNoReal = openPositions.reduce((a,b)=>a+b.pnlNoReal,0);

    const fa$ = n => '$' + Math.abs(parseFloat(n)||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    const f$  = n => { const v=parseFloat(n)||0; return (v>=0?'+':'')+v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); };
    const cc  = n => parseFloat(n)>=0?'pos':'neg';

    const monthRows = Object.entries(nlvByMonth).sort().map(([mo,pnl]) => {
      const label = new Date(+mo.slice(0,4), +mo.slice(5,7)-1).toLocaleDateString('es-CO',{month:'long',year:'numeric'});
      return `<tr>
        <td>${label.charAt(0).toUpperCase()+label.slice(1)}</td>
        <td class="${cc(pnl)}">${f$(pnl)}</td>
        <td class="${cc(pnl)}">${initial?(pnl/initial*100).toFixed(2)+'%':'—'}</td>
      </tr>`;
    }).join('');

    const stratRows = Object.entries(byStrat)
      .sort((a,b)=>b[1].pnl-a[1].pnl)
      .map(([k,v]) => `<tr>
        <td>${k}</td>
        <td>${v.trades}</td>
        <td>${v.trades?Math.round(v.wins/v.trades*100):0}%</td>
        <td class="${cc(v.pnl)}">${f$(v.pnl)}</td>
      </tr>`).join('');

    const tradeRows = recentTrades.map(t => `<tr>
      <td>${t.closeDate}</td>
      <td><strong>${t.underlying}</strong></td>
      <td>${t.stratType||'—'}</td>
      <td>${t.durationDays===0?'Intradía':t.durationDays+'d'}</td>
      <td class="pos">${t.openValue?'+'+fa$(Math.abs(t.openValue)):'—'}</td>
      <td class="${cc(t.pnl)}"><strong>${f$(t.pnl)}</strong></td>
    </tr>`).join('');

    const posRows = openPositions.map(p => {
      const mainLeg = p.legs[0];
      return `<tr>
        <td><strong>${p.underlying}</strong></td>
        <td>${p.legs.length > 1 ? 'Spread/Multi' : mainLeg['instrument-type']==='Equity'?'Acciones':'Opción'}</td>
        <td>${p.legs.length}</td>
        <td class="${cc(p.pnlNoReal)}">${f$(p.pnlNoReal)}</td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Bitácora Tasty — Informe ${today}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color:#1a1a2e; background:#fff; font-size:13px; }

  /* PORTADA */
  .cover { height:100vh; display:flex; flex-direction:column; justify-content:center; align-items:center;
    background:linear-gradient(135deg,#0d1117 0%,#161b27 50%,#0d1117 100%); color:#fff; text-align:center; page-break-after:always; }
  .cover-logo { font-size:48px; margin-bottom:20px; }
  .cover-title { font-size:36px; font-weight:700; letter-spacing:2px; color:#13d68f; margin-bottom:8px; }
  .cover-sub { font-size:18px; color:#8892a4; margin-bottom:40px; }
  .cover-trader { font-size:22px; font-weight:600; color:#f5c842; margin-bottom:8px; }
  .cover-date { font-size:14px; color:#4e5a70; }
  .cover-divider { width:80px; height:3px; background:linear-gradient(90deg,#13d68f,#5b82e6); margin:24px auto; border-radius:2px; }

  /* CONTENIDO */
  .page { padding:40px 48px; page-break-after:always; }
  .page:last-child { page-break-after:auto; }

  h1 { font-size:22px; color:#0d1117; border-bottom:2px solid #13d68f; padding-bottom:8px; margin-bottom:24px; }
  h2 { font-size:16px; color:#161b27; margin:24px 0 12px; font-weight:600; }

  /* KPI CARDS */
  .kpi-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; margin-bottom:32px; }
  .kpi-card { background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:18px; text-align:center; }
  .kpi-label { font-size:10px; color:#64748b; text-transform:uppercase; letter-spacing:.08em; margin-bottom:6px; }
  .kpi-value { font-size:24px; font-weight:700; color:#0d1117; }
  .kpi-sub { font-size:11px; color:#94a3b8; margin-top:4px; }
  .kpi-card.green .kpi-value { color:#059669; }
  .kpi-card.red .kpi-value { color:#dc2626; }
  .kpi-card.blue .kpi-value { color:#2563eb; }
  .kpi-card.gold .kpi-value { color:#d97706; }

  /* TABLAS */
  table { width:100%; border-collapse:collapse; margin-bottom:24px; font-size:12px; }
  th { background:#0d1117; color:#fff; padding:10px 12px; text-align:left; font-size:11px; font-weight:600; letter-spacing:.05em; }
  td { padding:9px 12px; border-bottom:1px solid #f1f5f9; }
  tr:hover td { background:#f8fafc; }
  .pos { color:#059669; font-weight:600; }
  .neg { color:#dc2626; font-weight:600; }

  /* FIRMA */
  .footer { margin-top:40px; padding-top:16px; border-top:1px solid #e2e8f0; display:flex; justify-content:space-between;
    font-size:10px; color:#94a3b8; }

  @media print {
    .cover { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    .kpi-card { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    th { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  }
</style>
</head>
<body>

<!-- PORTADA -->
<div class="cover">
  <div class="cover-logo">📊</div>
  <div class="cover-title">BITÁCORA TASTY</div>
  <div class="cover-sub">Informe de Trading — Opciones sobre Acciones</div>
  <div class="cover-divider"></div>
  <div class="cover-trader">Guillermo Carvajal</div>
  <div class="cover-date">Generado: ${today} · Período: Feb 2026 — ${today}</div>
</div>

<!-- PAG 1: RESUMEN EJECUTIVO -->
<div class="page">
  <h1>📈 Resumen Ejecutivo</h1>
  <div class="kpi-grid">
    <div class="kpi-card ${nlv>=initial?'green':'red'}">
      <div class="kpi-label">Net Liquidating Value</div>
      <div class="kpi-value">${fa$(nlv)}</div>
      <div class="kpi-sub">Capital actual</div>
    </div>
    <div class="kpi-card ${parseFloat(totalRet)>=0?'green':'red'}">
      <div class="kpi-label">Retorno Total</div>
      <div class="kpi-value">${totalRet}%</div>
      <div class="kpi-sub">vs capital inicial ${fa$(initial)}</div>
    </div>
    <div class="kpi-card ${m.totalPnL>=0?'green':'red'}">
      <div class="kpi-label">P&L Realizado</div>
      <div class="kpi-value">${f$(m.totalPnL)}</div>
      <div class="kpi-sub">Trades cerrados</div>
    </div>
    <div class="kpi-card blue">
      <div class="kpi-label">Win Rate</div>
      <div class="kpi-value">${m.winRate}%</div>
      <div class="kpi-sub">${m.totalStrategies} trades totales</div>
    </div>
    <div class="kpi-card gold">
      <div class="kpi-label">Profit Factor</div>
      <div class="kpi-value">${m.profitFactor}x</div>
      <div class="kpi-sub">Ganancia/Pérdida ratio</div>
    </div>
    <div class="kpi-card red">
      <div class="kpi-label">Comisiones Pagadas</div>
      <div class="kpi-value">-${fa$(m.totalComm)}</div>
      <div class="kpi-sub">Al broker</div>
    </div>
  </div>

  <h2>Resultados Mensuales (Net Liq Real)</h2>
  <table>
    <thead><tr><th>Mes</th><th>P&L</th><th>% Retorno</th></tr></thead>
    <tbody>${monthRows}</tbody>
  </table>

  <div class="footer">
    <span>Bitácora Tasty — Guillermo Carvajal</span>
    <span>Generado ${today}</span>
  </div>
</div>

<!-- PAG 2: ESTRATEGIAS -->
<div class="page">
  <h1>🎯 Análisis por Estrategia</h1>
  <table>
    <thead><tr><th>Estrategia</th><th>Trades</th><th>Win Rate</th><th>P&L</th></tr></thead>
    <tbody>${stratRows}</tbody>
  </table>

  <h2>Últimos 10 Trades Cerrados</h2>
  <table>
    <thead><tr><th>Cierre</th><th>Símbolo</th><th>Estrategia</th><th>Duración</th><th>Prima</th><th>P&L</th></tr></thead>
    <tbody>${tradeRows}</tbody>
  </table>

  <div class="footer">
    <span>Bitácora Tasty — Guillermo Carvajal</span>
    <span>Generado ${today}</span>
  </div>
</div>

<!-- PAG 3: POSICIONES ABIERTAS -->
<div class="page">
  <h1>📋 Posiciones Abiertas</h1>
  <div class="kpi-grid" style="grid-template-columns:repeat(2,1fr);margin-bottom:24px;">
    <div class="kpi-card ${totalPnlNoReal>=0?'green':'red'}">
      <div class="kpi-label">P&L No Realizado Total</div>
      <div class="kpi-value">${f$(totalPnlNoReal)}</div>
      <div class="kpi-sub">${openPositions.length} subyacentes</div>
    </div>
    <div class="kpi-card blue">
      <div class="kpi-label">Posiciones Abiertas</div>
      <div class="kpi-value">${positions.length}</div>
      <div class="kpi-sub">patas individuales</div>
    </div>
  </div>
  <table>
    <thead><tr><th>Subyacente</th><th>Tipo</th><th>Patas</th><th>P&L No Real</th></tr></thead>
    <tbody>${posRows}</tbody>
  </table>

  <div class="footer">
    <span>Bitácora Tasty — Guillermo Carvajal</span>
    <span>Confidencial · Generado ${today}</span>
  </div>
</div>

</body>
</html>`;

    res.send(html);
  } catch(e) {
    res.status(500).send(`<pre>Error generando reporte: ${e.message}</pre>`);
  }
});
// ── Trade Journal ─────────────────────────────────────────────
const TN_FILE = path.join(DATA_DIR, 'trade_notes.json');
const WL_FILE = path.join(DATA_DIR, 'watchlist.json');
// Copiar archivos base al DATA_DIR si no existen (primera vez)
if (DATA_DIR !== __dirname) {
  const baseFiles = ['watchlist.json','trade_notes.json','playbooks.json',
    'alejandro_checklists.json','spx_config.json','algo_signals.json','wheel_config.json','nlv_history.json'];
  baseFiles.forEach(f => {
    const dest = path.join(DATA_DIR, f);
    const src  = path.join(__dirname, f);
    if (!fs.existsSync(dest) && fs.existsSync(src)) {
      try { fs.copyFileSync(src, dest); console.log('[DATA] Copiado:', f); } catch(e) {}
    }
  });
}
function loadNotes()  { try { return JSON.parse(fs.readFileSync(TN_FILE,'utf8')); } catch(e) { return {}; } }
function saveNotes(d) { fs.writeFileSync(TN_FILE, JSON.stringify(d,null,2),'utf8'); }

app.get('/api/trade-notes', (req, res) => res.json(loadNotes()));

app.post('/api/trade-notes/:key', (req, res) => {
  const notes = loadNotes();
  const key   = decodeURIComponent(req.params.key);
  notes[key]  = { ...(notes[key]||{}), ...req.body, updatedAt: new Date().toISOString() };
  saveNotes(notes);
  res.json(notes[key]);
});

app.delete('/api/trade-notes/:key', (req, res) => {
  const notes = loadNotes();
  delete notes[decodeURIComponent(req.params.key)];
  saveNotes(notes);
  res.json({ ok:true });
});

// ── TradingView Screenshot via CDP ────────────────────────────
app.post('/api/tv-screenshot', async (req, res) => {
  try {
    const CDP_PORT = 9223;
    const listResp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const targets  = await listResp.json();
    const tv = targets.find(t => t.type==='page' && t.url.includes('tradingview.com/chart'));
    if (!tv) return res.status(404).json({ error:'TradingView no está abierto en Edge (puerto 9223). Ábrelo con el bot.' });

    const WebSocket = require('ws');
    const screenshot = await new Promise((resolve, reject) => {
      const ws = new WebSocket(tv.webSocketDebuggerUrl);
      let done = false;
      ws.on('open', () => {
        ws.send(JSON.stringify({ id:1, method:'Page.enable' }));
        ws.send(JSON.stringify({ id:2, method:'Page.captureScreenshot',
          params:{ format:'jpeg', quality:80 } }));
      });
      ws.on('message', raw => {
        const msg = JSON.parse(raw.toString());
        if (msg.id===2 && msg.result?.data && !done) {
          done = true; ws.close(); resolve(msg.result.data);
        }
      });
      ws.on('error', reject);
      setTimeout(() => { if(!done){ ws.close(); reject(new Error('Timeout')); } }, 10000);
    });

    res.json({ screenshot:`data:image/jpeg;base64,${screenshot}`, symbol:tv.title });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Watchlist ─────────────────────────────────────────────────
function loadWatchlist() {
  try {
    let raw = fs.readFileSync(WL_FILE,'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // strip BOM
    return JSON.parse(raw); }
  catch(e) { return { stocks:[] }; }
}
function saveWatchlist(d) { fs.writeFileSync(WL_FILE, JSON.stringify(d,null,2),'utf8'); }


// ── Evaluar todos los tickers del watchlist con Playbook Auto ─
app.post('/api/watchlist/eval-all', async (req, res) => {
  try {
    const wl = loadWatchlist();
    const tickers = wl.stocks.map(s => s.symbol);
    if (!tickers.length) return res.json({ ok: true, evaluated: 0 });

    const calcEMA = (data, period) => {
      const k = 2/(period+1); let e = null;
      for (let i = 0; i < data.length; i++) {
        if (i < period-1) continue;
        if (i === period-1) e = data.slice(0, period).reduce((a,b) => a+b, 0) / period;
        else e = data[i]*k + e*(1-k);
      }
      return e ? +e.toFixed(4) : null;
    };
    const calcMACD = (data) => {
      const k12=2/13, k26=2/27, k9=2/10;
      let e12=null, e26=null, sig=null;
      for (let i = 0; i < data.length; i++) {
        const c = data[i];
        e12 = e12===null ? c : c*k12 + e12*(1-k12);
        e26 = e26===null ? c : c*k26 + e26*(1-k26);
        if (i < 25) continue;
        const m = e12-e26; sig = sig===null ? m : m*k9 + sig*(1-k9);
      }
      return { line: e12-e26, signal: sig, hist: (e12-e26)-sig };
    };
    const calcRSILocal = (data, period=14) => {
      if (data.length < period+1) return 50;
      let gains=0, losses=0;
      for (let i=1; i<=period; i++) { const d=data[i]-data[i-1]; if(d>0) gains+=d; else losses+=Math.abs(d); }
      let ag=gains/period, al=losses/period;
      for (let i=period+1; i<data.length; i++) { const d=data[i]-data[i-1]; ag=(ag*(period-1)+(d>0?d:0))/period; al=(al*(period-1)+(d<0?Math.abs(d):0))/period; }
      return al===0 ? 100 : +( 100 - 100/(1+ag/al) ).toFixed(1);
    };

    const today = new Date().toISOString().slice(0,10);
    const signals = loadSignals ? loadSignals() : {};
    const results = [];

    for (const sym of tickers) {
      try {
        const yhSym = encodeURIComponent(sym);
        const r = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${yhSym}?interval=1d&range=6mo`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        const j = await r.json();
        const result = j.chart?.result?.[0];
        if (!result) { results.push({ sym, error: 'Sin datos' }); continue; }

        const closes = result.indicators.quote[0].close.filter(v => v != null);
        const vols   = result.indicators.quote[0].volume.filter(v => v != null);
        if (closes.length < 30) { results.push({ sym, error: 'Insuficientes' }); continue; }

        const precio = closes.at(-1);
        const ema10  = calcEMA(closes, 10);
        const ema20  = calcEMA(closes, 20);
        const ema50  = calcEMA(closes, 50);
        const ema200 = closes.length >= 200 ? calcEMA(closes, 200) : null;
        const macd   = calcMACD(closes);
        const rsi    = calcRSILocal(closes);
        const volReciente = vols.slice(-5).reduce((a,b)=>a+b,0)/5;
        const volMedia20  = vols.slice(-20).reduce((a,b)=>a+b,0)/20;
        const relVol = volMedia20 > 0 ? +(volReciente/volMedia20).toFixed(2) : 1;

        const sobreEma20  = precio > ema20;
        const sobreEma50  = precio > (ema50||ema20);
        const sobreEma200 = ema200 ? precio > ema200 : null;
        const ema10Alc    = ema10 > ema20;
        const ema20Alc    = ema50 ? ema20 > ema50 : null;
        const ema50Alc    = ema200 ? ema50 > ema200 : null;
        const emasAlc = [ema10Alc, ema20Alc, ema50Alc].filter(v=>v===true).length;
        const emasBaj = [!ema10Alc, ema20Alc===false, ema50Alc===false].filter(v=>v===true).length;
        const macdAlc = macd.line > 0 && macd.hist > 0;
        const macdBaj = macd.line < 0 && macd.hist < 0;

        const ciar = signals[sym];
        const ciarAge = ciar ? Math.floor((Date.now()-new Date(ciar.receivedAt).getTime())/60000) : null;
        const ciarFresh = ciarAge !== null && ciarAge < 1440;

        // Score alcista
        const dir_alc = ((sobreEma20?0.4:0)+(sobreEma50?0.3:0)+(sobreEma200===true?0.3:sobreEma200===null?0.15:0))*30/100
                      + (emasAlc>=2?1.0:emasAlc===1?0.5:0)*40/100
                      + ((sobreEma20?0.5:0)+(rsi>=50&&rsi<=70?0.5:rsi>30&&rsi<50?0.25:0))*30/100;
        const trig_alc = (ema10Alc?1.0:0)*60/100 + (relVol>=1.5?1.0:relVol>=1?0.5:0)*20/100
                       + ((ciarFresh&&ciar.signal==='BUY')?1.0:relVol>1.2&&sobreEma20?0.5:0)*20/100;
        const fuerz_alc = (macdAlc?1.0:macd.hist>0?0.5:0)*45/100
                        + ((ciarFresh&&ciar.signal==='BUY')?1.0:macdAlc?0.4:0)*45/100 + 0.5*10/100;
        const scoreAlc = Math.round((dir_alc+trig_alc+fuerz_alc)/3*100);

        // Score bajista
        const dir_baj = ((!sobreEma20?0.4:0)+(!sobreEma50?0.3:0)+(sobreEma200===false?0.3:sobreEma200===null?0.15:0))*30/100
                      + (emasBaj>=2?1.0:emasBaj===1?0.5:0)*40/100
                      + ((!sobreEma20?0.5:0)+(rsi>=30&&rsi<=50?0.5:rsi>50&&rsi<70?0.25:0))*30/100;
        const trig_baj = (!ema10Alc?1.0:0)*60/100 + (relVol>=1.5?1.0:relVol>=1?0.5:0)*20/100
                       + ((ciarFresh&&ciar.signal==='SELL')?1.0:relVol>1.2&&!sobreEma20?0.5:0)*20/100;
        const fuerz_baj = (macdBaj?1.0:macd.hist<0?0.5:0)*45/100
                        + ((ciarFresh&&ciar.signal==='SELL')?1.0:macdBaj?0.4:0)*45/100 + 0.5*10/100;
        const scoreBaj = Math.round((dir_baj+trig_baj+fuerz_baj)/3*100);

        const scoreMejor = Math.max(scoreAlc, scoreBaj);
        const tesis = scoreAlc >= scoreBaj ? 'alcista' : 'bajista';

        let fase = 'F1';
        if (emasAlc >= 2 && sobreEma20) fase = emasAlc === 3 ? 'F2' : 'F2~';
        else if (emasBaj >= 2 && !sobreEma20) fase = emasBaj === 3 ? 'F4' : 'F4~';
        else if (sobreEma20 && !ema10Alc) fase = 'F3';

        // Guardar en scoreHistory del stock
        const stock = wl.stocks.find(s => s.symbol === sym);
        if (stock) {
          if (!stock.scoreHistory) stock.scoreHistory = [];
          // Sobreescribir si ya hay entrada de hoy
          const idx = stock.scoreHistory.findIndex(e => e.date === today);
          const entry = {
            date: today,
            scoreAlc, scoreBaj, scoreMejor, tesis, fase,
            modulos: {
              alc: { dir: Math.round(dir_alc*100), trig: Math.round(trig_alc*100), fuerz: Math.round(fuerz_alc*100) },
              baj: { dir: Math.round(dir_baj*100), trig: Math.round(trig_baj*100), fuerz: Math.round(fuerz_baj*100) },
            },
            precio: +precio.toFixed(2), rsi, relVol,
          };
          if (idx >= 0) stock.scoreHistory[idx] = entry;
          else stock.scoreHistory.push(entry);
          // Actualizar también scoreAuto y tesisAuto del stock
          stock.scoreAuto = scoreMejor;
          stock.tesisAuto = tesis;
        }
        results.push({ sym, scoreMejor, tesis, fase });
        await new Promise(r => setTimeout(r, 100));
      } catch(e) {
        results.push({ sym, error: e.message });
      }
    }

    saveWatchlist(wl);
    res.json({ ok: true, evaluated: results.length, date: today, results });
  } catch(e) {
    console.error('[eval-all]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Score History por ticker ──────────────────────────────────
app.get('/api/watchlist/:symbol/score-history', (req, res) => {
  const wl = loadWatchlist();
  const stock = wl.stocks.find(s => s.symbol === req.params.symbol.toUpperCase());
  if (!stock) return res.status(404).json({ error: 'No encontrado' });
  res.json(stock.scoreHistory || []);
});

app.get('/api/watchlist', (req, res) => res.json(loadWatchlist()));

app.post('/api/watchlist', (req, res) => {
  try {
    const wl = loadWatchlist();
    const { symbol, name, status, screener, scoreAuto, tesisAuto } = req.body;
    if (!symbol) return res.status(400).json({ error:'Symbol requerido' });
    const sym = symbol.toUpperCase();
    if (wl.stocks.find(s => s.symbol === sym)) return res.status(409).json({ error:'Ya existe' });
    const stock = { symbol:sym, name:name||sym, status:status||'orange', screener:screener||'', addedDate:todayStr(), notes:[], scoreAuto:scoreAuto||null, tesisAuto:tesisAuto||null };
    wl.stocks.push(stock);
    saveWatchlist(wl);
    res.json(stock);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.put('/api/watchlist/:symbol', (req, res) => {
  const wl = loadWatchlist();
  const s  = wl.stocks.find(s => s.symbol === req.params.symbol.toUpperCase());
  if (!s) return res.status(404).json({ error:'No encontrado' });
  if (req.body.status)  s.status  = req.body.status;
  if (req.body.name)    s.name    = req.body.name;
  if (req.body.screener !== undefined) s.screener = req.body.screener;
  saveWatchlist(wl);
  res.json(s);
});

app.delete('/api/watchlist/:symbol', (req, res) => {
  const wl = loadWatchlist();
  wl.stocks = wl.stocks.filter(s => s.symbol !== req.params.symbol.toUpperCase());
  saveWatchlist(wl);
  res.json({ ok:true });
});

app.post('/api/watchlist/:symbol/note', (req, res) => {
  const wl  = loadWatchlist();
  const s   = wl.stocks.find(s => s.symbol === req.params.symbol.toUpperCase());
  if (!s) return res.status(404).json({ error:'No encontrado' });
  const note = {
    id:     `n${Date.now()}`,
    date:   todayStr(),
    status: req.body.status || s.status,
    text:   req.body.text   || '',
    image:  req.body.image  || null,
  };
  s.notes.unshift(note);
  if (req.body.status) s.status = req.body.status;
  saveWatchlist(wl);
  res.json(note);
});

app.delete('/api/watchlist/:symbol/note/:noteId', (req, res) => {
  const wl = loadWatchlist();
  const s  = wl.stocks.find(s => s.symbol === req.params.symbol.toUpperCase());
  if (!s) return res.status(404).json({ error:'No encontrado' });
  s.notes  = s.notes.filter(n => n.id !== req.params.noteId);
  saveWatchlist(wl);
  res.json({ ok:true });
});

app.get('/api/watchlist/:symbol/fundamentals', async (req, res) => {
  try {
    const sym   = req.params.symbol.toUpperCase();
    const yhSym = sym === 'SPX' ? '%5EGSPC' : encodeURIComponent(sym);

    // Precio + datos básicos de Yahoo Finance
    const [prR, earR, vixR] = await Promise.all([
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${yhSym}?interval=1d&range=45d`, { headers:{'User-Agent':'Mozilla/5.0'} }),
      fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${yhSym}?modules=summaryDetail,defaultKeyStatistics,calendarEvents,assetProfile`, { headers:{'User-Agent':'Mozilla/5.0'} }),
      fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1y', { headers:{'User-Agent':'Mozilla/5.0'} }),
    ]);

    const prJ  = await prR.json();
    const earJ = await earR.json();
    const vixJ = await vixR.json();

    // Precio e histórico
    const closes = prJ.chart.result[0].indicators.quote[0].close.filter(v=>v!=null);
    const price  = Math.round(closes.at(-1) * 100) / 100;
    const prev   = closes.at(-2) || price;
    const chg    = Math.round((price - prev) * 100) / 100;
    const chgPct = Math.round((chg/prev)*10000)/100;
    const rsi    = calcRSI(closes);
    const hi52   = Math.round(Math.max(...closes) * 100) / 100;
    const lo52   = Math.round(Math.min(...closes) * 100) / 100;

    // Fundamentales
    const sd  = earJ.quoteSummary?.result?.[0]?.summaryDetail || {};
    const ap  = earJ.quoteSummary?.result?.[0]?.assetProfile || {};
    const ks  = earJ.quoteSummary?.result?.[0]?.defaultKeyStatistics || {};
    const cal = earJ.quoteSummary?.result?.[0]?.calendarEvents || {};
    const pe       = sd.trailingPE?.raw  || sd.forwardPE?.raw  || null;
    const mktCap   = sd.marketCap?.raw   || null;
    const divYield = sd.dividendYield?.raw || null;
    const beta     = sd.beta?.raw || null;
    const shortFloat = ks.shortPercentOfFloat?.raw || null;

    // Earnings
    let earningsDays = 999;
    const eTs = cal.earnings?.earningsDate?.[0]?.raw;
    if (eTs) earningsDays = Math.round((eTs*1000 - Date.now()) / 86400000);

    // IV Rank via VIX
    const vixPrices = vixJ.chart.result[0].indicators.quote[0].close.filter(v=>v!=null);
    const vix    = Math.round(vixPrices.at(-1) * 100) / 100;
    const ivRank = Math.round((vix - Math.min(...vixPrices)) / (Math.max(...vixPrices) - Math.min(...vixPrices)) * 100);

    // Opción Sigma FMP (fundamentales adicionales)
    let fmp = {};
    try {
      const fmpR = await fetch(
        `https://jrcdslfwrasitrvjboho.supabase.co/functions/v1/proxy/fmp/quote?symbol=${sym}`,
        { headers:{'origin':'https://www.opcionsigma.com','referer':'https://www.opcionsigma.com/'} }
      );
      const fmpJ = await fmpR.json();
      if (Array.isArray(fmpJ) && fmpJ[0]) fmp = fmpJ[0];
    } catch(e) {}

    res.json({
      symbol: sym, price, chg, chgPct, rsi, vix, ivRank,
      sector: ap.sector||null, industry: ap.industry||null,
      hi52, lo52, earningsDays,
      pe:        pe        ? Math.round(pe*10)/10   : null,
      mktCap:    mktCap    ? (mktCap/1e9).toFixed(1)+'B' : null,
      beta:      beta      ? Math.round(beta*100)/100 : null,
      divYield:  divYield  ? Math.round(divYield*1000)/10+'%' : null,
      shortFloat:shortFloat? Math.round(shortFloat*1000)/10+'%' : null,
      fmpPrice:  fmp.price || null,
      fmpAvg50:  fmp.priceAvg50 || null,
      fmpAvg200: fmp.priceAvg200 || null,
      fmpYearHigh: fmp.yearHigh || null,
      fmpYearLow:  fmp.yearLow  || null,
    });
  } catch(e) { res.status(500).json({ error:e.message }); }
});
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a,b)=>a+b,0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i]*k + ema*(1-k);
  return +ema.toFixed(4);
}

function calcMACD(closes) {
  if (closes.length < 35) return { line: null, signal: null, hist: null, histPrev: null, bullish: false, bearish: false, slope: 0 };
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const line  = +(ema12 - ema26).toFixed(4);
  // Signal: EMA9 de los últimos valores MACD
  const macdSeries = [];
  for (let i = 25; i < closes.length; i++) {
    const e12 = calcEMA(closes.slice(0, i+1), 12);
    const e26 = calcEMA(closes.slice(0, i+1), 26);
    macdSeries.push(e12 - e26);
  }
  const signal = macdSeries.length >= 9 ? +calcEMA(macdSeries, 9).toFixed(4) : null;
  const hist   = signal !== null ? +(line - signal).toFixed(4) : null;

  // Pendiente del histograma (vs. la barra anterior) — hacía falta para el
  // check "cruce y pendiente" del score (bullish/bearish/slope no existían
  // acá, aunque el calcMACD de src/spx_indicators.js sí los calculaba — como
  // este es el que realmente arma indicators.daily/m15/m2.macd en producción,
  // el check de MACD del playbook nunca tuvo bullish/bearish reales para leer).
  let histPrev = null;
  if (macdSeries.length >= 10) {
    const prevSeries  = macdSeries.slice(0, -1);
    const linePrev    = +prevSeries[prevSeries.length - 1].toFixed(4);
    const signalPrev  = +calcEMA(prevSeries, 9).toFixed(4);
    histPrev = +(linePrev - signalPrev).toFixed(4);
  }

  // Linea MACD de 3 velas atras — usada en vez de "slope" (delta del histograma
  // en 1 sola vela, muy ruidoso: puede bajar un poco en una vela suelta aunque
  // la linea siga claramente en ascenso, confirmado 2026-07-08 contra un caso
  // real donde el MACD se veia alcista en el grafico pero slope daba negativo).
  // La linea (EMA12-EMA26) es mas suave que el histograma, y mirarla en una
  // ventana de 3 velas filtra el ruido de una sola vela.
  const linePrev3 = macdSeries.length >= 4 ? +macdSeries[macdSeries.length - 4].toFixed(4) : null;

  return {
    line, signal, hist, histPrev, linePrev3,
    bullish: signal !== null ? line > signal : false,
    bearish: signal !== null ? line < signal : false,
    slope:   hist !== null && histPrev !== null ? +(hist - histPrev).toFixed(4) : 0,
  };
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag * (period-1) + Math.max(d, 0)) / period;
    al = (al * (period-1) + Math.max(-d, 0)) / period;
  }
  if (al === 0) return 100;
  return Math.round((100 - 100 / (1 + ag/al)) * 10) / 10;
}

app.get('/api/market-data/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const isIndex = ['SPX','SPY','QQQ','IWM','NDX','RUT'].includes(symbol);
    const yhSym = symbol === 'SPX' ? '%5EGSPC'
                : symbol === 'NDX' ? '%5EIXIC'
                : symbol === 'RUT' ? '%5ERUT'
                : encodeURIComponent(symbol);

    // VIX actual + historial 1 año (para IV Rank)
    const vixR = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1y',
      { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const vixJ = await vixR.json();
    const vixPrices = vixJ.chart.result[0].indicators.quote[0].close.filter(v => v != null);
    const vix      = Math.round(vixPrices.at(-1) * 100) / 100;
    const vix52H   = Math.round(Math.max(...vixPrices) * 100) / 100;
    const vix52L   = Math.round(Math.min(...vixPrices) * 100) / 100;
    const ivRank   = Math.round((vix - vix52L) / (vix52H - vix52L) * 100);

    // RSI, EMA, MACD — 90 días para tener suficiente historia
    const prR = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${yhSym}?interval=1d&range=6mo`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const prJ = await prR.json();
    const result0    = prJ.chart.result[0];
    const timestamps = result0.timestamp;
    const quote      = result0.indicators.quote[0];
    const rawCloses  = quote.close;
    const closes     = rawCloses.filter(v => v != null);
    // OHLC para candlestick chart
    const priceHistory = timestamps.map((t, i) => ({
      time:  t,
      open:  quote.open[i]  ? +quote.open[i].toFixed(2)  : null,
      high:  quote.high[i]  ? +quote.high[i].toFixed(2)  : null,
      low:   quote.low[i]   ? +quote.low[i].toFixed(2)   : null,
      close: quote.close[i] ? +quote.close[i].toFixed(2) : null,
    })).filter(d => d.close !== null);
    const rsi       = calcRSI(closes);
    const price     = Math.round(closes.at(-1) * 100) / 100;
    const prev      = closes.at(-2) || price;
    const chg       = Math.round((price - prev) * 100) / 100;
    const chgPct    = Math.round((chg / prev) * 10000) / 100;
    const ema10     = calcEMA(closes, 10);
    const ema20     = calcEMA(closes, 20);
    const macd      = calcMACD(closes);

    // Earnings + Sector — solo acciones individuales
    let earningsDays = 999;
    let sector = null, industry = null;
    if (!isIndex) {
      try {
        // Earnings desde calendarEvents
        const eR = await fetch(
          `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${yhSym}?modules=calendarEvents`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const eJ  = await eR.json();
        const eTs = eJ.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate?.[0]?.raw;
        if (eTs) earningsDays = Math.round((eTs * 1000 - Date.now()) / 86400000);
      } catch(e) {}
      try {
        // Sector e Industry desde search endpoint (más confiable)
        const sR = await fetch(
          `https://query1.finance.yahoo.com/v1/finance/search?q=${yhSym}&quotesCount=1&newsCount=0`,
          { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.yahoo.com' } });
        const sJ = await sR.json();
        const sq = sJ.quotes?.[0];
        if (sq?.quoteType === 'EQUITY') {
          sector   = sq.sector   || null;
          industry = sq.industry || null;
        }
      } catch(e) {}
    }

    res.json({
      symbol, price, chg, chgPct, vix, ivRank, rsi, earningsDays,
      ema10, ema20, priceHistory, sector, industry,
      macdLine: macd.line, macdSignal: macd.signal, macdHist: macd.hist,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Playbooks ────────────────────────────────────────────────
const PB_FILE2 = path.join(DATA_DIR, 'playbooks.json');
function loadPlaybooksData() {
  try { return JSON.parse(fs.readFileSync(PB_FILE2,'utf8')); }
  catch(e) { return { playbooks:[] }; }
}
function savePlaybooksData(data) { fs.writeFileSync(PB_FILE2, JSON.stringify(data,null,2),'utf8'); }

app.get('/api/playbooks', (req, res) => res.json(loadPlaybooksData()));
app.post('/api/playbooks', (req, res) => {
  const data = loadPlaybooksData();
  const pb = req.body;
  pb.id = pb.id || `pb-${Date.now()}`;
  const idx = data.playbooks.findIndex(p=>p.id===pb.id);
  if (idx>=0) data.playbooks[idx]=pb; else data.playbooks.push(pb);
  savePlaybooksData(data);
  res.json(pb);
});
app.delete('/api/playbooks/:id', (req, res) => {
  const data = loadPlaybooksData();
  data.playbooks = data.playbooks.filter(p=>p.id!==req.params.id);
  savePlaybooksData(data);
  res.json({ok:true});
});

// ── Screeners Paradigma (Finviz scraping) ────────────────────
const SCREENERS = {
  fuerza: {
    label: '💪 Fuerza',
    desc:  'Mercado baja pero estos suben hoy',
    url:   'https://finviz.com/screener.ashx?v=111&f=an_recom_buybetter,sh_avgvol_o500,sh_price_o20,ta_perf2_dp&ft=4',
  },
  x2: {
    label: '🚀 X2',
    desc:  'Doblan en el año (+100% YTD)',
    url:   'https://finviz.com/screener.ashx?v=111&f=sh_avgvol_o500,sh_price_o20,ta_perf_ytd100o&ft=4',
  },
  maximos: {
    label: '📈 Máximos Anuales',
    desc:  'Nuevos máximos de 52 semanas',
    url:   'https://finviz.com/screener.ashx?v=111&f=sh_avgvol_o500,sh_price_o20,ta_highlow52w_nh&ft=4',
  },
  gangas: {
    label: '🎯 Gangas',
    desc:  'P/E bajo, dividendo, oversold',
    url:   'https://finviz.com/screener.ashx?v=111&f=fa_div_o1,fa_pe_u25,op_option_optionshort,sh_opt_option,sh_price_u30,ta_beta_u1,ta_rsi_os40&ft=4',
  },
  volumazo: {
    label: '💥 Volumazo',
    desc:  'Volumen relativo +5x en alza',
    url:   'https://finviz.com/screener.ashx?v=111&f=sh_avgvol_o1000,sh_price_o10,sh_relvol_o5,ta_perf2_dp&ft=4',
  },
  gapeadoras: {
    label: '⚡ Gapeadoras',
    desc:  'Gap up +3% con volumen',
    url:   'https://finviz.com/screener.ashx?v=111&f=sh_avgvol_o500,sh_gap_u3,sh_price_o20,sh_relvol_o3,ta_perf2_dp&ft=4',
  },
  cercaemas: {
    label: '📍 Cerca EMAs',
    desc:  'Precio cruzando SMA20 | Beta >1.5 | Vol >1M | RelVol >1',
    url:   'https://finviz.com/screener.ashx?v=111&f=op_option_optionshort,sh_avgvol_o1000,sh_relvol_o1,ta_beta_o1.5,ta_sma20_cross&ft=4',
  },
  rueda: {
    label: '🔄 La Rueda',
    desc:  'Candidatos para CSP: opciones, precio $15-$200, Beta <1.3, sobre SMA200, volumen >500k',
    url:   'https://finviz.com/screener.ashx?v=111&f=cap_midover,fa_curratio_o1,fa_div_o1,fa_pe_u28,sh_avgvol_o500,sh_opt_option,sh_price_o15,sh_price_u200,ta_beta_u1.3,ta_sma200_pa,ta_rsi_nob65&ft=4',
  },
};

const _screenerCache = {};
const CACHE_TTL = 15 * 60 * 1000; // 15 min


// ── Playbook Auto Score — evalúa todos los tickers de un screener ──────────
app.get('/api/screener-eval/:id', async (req, res) => {
  try {
  const id = req.params.id;
  const sc = SCREENERS[id];
  if (!sc) return res.status(404).json({ error: 'Screener no encontrado' });

  // Obtener tickers del screener (usar caché si existe)
  let tickers = [];
  if (_screenerCache[id] && Date.now() - _screenerCache[id].ts < CACHE_TTL) {
    tickers = _screenerCache[id].data;
  } else {
    try {
      for (let page = 1; page <= 3; page++) {
        const pageUrl = sc.url + `&r=${(page-1)*20+1}`;
        const r = await fetch(pageUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html,application/xhtml+xml' }
        });
        const html = await r.text();
        const matches = [...html.matchAll(/data-boxover-ticker="([A-Z]+)"/g)];
        const pageTickers = [...new Set(matches.map(m => m[1]))];
        if (!pageTickers.length) break;
        tickers.push(...pageTickers);
        if (pageTickers.length < 20) break;
      }
      tickers = [...new Set(tickers)].slice(0, 60);
      _screenerCache[id] = { ts: Date.now(), data: tickers };
    } catch(e) {
      return res.status(500).json({ error: 'Error cargando screener: ' + e.message });
    }
  }

  // Helpers
  const calcEMA = (data, period) => {
    const k = 2/(period+1); let e = null;
    for (let i = 0; i < data.length; i++) {
      if (i < period-1) continue;
      if (i === period-1) e = data.slice(0, period).reduce((a,b) => a+b, 0) / period;
      else e = data[i]*k + e*(1-k);
    }
    return e ? +e.toFixed(4) : null;
  };

  const calcMACD = (data) => {
    const k12=2/13, k26=2/27, k9=2/10;
    let e12=null, e26=null, sig=null;
    for (let i = 0; i < data.length; i++) {
      const c = data[i];
      e12 = e12===null ? c : c*k12 + e12*(1-k12);
      e26 = e26===null ? c : c*k26 + e26*(1-k26);
      if (i < 25) continue;
      const m = e12-e26;
      sig = sig===null ? m : m*k9 + sig*(1-k9);
    }
    return { line: e12-e26, signal: sig, hist: (e12-e26)-sig };
  };

  const calcRSI = (data, period=14) => {
    if (data.length < period+1) return 50;
    let gains=0, losses=0;
    for (let i=1; i<=period; i++) {
      const d = data[i] - data[i-1];
      if (d>0) gains+=d; else losses+=Math.abs(d);
    }
    let ag=gains/period, al=losses/period;
    for (let i=period+1; i<data.length; i++) {
      const d = data[i]-data[i-1];
      ag = (ag*(period-1)+(d>0?d:0))/period;
      al = (al*(period-1)+(d<0?Math.abs(d):0))/period;
    }
    return al===0 ? 100 : +( 100 - 100/(1+ag/al) ).toFixed(1);
  };

  // Evaluar cada ticker
  const results = [];
  const signals = loadSignals ? loadSignals() : {};

  for (const sym of tickers) {
    try {
      const yhSym = encodeURIComponent(sym);
      // Yahoo Finance — 6 meses diario para EMA200
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${yhSym}?interval=1d&range=6mo`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const j = await r.json();
      const result = j.chart?.result?.[0];
      if (!result) { results.push({ sym, error: 'Sin datos' }); continue; }

      const closes = result.indicators.quote[0].close.filter(v => v != null);
      const vols   = result.indicators.quote[0].volume.filter(v => v != null);
      if (closes.length < 30) { results.push({ sym, error: 'Datos insuficientes' }); continue; }

      const precio  = closes.at(-1);
      const ema10   = calcEMA(closes, 10);
      const ema20   = calcEMA(closes, 20);
      const ema50   = calcEMA(closes, 50);
      const ema200  = closes.length >= 200 ? calcEMA(closes, 200) : null;
      const macd    = calcMACD(closes);
      const rsi     = calcRSI(closes);

      // Volumen relativo (últimos 5 días vs media 20 días)
      const volReciente = vols.slice(-5).reduce((a,b)=>a+b,0)/5;
      const volMedia20  = vols.slice(-20).reduce((a,b)=>a+b,0)/20;
      const relVol      = volMedia20 > 0 ? +(volReciente/volMedia20).toFixed(2) : 1;

      // Earnings
      let earningsDays = 999;
      try {
        const eq = await fetch(
          `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${yhSym}?modules=calendarEvents`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        const ej = await eq.json();
        const eTs = ej.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate?.[0]?.raw;
        if (eTs) earningsDays = Math.round((eTs*1000 - Date.now()) / 86400000);
      } catch(e) {}

      // IV Rank desde TastyTrade
      let ivRank = null;
      try {
        const mktData = await tt._req(`/market-data/volatility?symbols[]=${sym}`);
        const raw = mktData.data?.items?.[0]?.['iv-rank'];
        if (raw != null) ivRank = Math.round(parseFloat(raw) * 100);
      } catch(e) {}

      // CIAR v3 señal fresca
      const ciar = signals[sym];
      const ciarAge = ciar ? Math.floor((Date.now()-new Date(ciar.receivedAt).getTime())/60000) : null;
      const ciarFresh = ciarAge !== null && ciarAge < 1440;

      // ── Score Playbook Alejandro automático ──────────────────────────────
      // MÓDULO 1 — DIRECCIÓN (peso 33%)
      //   Tendencia (30): precio vs EMAs
      //   Ciclo (40): fase Weinstein inferida
      //   Estructura (30): posición relativa
      const sobreEma20  = precio > ema20;
      const sobreEma50  = precio > (ema50||ema20);
      const sobreEma200 = ema200 ? precio > ema200 : null;
      const ema10Alc    = ema10 > ema20;
      const ema20Alc    = ema50 ? ema20 > ema50 : null;
      const ema50Alc    = ema200 ? ema50 > ema200 : null;

      // Fase Weinstein
      const emasAlcistas = [ema10Alc, ema20Alc, ema50Alc].filter(v=>v===true).length;
      const emasBajistas = [!ema10Alc, ema20Alc===false, ema50Alc===false].filter(v=>v===true).length;

      // Para alcista:
      const dir_tend_alc = (sobreEma20?0.4:0) + (sobreEma50?0.3:0) + (sobreEma200===true?0.3:sobreEma200===null?0.15:0);
      const dir_ciclo_alc = emasAlcistas >= 2 ? 1.0 : emasAlcistas === 1 ? 0.5 : 0;
      const dir_struct_alc = (sobreEma20?0.5:0) + (rsi >= 50 && rsi <= 70 ? 0.5 : rsi > 30 && rsi < 50 ? 0.25 : 0);
      const dir_alc = (dir_tend_alc*30 + dir_ciclo_alc*40 + dir_struct_alc*30) / 100;

      // Para bajista:
      const dir_tend_baj = (!sobreEma20?0.4:0) + (!sobreEma50?0.3:0) + (sobreEma200===false?0.3:sobreEma200===null?0.15:0);
      const dir_ciclo_baj = emasBajistas >= 2 ? 1.0 : emasBajistas === 1 ? 0.5 : 0;
      const dir_struct_baj = (!sobreEma20?0.5:0) + (rsi >= 30 && rsi <= 50 ? 0.5 : rsi > 50 && rsi < 70 ? 0.25 : 0);
      const dir_baj = (dir_tend_baj*30 + dir_ciclo_baj*40 + dir_struct_baj*30) / 100;

      // MÓDULO 2 — TRIGGER (peso 33%)
      //   EMAs cruce (60): cruce EMA10/20
      //   Romp niveles (20): relVol
      //   Validación (20): CIAR / momentum
      const trig_ema_alc  = ema10Alc ? 1.0 : 0;
      const trig_ema_baj  = !ema10Alc ? 1.0 : 0;
      const trig_romp     = relVol >= 1.5 ? 1.0 : relVol >= 1.0 ? 0.5 : 0;
      const trig_val_alc  = (ciarFresh && ciar.signal==='BUY') ? 1.0 : relVol > 1.2 && sobreEma20 ? 0.5 : 0;
      const trig_val_baj  = (ciarFresh && ciar.signal==='SELL') ? 1.0 : relVol > 1.2 && !sobreEma20 ? 0.5 : 0;
      const trig_alc = (trig_ema_alc*60 + trig_romp*20 + trig_val_alc*20) / 100;
      const trig_baj = (trig_ema_baj*60 + trig_romp*20 + trig_val_baj*20) / 100;

      // MÓDULO 3 — FUERZA (peso 33%)
      //   MACD (45): línea + histograma
      //   Algoritmo CIAR (45): señal fresca
      //   Ingresarios (10): IV Rank
      const macdAlc = macd.line > 0 && macd.hist > 0;
      const macdBaj = macd.line < 0 && macd.hist < 0;
      const macdPendAlc = macd.hist > 0;
      const macdPendBaj = macd.hist < 0;

      const fuerz_macd_alc  = macdAlc ? 1.0 : macdPendAlc ? 0.5 : 0;
      const fuerz_macd_baj  = macdBaj ? 1.0 : macdPendBaj ? 0.5 : 0;
      const fuerz_algo_alc  = (ciarFresh && ciar.signal==='BUY') ? 1.0 : macdAlc ? 0.4 : 0;
      const fuerz_algo_baj  = (ciarFresh && ciar.signal==='SELL') ? 1.0 : macdBaj ? 0.4 : 0;
      const fuerz_iv        = ivRank != null ? (ivRank >= 30 ? 1.0 : ivRank >= 20 ? 0.5 : 0) : 0.5; // neutral si no hay datos
      const fuerz_alc = (fuerz_macd_alc*45 + fuerz_algo_alc*45 + fuerz_iv*10) / 100;
      const fuerz_baj = (fuerz_macd_baj*45 + fuerz_algo_baj*45 + fuerz_iv*10) / 100;

      // Score final por módulo y global
      const scoreAlc = Math.round((dir_alc + trig_alc + fuerz_alc) / 3 * 100);
      const scoreBaj = Math.round((dir_baj + trig_baj + fuerz_baj) / 3 * 100);
      const scoreMejor = Math.max(scoreAlc, scoreBaj);
      const tesisMejor = scoreAlc >= scoreBaj ? 'alcista' : 'bajista';
      const estrategia = tesisMejor === 'alcista' ? 'Bull Put Spread' : 'Bear Call Spread';

      // Determinar fase Weinstein
      let fase = 'F1';
      if (emasAlcistas >= 2 && sobreEma20) fase = emasAlcistas === 3 ? 'F2' : 'F2~';
      else if (emasBajistas >= 2 && !sobreEma20) fase = emasBajistas === 3 ? 'F4' : 'F4~';
      else if (sobreEma20 && !ema10Alc) fase = 'F3';

      results.push({
        sym,
        precio:   +precio.toFixed(2),
        scoreAlc,
        scoreBaj,
        scoreMejor,
        tesis:    tesisMejor,
        estrategia,
        fase,
        rsi,
        relVol,
        ivRank,
        earningsDays,
        macdAlc,
        macdBaj,
        ciar:     ciarFresh ? ciar.signal : null,
        modulos: {
          alc: { dir: Math.round(dir_alc*100), trig: Math.round(trig_alc*100), fuerz: Math.round(fuerz_alc*100) },
          baj: { dir: Math.round(dir_baj*100), trig: Math.round(trig_baj*100), fuerz: Math.round(fuerz_baj*100) },
        },
        riesgo: earningsDays <= 14 ? 'earnings' : ivRank != null && ivRank < 15 ? 'iv-bajo' : 'ok',
      });

      // Pausa entre requests para no saturar Yahoo
      await new Promise(r => setTimeout(r, 80));

    } catch(e) {
      results.push({ sym, error: e.message });
    }
  }

  // Ordenar por scoreMejor descendente
  results.sort((a,b) => (b.scoreMejor||0) - (a.scoreMejor||0));
  res.json({ screener: id, total: results.length, results });
  } catch(e) {
    console.error('[screener-eval]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/screeners', (req, res) => {
  const info = Object.entries(SCREENERS).map(([id, s]) => ({
    id, label: s.label, desc: s.desc, url: s.url,
    cached: !!(_screenerCache[id] && Date.now() - _screenerCache[id].ts < CACHE_TTL),
  }));
  res.json(info);
});

app.get('/api/screener/:id', async (req, res) => {
  const id = req.params.id;
  const sc = SCREENERS[id];
  if (!sc) return res.status(404).json({ error: 'Screener no encontrado' });

  // Caché válida
  if (_screenerCache[id] && Date.now() - _screenerCache[id].ts < CACHE_TTL) {
    return res.json(_screenerCache[id].data);
  }

  try {
    const tickers = [];
    for (let page = 1; page <= 5; page++) {
      const pageUrl = sc.url + `&r=${(page-1)*20+1}`;
      const r = await fetch(pageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml',
        }
      });
      const html = await r.text();
      // Múltiples patrones para capturar tickers en distintas versiones del HTML de Finviz
      const m1 = [...html.matchAll(/data-boxover-ticker="([A-Z]{1,6})"/g)].map(m => m[1]);
      const m2 = [...html.matchAll(/ticker=([A-Z]{1,6})&/g)].map(m => m[1]);
      const m3 = [...html.matchAll(/quote\.ashx\?t=([A-Z]{1,6})"/g)].map(m => m[1]);
      const pageTickers = [...new Set([...m1, ...m2, ...m3])];
      if (!pageTickers.length) break;
      tickers.push(...pageTickers);
      if (pageTickers.length < 20) break; // última página
    }
    const unique = [...new Set(tickers)];
    _screenerCache[id] = { ts: Date.now(), data: unique };
    res.json(unique);
  } catch(e) {
    console.error(`[Screener ${id}]`, e.message);
    res.json([]);
  }
});

// ── Fase preliminar por ticker ───────────────────────────────
app.get('/api/watchlist/:symbol/fase-preliminar', async (req, res) => {
  try {
    const sym   = req.params.symbol.toUpperCase();
    const yhSym = sym === 'SPX' ? '%5EGSPC' : encodeURIComponent(sym);

    // Precio + EMAs + MACD desde Yahoo Finance (90 días)
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${yhSym}?interval=1d&range=90d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const j = await r.json();
    const result = j.chart?.result?.[0];
    if (!result) return res.json({ fase: null, razon: 'Sin datos' });

    const closes = result.indicators.quote[0].close.filter(v => v != null);
    if (closes.length < 30) return res.json({ fase: null, razon: 'Insuficientes datos' });

    // Calcular EMA
    const ema = (data, period) => {
      const k = 2/(period+1); let e = null;
      for (let i=0;i<data.length;i++) {
        if (i<period-1) continue;
        if (i===period-1) e=data.slice(0,period).reduce((a,b)=>a+b,0)/period;
        else e=data[i]*k+e*(1-k);
      }
      return +e.toFixed(4);
    };

    // Calcular MACD
    const macdCalc = (data) => {
      const k12=2/13, k26=2/27, k9=2/10;
      let e12=null,e26=null,sig=null;
      for (let i=0;i<data.length;i++) {
        const c=data[i];
        e12=e12===null?c:c*k12+e12*(1-k12);
        e26=e26===null?c:c*k26+e26*(1-k26);
        if (i<25) continue;
        const m=e12-e26;
        sig=sig===null?m:m*k9+sig*(1-k9);
      }
      return { line: e12-e26, signal: sig, hist: (e12-e26)-sig };
    };

    const precio = closes.at(-1);
    const ema10  = ema(closes, 10);
    const ema20  = ema(closes, 20);
    const macd   = macdCalc(closes);

    // CIAR v3 — señal activa para este ticker
    const signals = loadSignals();
    const ciar    = signals[sym];
    const ciarAge = ciar ? Math.floor((Date.now() - new Date(ciar.receivedAt).getTime()) / 60000) : null;
    const ciarFresh = ciarAge !== null && ciarAge < 1440; // señal del día (24h)

    // Determinar fase
    const sobreEma20  = precio > ema20;
    const bajoEma20   = precio < ema20;
    const ema10Alc    = ema10 > ema20;
    const ema10Baj    = ema10 < ema20;
    const macdAlc     = macd.line > 0 && macd.hist > 0;
    const macdBaj     = macd.line < 0 && macd.hist < 0;
    const macdNeutro  = Math.abs(macd.line) < Math.abs(precio) * 0.003;
    const ciarBuy     = ciarFresh && ciar.signal === 'BUY';
    const ciarSell    = ciarFresh && ciar.signal === 'SELL';

    let fase, color, icono, razon, confirmado;

    // Score de confirmaciones: EMA cruce, Precio vs EMA20, MACD, CIAR
    const scores = {
      emaCruce:  ema10Alc ? 'alc' : ema10Baj ? 'baj' : 'neu',
      precioEma: sobreEma20 ? 'alc' : bajoEma20 ? 'baj' : 'neu',
      macd:      macdAlc ? 'alc' : macdBaj ? 'baj' : 'neu',
      ciar:      ciarFresh ? ciar.signal : null,
    };

    const alcCount = [
      scores.emaCruce==='alc', scores.precioEma==='alc',
      scores.macd==='alc',     scores.ciar==='BUY'
    ].filter(Boolean).length;

    const bajCount = [
      scores.emaCruce==='baj', scores.precioEma==='baj',
      scores.macd==='baj',     scores.ciar==='SELL'
    ].filter(Boolean).length;

    // Determinar fase
    if (alcCount >= 2) {
      fase = alcCount === 4 ? 'F2' : 'F2~';
      color = '#13d68f';
    } else if (bajCount >= 2) {
      fase = bajCount === 4 ? 'F4' : 'F4~';
      color = '#f04f5a';
    } else if (alcCount === 1 && bajCount === 0) {
      fase = 'F1'; color = '#6b7280'; // saliendo hacia F2
    } else if (bajCount === 1 && alcCount === 0) {
      fase = 'F3'; color = '#6b7280'; // saliendo hacia F4
    } else {
      fase = 'F1'; color = '#6b7280';
    }

    // Razon
    const tags = [
      scores.emaCruce==='alc'?'EMA✓':scores.emaCruce==='baj'?'EMA✗':'EMA~',
      scores.precioEma==='alc'?'P>EMA20':scores.precioEma==='baj'?'P<EMA20':'P≈EMA20',
      scores.macd==='alc'?'MACD+':scores.macd==='baj'?'MACD-':'MACD~',
      scores.ciar ? `CIAR ${scores.ciar}✅` : 'CIAR—',
    ];
    razon = tags.join(' · ');
    confirmado = ciarFresh;

    // Confirmaciones para los dots (4 dots = EMA cruce, Precio, MACD, CIAR)
    const dots = [
      { ok: scores.emaCruce!=='neu',  alc: scores.emaCruce==='alc',  label:'EMA' },
      { ok: scores.precioEma!=='neu', alc: scores.precioEma==='alc', label:'Precio' },
      { ok: scores.macd!=='neu',      alc: scores.macd==='alc',      label:'MACD' },
      { ok: !!scores.ciar,            alc: scores.ciar==='BUY',      label:'CIAR' },
    ];

    res.json({
      fase, color, razon, confirmado, dots,
      datos: { precio, ema10, ema20, macdLine: +macd.line.toFixed(4), macdHist: +macd.hist.toFixed(4) },
      ciar: ciarFresh ? { signal: ciar.signal, age: ciarAge } : null,
    });
  } catch(e) {
    res.json({ fase: null, razon: e.message });
  }
});

// ── Playbook score por ticker ─────────────────────────────────
// playbook-score movido después de loadChecklists

// ── Price History para chart de evaluaciones ────────────────
app.get('/api/price-history/:symbol', async (req, res) => {
  try {
    const sym      = req.params.symbol.toUpperCase();
    const interval = req.query.interval || '1d';
    const range    = req.query.range    || '6mo';
    const yhSym    = sym === 'SPX' ? '%5EGSPC' : encodeURIComponent(sym);
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${yhSym}?interval=${interval}&range=${range}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const j      = await r.json();
    const result = j.chart?.result?.[0];
    if (!result) return res.json([]);
    const ts    = result.timestamp;
    const quote = result.indicators.quote[0];
    const data  = ts.map((t, i) => ({
      time:  t,
      open:  quote.open[i]  ? +quote.open[i].toFixed(2)  : null,
      high:  quote.high[i]  ? +quote.high[i].toFixed(2)  : null,
      low:   quote.low[i]   ? +quote.low[i].toFixed(2)   : null,
      close: quote.close[i] ? +quote.close[i].toFixed(2) : null,
    })).filter(d => d.close !== null);
    res.json(data);
  } catch(e) {
    res.json([]);
  }
});

// ── Algo Signals (CIAR v3 webhook) ───────────────────────────
const ALGO_FILE = path.join(DATA_DIR, 'algo_signals.json');
function loadSignals() {
  try { return JSON.parse(fs.readFileSync(ALGO_FILE,'utf8')); } catch(e) { return {}; }
}
function saveSignals(data) { fs.writeFileSync(ALGO_FILE, JSON.stringify(data,null,2),'utf8'); }

app.post('/api/algo-signal', (req, res) => {
  const { ticker, signal, price, time } = req.body;
  if (!ticker || !signal) return res.status(400).json({ error: 'ticker y signal requeridos' });
  const signals = loadSignals();
  signals[ticker.toUpperCase()] = { signal, price, time, receivedAt: new Date().toISOString() };
  saveSignals(signals);
  console.log(`[CIAR v3] ${ticker} ${signal} @ $${price}`);
  res.json({ ok: true, ticker, signal });
});

app.get('/api/algo-signals', (req, res) => res.json(loadSignals()));

// ── Alejandro Checklists ──────────────────────────────────────
const CL_FILE = path.join(DATA_DIR, 'alejandro_checklists.json');
function loadChecklists() {
  try { return JSON.parse(fs.readFileSync(CL_FILE,'utf8')); } catch(e) { return []; }
}
function saveChecklists(data) { fs.writeFileSync(CL_FILE, JSON.stringify(data,null,2),'utf8'); }

app.get('/api/watchlist/:symbol/playbook-score', (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const checklists = loadChecklists();
  const entries = checklists.filter(c => c.ticker === sym);
  if (!entries.length) return res.json(null);
  const parseDate = d => {
    if (!d) return 0;
    const p = d.split('/');
    return p.length===3 ? new Date(+p[2],+p[1]-1,+p[0]).getTime() : new Date(d).getTime();
  };
  entries.sort((a,b) => parseDate(b.date) - parseDate(a.date));
  const last = entries[0];
  const fase = last.checks?.['ciclo_tm']
    ? last.checks['ciclo_tm'].toUpperCase()
    : (['ciclo_f1','ciclo_f2','ciclo_f3','ciclo_f4']
        .find(f => last.checks?.[f]==='si')?.replace('ciclo_f','F') || '—');
  // Devolver checks al frontend para que calcule el score con su lógica actual
  res.json({
    score:     last.score,  // score original guardado (referencia)
    checks:    last.checks || {},
    fase,
    direction: last.direction || last.tesis || '',
    date:      last.date,
  });
});

app.get('/api/alejandro-checklists', (req, res) => res.json(loadChecklists()));

app.post('/api/alejandro-checklists', (req, res) => {
  const checklists = loadChecklists();
  const nowCOL = new Date().toLocaleString('sv-SE', {timeZone:'America/Bogota'}).replace(' ','T') + '-05:00';
  const item = { ...req.body, id: `cl-${Date.now()}`, createdAt: nowCOL };
  checklists.unshift(item);
  saveChecklists(checklists.slice(0, 200));
  res.json(item);
});

app.put('/api/alejandro-checklists/:id', (req, res) => {
  const checklists = loadChecklists();
  const idx = checklists.findIndex(c => c.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'No encontrado' });
  const updCOL = new Date().toLocaleString('sv-SE', {timeZone:'America/Bogota'}).replace(' ','T') + '-05:00';
  checklists[idx] = { ...checklists[idx], ...req.body, updatedAt: updCOL };
  saveChecklists(checklists);
  res.json(checklists[idx]);
});

app.delete('/api/alejandro-checklists/:id', (req, res) => {
  const checklists = loadChecklists();
  saveChecklists(checklists.filter(c => c.id !== req.params.id));
  res.json({ ok: true });
});


// ── Cadena de Opciones ────────────────────────────────────────
app.get('/api/option-chain/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const expiry = req.query.expiry || null;

    // 1. Cadena de strikes/vencimientos desde TastyTrade
    const chainData = await tt._req(`/option-chains/${symbol}/nested`);
    const expirations = chainData.data?.items?.[0]?.expirations || [];
    if (!expirations.length) return res.status(404).json({ error: 'No se encontró cadena de opciones' });

    const expList = expiry
      ? expirations.filter(e => e['expiration-date'] === expiry)
      : expirations.slice(0, 6);

    // 2. Precio actual del subyacente desde Yahoo Finance (v8 no requiere crumb)
    let underlyingPrice = 0;
    let ivBase = 0.40;
    try {
      const qR = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const qJ = await qR.json();
      underlyingPrice = parseFloat(qJ.chart?.result?.[0]?.meta?.regularMarketPrice || 0);
    } catch(e) {}

    // 3. Precios/Greeks reales desde TastyTrade /market-data en lotes de 50
    const pricingMap = {};
    const allSymbols = [];
    for (const exp of expList) {
      for (const s of (exp.strikes || [])) {
        if (s.call) allSymbols.push(s.call);
        if (s.put)  allSymbols.push(s.put);
      }
    }

    const BATCH = 50;
    for (let i = 0; i < allSymbols.length; i += BATCH) {
      try {
        const batch = allSymbols.slice(i, i + BATCH);
        const params = batch.map(s => `symbols[]=${encodeURIComponent(s)}`).join('&');
        const d = await tt._req(`/market-data?${params}`);
        for (const item of (d.data?.items || [])) {
          const iv = parseFloat(item.volatility || 0) * 100;
          if (iv > 0) ivBase = Math.max(ivBase, iv / 100);
          pricingMap[item.symbol] = {
            iv:     +iv.toFixed(1),
            mark:   parseFloat(item.mark   || item.mid || 0),
            bid:    parseFloat(item.bid    || 0),
            ask:    parseFloat(item.ask    || 0),
            volume: parseInt(item.volume   || 0),
            oi:     parseInt(item['open-interest'] || 0),
            delta:  parseFloat(item.delta  || 0),
            theta:  parseFloat(item.theta  || 0),
            gamma:  parseFloat(item.gamma  || 0),
            vega:   parseFloat(item.vega   || 0),
          };
        }
      } catch(e) {}
    }

    try {

      // 4. Construir respuesta con Black-Scholes para strikes sin datos de Yahoo
      const R = 0.0525;
      function bsN(x) {
        const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
        const sign=x<0?-1:1; x=Math.abs(x)/Math.sqrt(2);
        const t=1/(1+p*x);
        return 0.5*(1+sign*(1-(((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t)*Math.exp(-x*x)));
      }
      function bsPDF(x){return Math.exp(-0.5*x*x)/Math.sqrt(2*Math.PI);}
      function calcGreeks(S,K,T,sigma,isCall){
        if(!S||!K||T<=0||!sigma) return {};
        const d1=(Math.log(S/K)+(R+sigma*sigma/2)*T)/(sigma*Math.sqrt(T));
        const d2=d1-sigma*Math.sqrt(T);
        const Nd1=bsN(d1),Nd2=bsN(d2),nd1=bsPDF(d1);
        const delta=isCall?Nd1:Nd1-1;
        const gamma=nd1/(S*sigma*Math.sqrt(T));
        const theta=isCall
          ?(-(S*nd1*sigma)/(2*Math.sqrt(T))-R*K*Math.exp(-R*T)*Nd2)/365
          :(-(S*nd1*sigma)/(2*Math.sqrt(T))+R*K*Math.exp(-R*T)*bsN(-d2))/365;
        return {
          delta: +delta.toFixed(3),
          gamma: +gamma.toFixed(4),
          theta: +theta.toFixed(4),
        };
      }

      const result = expList.map(exp => {
        const expDate = exp['expiration-date'];
        const T = Math.max((new Date(expDate) - Date.now()) / (365.25*86400000), 0.001);

        return {
          expiry: expDate,
          dte:    exp['days-to-expiration'],
          type:   exp['expiration-type'],
          strikes: (exp.strikes || []).map(s => {
            const strike = parseFloat(s['strike-price']);
            const atm = underlyingPrice > 0 && Math.abs(strike - underlyingPrice) / underlyingPrice < 0.03;

            // Buscar datos directamente por símbolo TastyTrade
            const cData = pricingMap[s.call] || {};
            const pData = pricingMap[s.put]  || {};

            const cIv = (cData.iv||0) > 0 ? cData.iv/100 : ivBase;
            const pIv = (pData.iv||0) > 0 ? pData.iv/100 : ivBase;

            // Greeks: usar reales de TastyTrade si disponibles, sino Black-Scholes
            const cGreeksBS = calcGreeks(underlyingPrice, strike, T, cIv, true);
            const pGreeksBS = calcGreeks(underlyingPrice, strike, T, pIv, false);

            return {
              strike,
              atm,
              call: {
                symbol: s.call,
                iv:     +((cData.iv||0) > 0 ? cData.iv : ivBase*100).toFixed(1),
                mark:   cData.mark   || 0,
                bid:    cData.bid    || 0,
                ask:    cData.ask    || 0,
                volume: cData.volume || 0,
                oi:     cData.oi     || 0,
                // ?? en vez de || — un delta/theta/gamma real de TastyTrade que sea
                // exactamente 0 (comun en strikes muy OTM, justo la zona que se busca
                // para creditos) no debe descartarse a favor de la estimacion Black-Scholes.
                delta:  cData.delta  ?? cGreeksBS.delta ?? 0,
                theta:  cData.theta  ?? cGreeksBS.theta ?? 0,
                gamma:  cData.gamma  ?? cGreeksBS.gamma ?? 0,
                vega:   cData.vega   || 0,
              },
              put: {
                symbol: s.put,
                iv:     +((pData.iv||0) > 0 ? pData.iv : ivBase*100).toFixed(1),
                mark:   pData.mark   || 0,
                bid:    pData.bid    || 0,
                ask:    pData.ask    || 0,
                volume: pData.volume || 0,
                oi:     pData.oi     || 0,
                delta:  pData.delta  ?? pGreeksBS.delta ?? 0,
                theta:  pData.theta  ?? pGreeksBS.theta ?? 0,
                gamma:  pData.gamma  ?? pGreeksBS.gamma ?? 0,
                vega:   pData.vega   || 0,
              },
            };
          }),
        };
      });

      return res.json({ symbol, underlyingPrice, expirations: result });
    } catch(e2) {
      return res.status(500).json({ error: e2.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ══════════════════════════════════════════════════════════════
// ── SPX Signal Center ────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
const { calcGEX, calcMaxPain, selectStrategy, evaluateIronCondorGate, evaluateReversionGate, findStrikesByDelta, buildSignalSummary, getETHour, classifyWindow } = require('./src/spx');
const { calcPlaybookScore, calcReversionScore, calcRelativeVolume, priceExtension, calcSMAArray, calcPOC } = require('./src/spx_indicators');
// Nota: calcRSI ya existe como funcion local en este archivo (linea ~1243, usada por el
// screener de acciones) — se reusa esa misma funcion para Alejamiento de SMA en vez de
// importar la copia de src/spx_indicators.js, para no chocar el nombre.
const { calcCaminoA } = require('./src/camino_a');
const { evaluateReversionPattern } = require('./src/sma_reversion');

// ── SPX Config (pesos ajustables) ─────────────────────────────
const SPX_CONFIG_FILE = path.join(DATA_DIR, 'spx_config.json');
const SPX_CONFIG_DEFAULTS = {
  minScore: 80, // regla de Alejandro: los 3 Mundos alineados -> score > 80/100
  weights: {
    // Modelo "Peso de la Evidencia" (playbook Alejandro, Framework 3 Mundos).
    // fase_weinstein a todo-o-nada: si 2m y 15m coinciden (2-2 o 4-4) son los 40
    // puntos completos, si no cero — no hace falta gradiente, la Dirección sola
    // no alcanza para pasar minScore, son los otros 60 (Trigger+Fuerza) los que
    // deciden si la señal cruza el umbral.
    fase_weinstein:           40,
    regimen_institucional:    10, // GEX compatible con la dirección (DEX pendiente, sin datos validados aún)
    patrones_estructurales:   20, // Higher-Low / Lower-High via fractales 15m
    ema_10_20_alineadas:      10, // EMAs alineadas 15m y precio no extendido
    volumen_rompimiento:      10, // Volumen SPY > 2x promedio
    macd_cruce_pendiente:     10, // MACD alineado + pendiente a favor
    confirmacion_algoritmica:  0, // Camino A (Trend Magic + SlingShot + MACD) — apoyo, no gatillo
  },
  // Parámetros de trading (compartidos con backtester)
  trading: {
    capital:     10000,   // Solo default para un slider de simulacion en el frontend
                          // (SPX Señales) — el sizing REAL de posiciones ya no lee este
                          // valor, usa el balance real de Tradier (tradier.getBalances()).
    experiencia: 'intermedio', // principiante / intermedio / avanzado
    riesgoPct:   2,       // % máximo de riesgo por operación
    targetDelta: 0.40,    // Delta objetivo para el strike short
    tpPct:       25,      // Take Profit % del crédito (25% → 94% prob. éxito, playbook Alejandro)
    slMult:      2.0,     // Stop Loss multiplicador del crédito (rango playbook: 1.5x-2x)
    spreadWidth: 10,      // Puntos del spread (calculado automático)
    tradierAutoExecute: true, // kill-switch: false pausa la ejecucion automatica en Tradier
    // Debitos direccionales (Bull Call/Bear Put) — parametros propios, separados de los
    // de credito de arriba. El TP/SL de credito (tpPct% del credito, slMult x credito) no
    // aplica conceptualmente a un debito: el riesgo maximo de un debito ya es el 100% de
    // lo pagado, no tiene sentido un multiplicador — se expresa como % de la prima pagada
    // que se esta dispuesto a ganar/perder.
    debit: {
      tpPct: 30, // 50->30 (2026-07-09, a pedido del usuario): mismo TP% que credito, sin importar isCredit
      slPct: 50, // cerrar al perder 50% de lo pagado
    },
    // Iron Condor — playbook profesor Alejandro. Parametros propios, separados de los
    // de las direccionales de arriba (no comparten targetDelta/spreadWidth/tpPct/slMult).
    ironCondor: {
      targetDelta: 0.12,        // delta 0.10-0.14, 0.12 = ~88% prob. de expirar sin valor
      spreadWidth: 10,          // ancho estandar del playbook (10-15, hasta 20-25 con mas experiencia)
      tpPct:       25,          // 25-40% del credito — cerrar al 25% eleva la prob. de exito a 94%
      slMult:      1.5,         // 1.5x o 2x el credito recibido
      gammaFlipBufferPts: 20,   // no operar si el precio esta a menos de esto del Gamma Flip
      tradierAutoExecute: true, // kill-switch propio del IC, separado del de las direccionales
    },
    // Alejamiento de SMA — reversion a la media (playbook Luis Silva, Sigma Trade).
    // Pipeline independiente, parametros propios (puede ajustarse tras el curso del
    // usuario con Luis Silva, por eso todo vive en config y no hardcodeado).
    smaReversion: {
      weights: {
        alejamiento_sma8:    50, // subido de 35 a 50 (2026-07-08) — "es lo mas importante", a pedido del usuario
        patron_confirmacion: 20, // Vela Garcia / Vela Tiburon / Vela 9 Secuencial
        rsi:                 10, // sobrecompra/sobreventa
        fase_weinstein:      10, // Fase 15m a favor de la reversion (2 compras, 4 ventas)
        regimen_gex:         10, // GEX Positivo + Muro de Gamma
      },
      minScore:    75,   // 70->80 (2026-07-08), luego 80->75 (2026-07-09) tras revisar caso real 8-jul: con tabla escalonada llegaba a 75, se bajo el piso para no perder ese tipo de entrada
      targetDelta: 0.30,
      spreadWidth: 5,    // credit spread mas angosto, acorde al hold corto (2-10 min)
      maxCandlesTimeStop: 5,  // tope duro: 5 velas de 2m (10 min) sin excepcion
      maxStopsPerDay:     2,  // circuito: 2 PERDIDAS CONSECUTIVAS (no total) y no se opera mas hoy
      maxDailyDrawdownPct: 3.5, // o -3.5% del capital en el dia, lo que llegue primero (regla Luis: 3-4%)
      wallProximityPts:   15,  // "cerca" de un muro de gamma para la confluencia del score
      tradierAutoExecute: true, // kill-switch propio, independiente de IC y direccionales
    },
  }
};
function loadSPXConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(SPX_CONFIG_FILE, 'utf8'));
    // Si los pesos son los viejos (precio_ema200=15), usar defaults actualizados
    if (saved?.weights?.precio_ema200 === 15) {
      console.log('[SPX] Config antigua detectada, usando defaults Propuesta C');
      saveSPXConfig(SPX_CONFIG_DEFAULTS);
      return SPX_CONFIG_DEFAULTS;
    }
    // Migración a pesos "Peso de la Evidencia" — acotada solo a weights, para no
    // pisar trading (targetDelta/tpPct/slMult ya ajustados a mano en producción).
    if (saved?.weights && saved.weights.fase_weinstein === undefined) {
      console.log('[SPX] Pesos viejos detectados, migrando a pesos Peso de la Evidencia (minScore -> 80)');
      saved.weights = SPX_CONFIG_DEFAULTS.weights;
      saved.minScore = SPX_CONFIG_DEFAULTS.minScore; // regla de Alejandro: 3 Mundos alineados -> >80/100
      saveSPXConfig(saved);
    }
    // Suma el bloque de Alejamiento de SMA si no existe todavia — acotado a esa
    // sola clave, no toca ironCondor/direccionales ya ajustados en produccion.
    if (saved?.trading && saved.trading.smaReversion === undefined) {
      console.log('[SPX] Sumando config de Alejamiento de SMA (no existia)');
      saved.trading.smaReversion = SPX_CONFIG_DEFAULTS.trading.smaReversion;
      saveSPXConfig(saved);
    }
    // Suma parametros de riesgo diario (consecutivas + drawdown %) y proximidad de
    // muro a un smaReversion ya guardado que no los tenga (ajuste post-curso Luis Silva).
    if (saved?.trading?.smaReversion && saved.trading.smaReversion.maxDailyDrawdownPct === undefined) {
      console.log('[SPX] Sumando maxDailyDrawdownPct/wallProximityPts a smaReversion (no existían)');
      saved.trading.smaReversion.maxDailyDrawdownPct = SPX_CONFIG_DEFAULTS.trading.smaReversion.maxDailyDrawdownPct;
      saved.trading.smaReversion.wallProximityPts = SPX_CONFIG_DEFAULTS.trading.smaReversion.wallProximityPts;
      saveSPXConfig(saved);
    }
    // Suma los parametros de debito (Bull Call/Bear Put) si no existen todavia.
    if (saved?.trading && saved.trading.debit === undefined) {
      console.log('[SPX] Sumando config de débito direccional (no existía)');
      saved.trading.debit = SPX_CONFIG_DEFAULTS.trading.debit;
      saveSPXConfig(saved);
    }
    return saved;
  } catch(e) {
    return SPX_CONFIG_DEFAULTS;
  }
}
function saveSPXConfig(cfg) { fs.writeFileSync(SPX_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); }

// GET /api/spx/config
app.get('/api/spx/config', (req, res) => res.json(loadSPXConfig()));

// POST /api/spx/config
app.post('/api/spx/config', (req, res) => {
  const cfg = loadSPXConfig();
  const { minScore, weights, trading } = req.body;
  if (minScore !== undefined) cfg.minScore = minScore;
  if (weights)  cfg.weights  = { ...cfg.weights,  ...weights  };
  if (trading)  cfg.trading  = { ...(cfg.trading||{}), ...trading };
  saveSPXConfig(cfg);
  res.json(cfg);
});
const SPX_SIGNALS_FILE = path.join(DATA_DIR, 'spx_signals.json');

function loadSPXSignals() {
  try { return JSON.parse(fs.readFileSync(SPX_SIGNALS_FILE, 'utf8')); } catch(e) { return []; }
}
function saveSPXSignals(signals) {
  fs.writeFileSync(SPX_SIGNALS_FILE, JSON.stringify(signals, null, 2), 'utf8');
}

// ── Historial de ejecuciones en Tradier (dashboard independiente) ──
const TRADIER_EXECUTIONS_FILE = path.join(DATA_DIR, 'tradier_executions.json');
function loadTradierExecutions() {
  try { return JSON.parse(fs.readFileSync(TRADIER_EXECUTIONS_FILE, 'utf8')); } catch(e) { return []; }
}
function saveTradierExecutions(execs) {
  fs.writeFileSync(TRADIER_EXECUTIONS_FILE, JSON.stringify(execs, null, 2), 'utf8');
}

// Mutex simple para serializar el ciclo leer→modificar→guardar de tradier_executions.json.
// checkIronCondorTPSL y checkDirectionalTPSL corren cada 90s CADA UNO, de forma
// independiente, y ambos hacen varios `await` (llamadas reales a Tradier) entre su
// propia lectura y su propia escritura del archivo — si se solapan, el que termina
// segundo sobreescribe el archivo con SU copia en memoria (cargada antes de que el
// otro guardara), revirtiendo silenciosamente el cambio que el otro acababa de hacer.
// Este mutex asegura que solo una funcion este a mitad de ese ciclo a la vez.
let executionsLock = Promise.resolve();
function withExecutionsLock(fn) {
  const run = executionsLock.then(fn, fn);
  executionsLock = run.catch(() => {});
  return run;
}

// GET /api/spx/context — contexto completo del mercado
// Construye el contexto de mercado completo para SPX (precio, VIX, IV Rank, GEX,
// indicadores 2m/15m/diario, rango de apertura, confluencia Weinstein). Usado tanto
// por GET /api/spx/context como por el chequeo periódico de Iron Condor.
async function buildSPXContext() {
    // 1. Cadena SPX para GEX y precio
    const chainData = await tt._req('/option-chains/SPX/nested');
    const expirations = chainData.data?.items?.[0]?.expirations || [];

    // 2. Precio SPX desde Yahoo
    let spxPrice = 5530;
    try {
      const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=1d',
        { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const j = await r.json();
      spxPrice = parseFloat(j.chart?.result?.[0]?.meta?.regularMarketPrice || spxPrice);
    } catch(e) {}

    // 3. VIX desde Yahoo
    let vix = 20;
    try {
      const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d',
        { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const j = await r.json();
      vix = parseFloat(j.chart?.result?.[0]?.meta?.regularMarketPrice || vix);
    } catch(e) {}

    // 4. IV Rank SPX desde TastyTrade
    let ivRank = 30;
    try {
      const mktData = await tt._req('/market-data/volatility?symbols[]=SPX');
      ivRank = parseFloat(mktData.data?.items?.[0]?.['iv-rank'] || 30) * 100;
    } catch(e) {}

    // 5. Calcular GEX
    // Necesitamos precios/greeks de la cadena — usar los que ya vienen en nested
    const allStrikes = [];
    for (const exp of expirations.slice(0, 4)) {
      for (const s of (exp.strikes || [])) {
        allStrikes.push(s.call, s.put);
      }
    }

    // Usar cadena interna /api/option-chain/SPX que ya tiene gamma/oi correctos
    let enrichedExps = [];
    try {
      const chainRes = await fetch(`http://localhost:${process.env.PORT||3000}/api/option-chain/SPX`);
      const chainJson = await chainRes.json();
      // Actualizar spxPrice si vino como 0
      if (!spxPrice || spxPrice < 1000) spxPrice = chainJson.underlyingPrice || spxPrice;
      enrichedExps = (chainJson.expirations || []).slice(0, 4).map(exp => ({
        expiry: exp.expiry,
        dte:    exp.dte,
        strikes: (exp.strikes || []).map(s => ({
          strike: s.strike,
          call: {
            delta: s.call?.delta || 0,
            gamma: s.call?.gamma || 0,
            oi:    s.call?.oi    || 0,
            mark:  s.call?.mark  || 0,
            iv:    s.call?.iv    || 0, // necesario para el sweep de Gamma Flip (calcGammaFlipSweep)
          },
          put: {
            delta: s.put?.delta || 0,
            gamma: s.put?.gamma || 0,
            oi:    s.put?.oi    || 0,
            mark:  s.put?.mark  || 0,
            iv:    s.put?.iv    || 0,
          },
        }))
      }));
    } catch(e) {
      console.error('[SPX] Error obteniendo cadena para GEX:', e.message);
    }

    // 6. GEX
    const gex = calcGEX(enrichedExps, spxPrice);
    // Max Pain — se calcula por vencimiento (no agregado como el GEX), usamos el más cercano (0DTE)
    gex.maxPain = calcMaxPain(enrichedExps[0]?.strikes || []);

    // 7. Indicadores técnicos — diario y 15m
    let indicators = { daily: {}, m15: {}, spy: {} };
    try {
      // Diario SPX
      const rD = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=1y',
        { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const jD = await rD.json();
      const closesD = jD.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v => v != null) || [];
      if (closesD.length >= 50) {
        const price = closesD[closesD.length - 1];
        const ema10D  = calcEMA(closesD, 10);
        const ema20D  = calcEMA(closesD, 20);
        const ema50D  = calcEMA(closesD, 50);
        const ema200D = calcEMA(closesD, 200);
        indicators.daily = {
          price, ema10: ema10D, ema20: ema20D, ema50: ema50D, ema200: ema200D,
          ext10:  priceExtension(price, ema10D),
          ext20:  priceExtension(price, ema20D),
          ext50:  priceExtension(price, ema50D),
          ext200: priceExtension(price, ema200D),
          macd:   calcMACD(closesD),
        };
      }

      // Función Weinstein: Fase 2 (alcista) o Fase 4 (bajista) o indeterminado
      function calcWeinstein(closes) {
        if (!closes || closes.length < 30) return { fase: null, label: '—' };
        const price = closes[closes.length - 1];
        const ema10 = calcEMA(closes, 10);
        const ema20 = calcEMA(closes, 20);
        const ema30 = calcEMA(closes, Math.min(30, closes.length));
        // Fase 2: precio > EMA20, EMA10 > EMA20, EMAs subiendo
        const ema10prev = calcEMA(closes.slice(0, -1), 10);
        const ema20prev = calcEMA(closes.slice(0, -1), 20);
        const ema10Rising = ema10 > ema10prev;
        const ema20Rising = ema20 > ema20prev;
        if (price > ema20 && ema10 > ema20 && ema20Rising) return { fase: 2, label: 'Fase 2 ▲', price, ema10, ema20 };
        // Fase 4: precio < EMA20, EMA10 < EMA20, EMAs bajando
        if (price < ema20 && ema10 < ema20 && !ema20Rising) return { fase: 4, label: 'Fase 4 ▼', price, ema10, ema20 };
        // Fase 1: precio cerca EMA20, EMAs planas (acumulación)
        if (price >= ema20 * 0.99 && price <= ema20 * 1.01) return { fase: 1, label: 'Fase 1 ◆', price, ema10, ema20 };
        // Fase 3: precio sobre EMA20 pero EMAs divergiendo (distribución)
        return { fase: 3, label: 'Fase 3 ●', price, ema10, ema20 };
      }

      // 15m SPX (últimos 5 días)
      const r15 = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=15m&range=5d',
        { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const j15 = await r15.json();
      const q15 = j15.chart?.result?.[0]?.indicators?.quote?.[0] || {};
      const closes15 = (q15.close || []).filter(v => v != null);
      if (closes15.length >= 30) {
        const price15 = closes15[closes15.length - 1];
        const ema10_15  = calcEMA(closes15, 10);
        const ema20_15  = calcEMA(closes15, 20);
        indicators.m15 = {
          price: price15, ema10: ema10_15, ema20: ema20_15,
          ext10: priceExtension(price15, ema10_15),
          ext20: priceExtension(price15, ema20_15),
          macd:  calcMACD(closes15),
          weinstein: calcWeinstein(closes15),
        };
      }

      // Fractal (Williams, 5 barras) sobre 15m — el nivel que realmente invalida
      // la tesis direccional segun el playbook (el de 2m es solo para timing de
      // entrada, tiene mucho ruido para usarse como stop). Mismo array de la
      // llamada 15m de arriba, solo que aca usamos high/low en vez de close.
      {
        const highs15 = q15.high || [], lows15 = q15.low || [];
        let lastFractalLow15 = null, lastFractalHigh15 = null;
        // Historial de fractales confirmados (no solo el ultimo) — necesario para
        // detectar patrones Higher-Low/Lower-High (patrones_estructurales del score)
        const fractalLowsHistory15 = [], fractalHighsHistory15 = [];
        for (let i = 2; i < highs15.length - 2; i++) {
          if (highs15[i] == null || lows15[i] == null) continue;
          const isHigh = highs15[i] > highs15[i-1] && highs15[i] > highs15[i-2] && highs15[i] > highs15[i+1] && highs15[i] > highs15[i+2];
          const isLow  = lows15[i]  < lows15[i-1]  && lows15[i]  < lows15[i-2]  && lows15[i]  < lows15[i+1]  && lows15[i]  < lows15[i+2];
          if (isHigh) { lastFractalHigh15 = highs15[i]; fractalHighsHistory15.push(+highs15[i].toFixed(2)); }
          if (isLow)  { lastFractalLow15  = lows15[i];  fractalLowsHistory15.push(+lows15[i].toFixed(2)); }
        }
        indicators.fractal15m = {
          low:  lastFractalLow15  != null ? +lastFractalLow15.toFixed(2)  : null,
          high: lastFractalHigh15 != null ? +lastFractalHigh15.toFixed(2) : null,
          lowsHistory:  fractalLowsHistory15.slice(-3),
          highsHistory: fractalHighsHistory15.slice(-3),
        };
      }

      // POC (Point of Control) de sesion en 15m — playbook Alejandro, ancla
      // estructural de salida junto al Fractal 15m. Sesion completa de HOY
      // (ET), reinicia cada dia — NO usa closes15 (filtrado, indices
      // desalineados con ts15/highs15/vols15), usa q15.close crudo alineado.
      {
        const ts15 = j15.chart?.result?.[0]?.timestamp || [];
        const rawHighs15 = q15.high || [], rawLows15 = q15.low || [];
        const vols15 = q15.volume || [];
        const rawCloses15 = q15.close || [];
        const todayET15 = new Date().toLocaleString('en-CA', { timeZone: 'America/New_York' }).slice(0, 10);
        const bars15hoy = [];
        for (let i = 0; i < ts15.length; i++) {
          if (rawHighs15[i] == null || rawLows15[i] == null || rawCloses15[i] == null) continue;
          const barET = new Date(ts15[i] * 1000).toLocaleString('en-CA', { timeZone: 'America/New_York' }).slice(0, 10);
          if (barET !== todayET15) continue;
          bars15hoy.push({ high: rawHighs15[i], low: rawLows15[i], close: rawCloses15[i], volume: vols15[i] });
        }
        indicators.poc15m = calcPOC(bars15hoy);
      }

      // 2m SPX (últimos 5 dias, no solo hoy) — marco de ejecución fina.
      // range=1d se quedaba corto: calcWeinstein necesita 30 barras y con
      // solo el dia de hoy no hay suficientes hasta ~60 min despues de abrir
      // (9:30-10:30am ET), justo dentro de la ventana operativa (9:45am+) —
      // el gate quedaba en null/false las primeras horas de cada sesion sin
      // que hubiera realmente falta de confluencia, solo falta de historia.
      try {
        const r2 = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=2m&range=5d',
          { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const j2 = await r2.json();
        const result2 = j2.chart?.result?.[0];
        const closes2 = result2?.indicators?.quote?.[0]?.close?.filter(v => v != null) || [];
        if (closes2.length >= 20) {
          const price2 = closes2[closes2.length - 1];
          const ema10_2 = calcEMA(closes2, 10);
          const ema20_2 = calcEMA(closes2, 20);
          indicators.m2 = {
            price: price2, ema10: ema10_2, ema20: ema20_2,
            ext10: priceExtension(price2, ema10_2),
            ext20: priceExtension(price2, ema20_2),
            macd:  calcMACD(closes2),
            weinstein: calcWeinstein(closes2),
          };
        }

        // Rango de apertura 9:30-10:00 ET — para la ventana Iron Condor de las 10am.
        // IMPORTANTE: ahora que el fetch trae 5 dias (no solo hoy), hay que filtrar
        // tambien por fecha ET de HOY — si no, se mezclaria el rango de apertura
        // de hoy con el de dias anteriores.
        const ts2    = result2?.timestamp || [];
        const highs2 = result2?.indicators?.quote?.[0]?.high || [];
        const lows2  = result2?.indicators?.quote?.[0]?.low  || [];
        const todayET = new Date().toLocaleString('en-CA', { timeZone: 'America/New_York' }).slice(0, 10);
        let orHigh = -Infinity, orLow = Infinity;
        for (let i = 0; i < ts2.length; i++) {
          if (highs2[i] == null || lows2[i] == null) continue;
          const d = new Date(ts2[i] * 1000);
          const dateET = d.toLocaleString('en-CA', { timeZone: 'America/New_York' }).slice(0, 10);
          if (dateET !== todayET) continue;
          const etStr = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
          const [hh, mm] = etStr.split(':').map(Number);
          const mins = hh * 60 + mm;
          if (mins >= 9 * 60 + 30 && mins < 10 * 60) {
            if (highs2[i] > orHigh) orHigh = highs2[i];
            if (lows2[i]  < orLow)  orLow  = lows2[i];
          }
        }
        if (orHigh > -Infinity && orLow < Infinity) {
          indicators.openingRange = { high: +orHigh.toFixed(2), low: +orLow.toFixed(2) };
        }

        // Fractal (Williams, 5 barras) sobre 2m — último swing low/high confirmado,
        // candidato a stop técnico junto al Muro Gamma
        let lastFractalLow = null, lastFractalHigh = null;
        for (let i = 2; i < highs2.length - 2; i++) {
          if (highs2[i] == null || lows2[i] == null) continue;
          const isHigh = highs2[i] > highs2[i-1] && highs2[i] > highs2[i-2] && highs2[i] > highs2[i+1] && highs2[i] > highs2[i+2];
          const isLow  = lows2[i]  < lows2[i-1]  && lows2[i]  < lows2[i-2]  && lows2[i]  < lows2[i+1]  && lows2[i]  < lows2[i+2];
          if (isHigh) lastFractalHigh = highs2[i];
          if (isLow)  lastFractalLow  = lows2[i];
        }
        indicators.fractal = {
          low:  lastFractalLow  != null ? +lastFractalLow.toFixed(2)  : null,
          high: lastFractalHigh != null ? +lastFractalHigh.toFixed(2) : null,
        };

        // Confirmación Algorítmica (Camino A) — necesita high/low/close alineados
        // por índice (closes2 de arriba viene filtrado de nulls, highs2/lows2 no,
        // así que se arma un array propio filtrando las 3 series juntas para no
        // desalinear las barras).
        const rawCloses2 = result2?.indicators?.quote?.[0]?.close || [];
        const bars2m = [];
        for (let i = 0; i < rawCloses2.length; i++) {
          if (rawCloses2[i] == null || highs2[i] == null || lows2[i] == null) continue;
          bars2m.push({ high: highs2[i], low: lows2[i], close: rawCloses2[i] });
        }
        if (indicators.m2) {
          indicators.m2.caminoA = calcCaminoA(bars2m);
          // Velas 2m crudas {high,low,close} — reusadas por Alejamiento de SMA
          // (SMA8/20, RSI, patrones García/Tiburón/9) para no repetir el fetch a Yahoo.
          indicators.m2.bars = bars2m;
        }
      } catch(e2) { console.error('[SPX] 2m error:', e2.message); }

      // Volumen SPY — intraday vs promedio 20d
      try {
        // 1. Promedio diario histórico (20 días)
        const rSPYd = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=3mo',
          { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const jSPYd = await rSPYd.json();
        const volsD = jSPYd.chart?.result?.[0]?.indicators?.quote?.[0]?.volume?.filter(v => v != null) || [];
        const avg20d = volsD.length >= 20
          ? volsD.slice(-20).reduce((a, b) => a + b, 0) / 20
          : 0;

        // 2. Volumen acumulado del día actual (velas 1m)
        const rSPY1m = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1m&range=1d',
          { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const jSPY1m = await rSPY1m.json();
        const vols1m  = jSPY1m.chart?.result?.[0]?.indicators?.quote?.[0]?.volume || [];
        const volHoy  = vols1m.filter(v => v != null).reduce((a, b) => a + b, 0);

        if (avg20d > 0 && volHoy > 0) {
          indicators.spy = {
            volume:         volHoy,
            avg20d:         Math.round(avg20d),
            relativeVolume: +( volHoy / avg20d ).toFixed(2),
          };
        }
      } catch(eSpy) { console.error('[SPX] volumen SPY error:', eSpy.message); }
    } catch(e) { console.error('[SPX] indicators error:', e.message); }

    // 7. Hora ET
    const et = getETHour();

    // 8. EMAs SPX (20 y 50 periodos diarios)
    let ema20 = null, ema50 = null;
    try {
      const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=3mo',
        { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const j = await r.json();
      const closes = j.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
      if (closes.length >= 50) {
        const calcEMA = (prices, period) => {
          const k = 2 / (period + 1);
          let ema = prices.slice(0, period).reduce((a,b) => a+b, 0) / period;
          for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
          return +ema.toFixed(2);
        };
        ema20 = calcEMA(closes, 20);
        ema50 = calcEMA(closes, 50);
      }
    } catch(e) {}

    // Score del playbook (dirección neutral por defecto en contexto)
    const spxConfig = loadSPXConfig();

    // Confluencia Weinstein: GATE OBLIGATORIO
    const fase2m  = indicators.m2?.weinstein?.fase  || null;
    const fase15m = indicators.m15?.weinstein?.fase || null;
    const weinsteinConfluence = fase2m !== null && fase15m !== null && fase2m === fase15m && (fase2m === 2 || fase2m === 4);
    const weinsteinDirection  = fase2m === 2 ? 'BULLISH' : fase2m === 4 ? 'BEARISH' : null;

    // Rango de apertura respetado — precondición del playbook para Iron Condor a las 10am
    const openingRange = indicators.openingRange || null;
    const openingRangeRespected = openingRange
      ? (spxPrice >= openingRange.low && spxPrice <= openingRange.high)
      : null;

    return {
      spxPrice: +spxPrice.toFixed(2),
      vix:      +vix.toFixed(2),
      ivRank:   +ivRank.toFixed(1),
      isCredit: ivRank > 30 || vix > 20,
      gex,
      ema20,
      ema50,
      indicators,
      openingRange,
      openingRangeRespected,
      weinstein: {
        fase2m,
        fase15m,
        label2m:    indicators.m2?.weinstein?.label  || '—',
        label15m:   indicators.m15?.weinstein?.label || '—',
        confluence: weinsteinConfluence,
        direction:  weinsteinDirection,
        gateOK:     weinsteinConfluence,
        reason:     weinsteinConfluence
          ? `✅ Confluencia ${fase2m === 2 ? 'Fase 2 ▲ (alcista)' : 'Fase 4 ▼ (bajista)'} en 2m y 15m`
          : fase2m === fase15m && fase2m !== null
            ? `⏳ Confluencia ${fase2m === 1 ? 'Fase 1' : 'Fase 3'} — no operable`
            : `❌ Sin confluencia: 2m=${indicators.m2?.weinstein?.label||'—'} vs 15m=${indicators.m15?.weinstein?.label||'—'}`,
      },
      config:   spxConfig,
      etTime:   et.time,
      etHour:   et.hour,
      etMin:    et.min,
      windowOK: (et.hour > 9 || (et.hour === 9 && et.min >= 0)) && et.hour < 16,
      ts:       new Date().toISOString(),
    };
}

app.get('/api/spx/context', async (req, res) => {
  try {
    const ctx = await buildSPXContext();
    res.json(ctx);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/spx/webhook — recibe señal de entrada de TradingView (compra/venta)
app.post('/api/spx/webhook', async (req, res) => {
  const tWebhookStart = Date.now(); // para medir cuanto tarda desde que llega la alerta hasta que se envia la orden
  try {
    let { direction, timeframe = '2m', source = 'TradingView', playbook_score = null, price, time } = req.body;

    // Normalizar direction (TradingView manda 'buy'/'sell' en strategies)
    if (direction === 'buy'  || direction === 'long')  direction = 'BULLISH';
    if (direction === 'sell' || direction === 'short') direction = 'BEARISH';
    direction = (direction || '').toUpperCase();
    if (!['BULLISH','BEARISH','NEUTRAL'].includes(direction))
      return res.status(400).json({ error: `direction inválido: ${direction}. Usar BULLISH|BEARISH|NEUTRAL` });

    // ── RESPONDER INMEDIATAMENTE para evitar timeout en TradingView ──
    // (antes esto estaba DESPUES del chequeo de confluencia Weinstein, que
    // hace un fetch a /api/spx/context — varias llamadas a Yahoo Finance en
    // cadena — y eso por si solo ya tardaba mas que el timeout de TradingView,
    // causando "webhook delivery failed" en las 4 alertas del 2026-07-06 pese
    // a que el servidor si las habia recibido). Todo lo demas, incluido el
    // gate, corre en background sin depender de la respuesta HTTP.
    res.json({ signal: 'processing', message: 'Señal recibida, procesando en background...' });

    // ── GATE OBLIGATORIO — confluencia Weinstein 2m + 15m ──
    // El servidor calcula ambas fases de forma independiente (no depende
    // de que TradingView le avise el contexto 15m por separado).
    let fase2m = null, fase15m = null;
    try {
      const ctxR = await fetch(`http://localhost:${process.env.PORT||3000}/api/spx/context`);
      const ctxJ = await ctxR.json();
      fase2m  = ctxJ.weinstein?.fase2m  || null;
      fase15m = ctxJ.weinstein?.fase15m || null;
    } catch(e) {}

    if (fase2m === null || fase15m === null) {
      console.log(`[SPX] Sin señal — no se pudo determinar fase Weinstein (2m:${fase2m} 15m:${fase15m}).`);
      return;
    }
    if (fase2m !== fase15m) {
      console.log(`[SPX] Sin señal — sin confluencia Weinstein: 2m=Fase${fase2m} vs 15m=Fase${fase15m}. Gate no cumplido.`);
      return;
    }
    if (fase2m !== 2 && fase2m !== 4) {
      console.log(`[SPX] Sin señal — confluencia en Fase${fase2m}, solo operable en Fase 2 (alcista) o Fase 4 (bajista).`);
      return;
    }

    // Forzar dirección según fase (la fase manda sobre el webhook)
    const weinsteinDirection = fase2m === 2 ? 'BULLISH' : 'BEARISH';
    if (direction !== weinsteinDirection) {
      console.log(`[SPX] Dirección webhook (${direction}) ajustada a Weinstein (${weinsteinDirection})`);
      direction = weinsteinDirection;
    }

    console.log(`[SPX] ✅ Gate Weinstein OK — Fase${fase2m} en 2m y 15m → ${direction} (+${Date.now()-tWebhookStart}ms desde que llegó la alerta)`);

    // ── GENERAR SUGERENCIA (en background) ───────────────────────────
    // Obtener contexto de mercado
    const ctxRes = await fetch(`http://localhost:${process.env.PORT||3000}/api/spx/context`);
    const ctx    = await ctxRes.json();

    // Capital de la cuenta — DEBE ser el de Tradier (donde de verdad se ejecuta la
    // orden), no el de TastyTrade (una cuenta real completamente distinta y sin
    // relacion). Usaba tt._req a TastyTrade por error, sizeando el riesgo del 2%
    // contra ~$8,300 de la cuenta personal en vez de los ~$100,000 reales de Tradier.
    let capital = 10000;
    try {
      const balances = await tradier.getBalances();
      capital = parseFloat(balances?.total_equity || capital);
    } catch(e) {}

    // Calcular score del playbook
    const spxConfig = loadSPXConfig();
    // Asegurar defaults para evitar undefined en calcPlaybookScore
    const safeDaily = ctx.indicators?.daily || {};
    const safeM15   = ctx.indicators?.m15   || {};
    const safeM2     = ctx.indicators?.m2    || {};
    const safeSpy   = ctx.indicators?.spy   || {};
    if (!safeDaily.macd) safeDaily.macd = { line: null, signal: null, hist: null };
    if (!safeM15.macd)   safeM15.macd   = { line: null, signal: null, hist: null };

    const playbookResult = calcPlaybookScore({
      direction,
      spxPrice:    ctx.spxPrice,
      gammaRegime: ctx.gex?.regime,
      gammaFlip:   ctx.gex?.gammaFlip,
      daily:       safeDaily,
      m15:         safeM15,
      m2:          safeM2,
      spy:         safeSpy,
      fractal15m:  ctx.indicators?.fractal15m || {},
    }, spxConfig);

    if (!playbookResult.passed) {
      console.log(`[SPX] ❌ Score insuficiente: ${playbookResult.score}% (mínimo ${playbookResult.minScore}%)`);
      return;
    }

    // Fuerza total (Mundo 3): todos los criterios de fuerza cumplidos.
    // Informativo — el playbook dice que ATM (débito, R:R 1:1) solo aplica
    // cuando la fuerza es total; hoy el switch OTM/ATM sigue decidido por
    // IV Rank/VIX, esto solo lo deja visible en la señal para revisión manual.
    const fuerzaTotal = (playbookResult.mundo3 || []).length > 0 && playbookResult.mundo3.every(c => c.ok);

    // Seleccionar estrategia
    const sel = selectStrategy({
      direction,
      ivRank:      ctx.ivRank,
      vix:         ctx.vix,
      gammaRegime: ctx.gex?.regime,
      etHour:      ctx.etHour,
      etMin:       ctx.etMin,
      capital,
      openingRangeRespected: ctx.openingRangeRespected,
    });

    if (!sel.valid) {
      console.log(`[SPX] ❌ Estrategia inválida: ${sel.reason}`);
      return;
    }

    // Parámetros de trading desde config
    const tradingCfg = spxConfig.trading || SPX_CONFIG_DEFAULTS.trading;
    const targetDelta = tradingCfg.targetDelta || 0.40;
    const tpPct       = (tradingCfg.tpPct || 50) / 100;
    const slMult      = tradingCfg.slMult || 1.0;
    const spreadWidth = tradingCfg.spreadWidth || 10;

    // Buscar strikes con delta configurable
    const chainRes = await fetch(`http://localhost:${process.env.PORT||3000}/api/option-chain/SPX`);
    const chainData = await chainRes.json();
    const strikes = findStrikesByDelta(chainData.expirations || [], sel.strategy, ctx.spxPrice, sel.expType, targetDelta, spreadWidth);

    if (!strikes) {
      console.log(`[SPX] ❌ No se encontraron strikes con delta ${targetDelta}`);
      return;
    }

    // Stop técnico sugerido — el más conservador entre el último Fractal de
    // 15m (el nivel que realmente invalida la tesis direccional segun el
    // playbook; el de 2m es solo para timing de entrada, tiene mucho ruido
    // para usarse como stop) y el Muro Gamma en contra de la dirección.
    // Solo informativo en la señal, sin monitoreo/alertas en vivo.
    const fractal15m = ctx.indicators?.fractal15m || {};
    let technicalStop = null, technicalStopSource = null;
    if (direction === 'BULLISH') {
      const candidates = [fractal15m.low, ctx.gex?.putWall].filter(v => v != null && v > 0);
      if (candidates.length) {
        technicalStop = Math.max(...candidates);
        technicalStopSource = technicalStop === fractal15m.low ? 'Fractal 15m' : 'Muro Gamma (Put Wall)';
      }
    } else if (direction === 'BEARISH') {
      const candidates = [fractal15m.high, ctx.gex?.callWall].filter(v => v != null && v > 0);
      if (candidates.length) {
        technicalStop = Math.min(...candidates);
        technicalStopSource = technicalStop === fractal15m.high ? 'Fractal 15m' : 'Muro Gamma (Call Wall)';
      }
    }

    // Construir señal
    const signal = buildSignalSummary(sel.strategy, strikes, sel, {
      ...ctx,
      direction,
      gammaRegime: ctx.gex?.regime,
      callWall:    ctx.gex?.callWall,
      putWall:     ctx.gex?.putWall,
      gammaFlip:   ctx.gex?.gammaFlip,
      maxPain:     ctx.gex?.maxPain,
      technicalStop,
      technicalStopSource,
      etTime:      ctx.etTime,
    });

    // Niveles de invalidacion tecnica para la salida (playbook Alejandro): Fractal
    // 15m del lado que invalida la tesis (low si es alcista, high si es bajista) y
    // POC de sesion en 15m. Separados de technicalStop (que ya combina fractal+muro
    // en un solo numero "el mas conservador") porque el monitor de salida necesita
    // los dos gatillos por separado, no un combinado.
    signal.fractalLevel = direction === 'BULLISH' ? fractal15m.low : fractal15m.high;
    signal.pocLevel     = ctx.indicators?.poc15m ?? null;

    signal.playbook       = playbookResult;
    signal.fuerzaTotal    = fuerzaTotal;
    signal.source         = source;
    signal.timeframe      = timeframe;
    signal.tf15m          = weinsteinDirection;
    signal.strategyFamily = 'TENDENCIA';

    // Agregar parámetros de trading y TP/SL calculados
    const credito = signal.credit || signal.maxProfit || 0;
    // Credito/Riesgo minimo 20% (playbook Alejandro) — riesgo = valor del ancho
    // del spread menos el credito, ambos por contrato ($100 x puntos). Sin este
    // filtro se podia entrar con primas muy chicas arriesgando mucho por poco.
    const riesgoPorContrato   = spreadWidth > 0 ? (spreadWidth - credito) * 100 : 0;
    const creditoPorContrato  = credito * 100;
    const creditoRiesgoPct    = riesgoPorContrato > 0 ? +(creditoPorContrato / riesgoPorContrato * 100).toFixed(1) : 0;
    const MIN_CREDITO_RIESGO_PCT = 20;
    signal.trading = {
      delta:      targetDelta,
      tpPct:      Math.round(tpPct * 100),
      slMult:     slMult,
      spreadWidth: spreadWidth,
      tpTarget:   credito > 0 ? Math.round(credito * tpPct * 100) : null,
      slTarget:   credito > 0 ? Math.round(credito * slMult * 100) : null,
      breakeven:  signal.strikes ? (
        sel.strategy === 'BEAR_CALL'
          ? signal.strikes.shortStrike + credito
          : signal.strikes.shortStrike - credito
      ) : null,
      creditoRiesgoPct,
      minCreditoRiesgoPct: MIN_CREDITO_RIESGO_PCT,
    };

    // ── Ejecución automática en Tradier (sandbox) — las 4 verticales direccionales ──
    // Ampliado 2026-07-08: antes solo credito (Bull Put/Bear Call). Los debitos
    // (Bull Call/Bear Put) — que el sistema empieza a elegir con gamma negativo,
    // ver gammaForcesDebit en selectStrategy — quedaban siempre como sugerencia
    // manual, nunca llegaban a Tradier. Confirmado con un caso real: senal valida
    // (score 80%) en PENDING toda la sesion por este hueco.
    const tradierEligible = ['BULL_PUT_SPREAD', 'BEAR_CALL_SPREAD', 'BULL_CALL_SPREAD', 'BEAR_PUT_SPREAD'].includes(signal.strategy);
    const tradierEnabled  = IS_PRODUCTION && (spxConfig.trading || SPX_CONFIG_DEFAULTS.trading).tradierAutoExecute !== false;
    // El gate de Credito/Riesgo minimo es conceptualmente solo para credito (compara
    // prima cobrada contra el riesgo del ancho); para debito ademas tenia un bug
    // latente (credito = signal.credit||signal.maxProfit||0 caia a maxProfit, sin
    // relacion real, dando un ratio sin sentido) — se exime a debito de este gate.
    const creditoRiesgoOK = !signal.isCredit || creditoRiesgoPct >= MIN_CREDITO_RIESGO_PCT;
    if (tradierEligible && tradierEnabled && !creditoRiesgoOK) {
      signal.tradierOrder = { skipped: true, reason: `Crédito/Riesgo ${creditoRiesgoPct}% por debajo del mínimo ${MIN_CREDITO_RIESGO_PCT}% — prima muy chica para el riesgo del spread.` };
      console.log(`[Tradier] ⏳ Señal omitida — crédito/riesgo ${creditoRiesgoPct}% < ${MIN_CREDITO_RIESGO_PCT}%.`);
    } else if (tradierEligible && tradierEnabled) {
      try {
        // No apilar: si ya hay una posicion abierta o una orden en curso, esta
        // señal se guarda como sugerencia pero NO se ejecuta automaticamente.
        const yaHayTradeAbierto = await tradier.hasOpenPosition('SPXW');
        if (yaHayTradeAbierto) {
          signal.tradierOrder = { skipped: true, reason: 'Ya hay un trade abierto en Tradier — se espera a que cierre.' };
          console.log('[Tradier] ⏳ Señal omitida — ya hay un trade SPXW abierto/en curso.');
        } else {
          const order = await tradier.placeSpreadOrder({
            strategy:       signal.strategy,
            underlyingRoot: 'SPXW',
            expiry:         signal.strikes.expiry,
            shortStrike:    signal.strikes.shortStrike,
            longStrike:     signal.strikes.longStrike,
            quantity:       signal.contracts,
          });
          signal.tradierOrder = { orderId: order.orderId, status: order.status, legs: order.legs };
          signal.status    = 'EXECUTED';
          signal.notes     = 'Auto-ejecutado en Tradier sandbox';
          signal.actionAt  = new Date().toISOString();
          signal.timingMs  = Date.now() - tWebhookStart; // desde que llego la alerta hasta que se envio la orden
          console.log(`[Tradier] ✅ Orden enviada: ${order.orderId} (${order.status}) — ${order.legs?.shortSym} / ${order.legs?.longSym} (+${signal.timingMs}ms desde que llegó la alerta — analisis + envio de orden)`);

          // Registro dedicado para el dashboard de seguimiento (no comparte
          // el cap de 50 de spx_signals.json). Sin await entre load/save aqui, pero
          // igual pasa por el mutex — si no, un monitor de TP/SL a mitad de su propio
          // ciclo (con una copia vieja en memoria) podria guardar despues y borrar
          // este registro nuevo sin querer.
          await withExecutionsLock(() => {
            const executions = loadTradierExecutions();
            executions.unshift({
              id:            `tex-${Date.now()}`,
              signalId:      signal.id,
              timestamp:     signal.timestamp,
              strategy:      signal.strategy,
              strategyFamily: signal.strategyFamily || 'TENDENCIA',
              isCredit:      !!signal.isCredit, // false = debito, para que checkDirectionalTPSL sepa que formula de P&L usar
              direction:     signal.direction,
              strikes:       signal.strikes,
              expiry:        signal.strikes?.expiry,
              contracts:     signal.contracts,
              orderId:       order.orderId,
              legs:          order.legs,
              status:        'submitted',
              entryFillPrice: null,
              creditReceived: null,
              tpPct:         signal.trading?.tpPct ?? tpPct * 100,
              slMult:        signal.trading?.slMult ?? slMult,
              // Solo se usan si isCredit=false — % de la prima pagada, no un multiplicador
              debitTpPct:    (spxConfig.trading?.debit || SPX_CONFIG_DEFAULTS.trading.debit).tpPct,
              debitSlPct:    (spxConfig.trading?.debit || SPX_CONFIG_DEFAULTS.trading.debit).slPct,
              // Niveles tecnicos de invalidacion (playbook Alejandro) — congelados al
              // momento de entrar, igual que entryCandleLow/High en la reversion.
              fractalLevel:  signal.fractalLevel ?? null,
              pocLevel:      signal.pocLevel ?? null,
              filledAt:      null,
              closedAt:      null,
              closeReason:   null,
              pnl:           null,
              pnlSource:     null,
            });
            saveTradierExecutions(executions);
          });
        }
      } catch(e) {
        signal.tradierOrder = { error: e.message };
        console.error('[Tradier] ❌ Error enviando orden:', e.message);
      }
    }

    // Guardar
    const signals = loadSPXSignals();
    signals.unshift(signal);
    saveSPXSignals(signals.slice(0, 50));

    console.log(`[SPX] ✅ Señal generada: ${signal.strategyName} | ${signal.strikes?.shortStrike}/${signal.strikes?.longStrike}`);
    // Nota: res ya fue enviado inmediatamente arriba para evitar timeout

  } catch(e) {
    console.error('[SPX] webhook error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// GET /api/spx/signals — lista de señales pendientes/historial
app.get('/api/spx/signals', (req, res) => {
  res.json(loadSPXSignals());
});

// ── Chequeo periódico de Iron Condor (0DTE y 1DTE) ──────────────────────
// A diferencia de las direccionales (disparadas por alerta de Pine), el Iron Condor
// no tiene un "trigger" — se evalúa el régimen de mercado cada 5 min durante las
// ventanas favorables (10am-1pm ET para 0DTE, 3:45-3:50pm ET para 1DTE) y se genera
// la señal si pasa el gate (`evaluateIronCondorGate`, playbook profesor Alejandro).
// Solo sugerencia manual en el Signal Center — NO se ejecuta en Tradier todavía.
async function checkIronCondor() {
  try {
    const et = getETHour();
    const etMins = et.hour * 60 + et.min;
    const window0DTE = classifyWindow(etMins) === 'IC_FAVORABLE';
    const window1DTE = classifyWindow(etMins) === 'CIERRE_1DTE';
    if (!window0DTE && !window1DTE) return;

    const dte = window1DTE ? '1DTE' : '0DTE';
    const today = new Date().toISOString().slice(0, 10);

    // No duplicar: si ya hay una señal de Iron Condor de esta variante generada
    // hoy, o ya hay un trade SPXW abierto/en curso en Tradier, no generar otra.
    const signals = loadSPXSignals();
    const yaExiste = signals.some(s =>
      s.strategy === 'IRON_CONDOR' && s.expType === dte && (s.timestamp || '').slice(0, 10) === today
    );
    if (yaExiste) return;

    const yaHayTradeAbierto = await tradier.hasOpenPosition('SPXW');
    if (yaHayTradeAbierto) return;

    const ctx = await buildSPXContext();
    const spxConfig = loadSPXConfig();
    const tradingCfg = spxConfig.trading || SPX_CONFIG_DEFAULTS.trading;
    const icCfg = tradingCfg.ironCondor || SPX_CONFIG_DEFAULTS.trading.ironCondor;

    const gate = evaluateIronCondorGate({
      spxPrice: ctx.spxPrice, vix: ctx.vix, gex: ctx.gex, indicators: ctx.indicators,
      openingRangeRespected: ctx.openingRangeRespected, etHour: et.hour, etMin: et.min,
    }, dte, icCfg);

    if (!gate.valid) {
      console.log(`[SPX-IC ${dte}] ❌ ${gate.reason}`);
      return;
    }

    const chainRes = await fetch(`http://localhost:${process.env.PORT||3000}/api/option-chain/SPX`);
    const chainData = await chainRes.json();
    const strikes = findStrikesByDelta(chainData.expirations || [], 'IRON_CONDOR', ctx.spxPrice, dte, icCfg.targetDelta, gate.spreadWidth);
    if (!strikes || !strikes.callShortStrike) {
      console.log(`[SPX-IC ${dte}] ❌ No se encontraron strikes completos (put+call) con delta ${icCfg.targetDelta}`);
      return;
    }

    // Capital real de Tradier (donde se ejecuta) — antes usaba tradingCfg.capital,
    // un valor de config que nunca se configuro y caia en un default fijo de
    // $10,000, sin relacion con el balance real (~$100,000).
    let capital = 10000;
    try {
      const balances = await tradier.getBalances();
      capital = parseFloat(balances?.total_equity || capital);
    } catch(e) {}
    const maxRisk = capital * 0.02;
    const contracts = Math.max(1, Math.floor(maxRisk / (gate.spreadWidth * 100)));
    const sel = {
      valid: true, strategy: 'IRON_CONDOR', isCredit: true, expType: dte,
      window: dte === '0DTE' ? 'IC_FAVORABLE' : 'CIERRE_1DTE',
      spreadWidth: gate.spreadWidth, contracts,
      maxRisk: contracts * gate.spreadWidth * 100,
      creditReason: `GEX positivo, ${dte === '0DTE' ? 'Fase 1/3 15m + MACD aplanado' : 'ventana overnight 3:50pm'}`,
    };

    const signal = buildSignalSummary('IRON_CONDOR', strikes, sel, {
      direction: 'NEUTRAL',
      spxPrice: ctx.spxPrice, vix: ctx.vix, ivRank: ctx.ivRank,
      gammaRegime: ctx.gex?.regime, callWall: ctx.gex?.callWall, putWall: ctx.gex?.putWall,
      gammaFlip: ctx.gex?.gammaFlip, maxPain: ctx.gex?.maxPain,
      technicalStop: null, technicalStopSource: null, etTime: ctx.etTime,
    });
    signal.trading = { tpPct: icCfg.tpPct, slMult: icCfg.slMult, spreadWidth: gate.spreadWidth };
    signal.strategyFamily = 'NEUTRAL';
    if (gate.note) signal.notes = gate.note;

    // ── Ejecución automática en Tradier (sandbox) — kill-switch propio del IC ──
    if (IS_PRODUCTION && icCfg.tradierAutoExecute !== false) {
      try {
        const order = await tradier.placeIronCondorOrder({
          underlyingRoot:   'SPXW',
          expiry:           strikes.expiry,
          putShortStrike:   strikes.shortStrike,
          putLongStrike:    strikes.longStrike,
          callShortStrike:  strikes.callShortStrike,
          callLongStrike:   strikes.callLongStrike,
          quantity:         contracts,
        });
        signal.tradierOrder = { orderId: order.orderId, status: order.status, legs: order.legs };
        signal.status   = 'EXECUTED';
        signal.notes    = (signal.notes ? signal.notes + ' | ' : '') + 'Auto-ejecutado en Tradier sandbox';
        signal.actionAt = new Date().toISOString();
        console.log(`[Tradier-IC] ✅ Orden enviada: ${order.orderId} (${order.status})`);

        await withExecutionsLock(() => {
          const executions = loadTradierExecutions();
          executions.unshift({
            id:            `tex-${Date.now()}`,
            signalId:      signal.id,
            timestamp:     signal.timestamp,
            strategy:      'IRON_CONDOR',
            strategyFamily: 'NEUTRAL',
            expType:       dte,
            strikes:       signal.strikes,
            expiry:        strikes.expiry,
            contracts,
            orderId:       order.orderId,
            legs:          order.legs,
            status:        'submitted',
            entryFillPrice: null,
            creditReceived: null,
            tpPct:         icCfg.tpPct,
            slMult:        icCfg.slMult,
            filledAt:      null,
            closedAt:      null,
            closeReason:   null,
            pnl:           null,
            pnlSource:     null,
          });
          saveTradierExecutions(executions);
        });
      } catch(e) {
        signal.tradierOrder = { error: e.message };
        console.error('[Tradier-IC] ❌ Error enviando orden:', e.message);
      }
    }

    signals.unshift(signal);
    saveSPXSignals(signals.slice(0, 50));
    console.log(`[SPX-IC ${dte}] ✅ Señal generada: put ${signal.strikes?.shortStrike}/${signal.strikes?.longStrike} — call ${signal.strikes?.callShortStrike}/${signal.strikes?.callLongStrike}`);
  } catch(e) {
    console.error('[SPX-IC] Error:', e.message);
  }
}
setInterval(checkIronCondor, 5 * 60 * 1000);

// Verifica que TODAS las patas de una orden multileg se llenaron completas — no
// solo que el agregado tenga exec_quantity>0. Antes, un fill parcial/desbalanceado
// (ej. la pata corta se llena pero la larga de proteccion no) se trataba igual que
// un fill sano, dejando una posicion "desnuda" mucho mas riesgosa sin que el
// sistema lo notara.
function verificarFillPorPata(order, expectedQty) {
  const legs = Array.isArray(order.leg) ? order.leg : (order.leg ? [order.leg] : []);
  if (!legs.length) {
    const execQty = order.exec_quantity || 0;
    return { completo: execQty >= expectedQty, parcial: execQty > 0 && execQty < expectedQty, detalle: [] };
  }
  const detalle = legs.map(l => ({ symbol: l.option_symbol, side: l.side, execQty: l.exec_quantity || 0 }));
  const todasCompletas = detalle.every(d => d.execQty >= expectedQty);
  const algunaLlenada  = detalle.some(d => d.execQty > 0);
  return { completo: todasCompletas, parcial: algunaLlenada && !todasCompletas, detalle };
}

// Cierre de emergencia: aplana individualmente cada pata que SI se llenó (lado
// opuesto al original), para no sostener un riesgo desbalanceado esperando a que
// alguien lo note manualmente.
async function aplanarPatasParciales(detalle, underlyingRoot) {
  const cerradas = [];
  for (const leg of detalle) {
    if (leg.execQty <= 0) continue;
    const sideCierre = leg.side === 'sell_to_open' ? 'buy_to_close' : 'sell_to_close';
    try {
      await tradier.closeSingleLeg({ underlyingRoot, optionSymbol: leg.symbol, side: sideCierre, quantity: leg.execQty });
      cerradas.push(leg.symbol);
      console.error(`[EMERGENCIA-FILL-PARCIAL] Pata ${leg.symbol} (${leg.side}, qty ${leg.execQty}) cerrada de emergencia (${sideCierre}).`);
    } catch(e) {
      console.error(`[EMERGENCIA-FILL-PARCIAL] Error cerrando pata ${leg.symbol}:`, e.message);
    }
  }
  return cerradas;
}

// ── Monitor activo de TP/SL para Iron Condor (primer cierre activo del sistema —
// todo lo demas hoy solo registra P&L despues del hecho, ver checkTradierExecutions) ──
async function checkIronCondorTPSL() {
  if (!isMarketHours()) return;
  return withExecutionsLock(checkIronCondorTPSLImpl);
}
async function checkIronCondorTPSLImpl() {
  try {
    const executions = loadTradierExecutions();
    const abiertas = executions.filter(e => e.strategy === 'IRON_CONDOR' && (e.status === 'submitted' || e.status === 'filled'));
    if (!abiertas.length) return;

    let cambios = false;
    for (const ex of abiertas) {
      // 1. Confirmar fill si aun no se confirmo — esperar al siguiente ciclo para
      // evaluar TP/SL una vez que sepamos el credito real recibido.
      if (ex.status === 'submitted') {
        const order = await tradier.getOrder(ex.orderId);
        if (order) {
          const fillCheck = verificarFillPorPata(order, ex.contracts);
          if (fillCheck.completo) {
            ex.status = 'filled';
            ex.entryFillPrice = order.avg_fill_price || null;
            ex.creditReceived = ex.entryFillPrice != null ? Math.abs(parseFloat(ex.entryFillPrice)) : null;
            ex.filledAt = new Date().toISOString();
            cambios = true;
            console.log(`[Tradier-IC-TPSL] Orden ${ex.orderId} llenada — crédito recibido: $${ex.creditReceived}`);
          } else if (fillCheck.parcial) {
            console.error(`[Tradier-IC-TPSL] 🚨 Fill parcial/desbalanceado en orden ${ex.orderId}.`);
            if (IS_PRODUCTION) {
              const cerradas = await aplanarPatasParciales(fillCheck.detalle, 'SPXW');
              ex.status      = 'closed_emergency_partial';
              ex.closedAt    = new Date().toISOString();
              ex.closeReason = 'PARTIAL_FILL_EMERGENCY';
              ex.pnlSource   = 'emergencia_fill_parcial';
              ex.notes       = `Fill parcial — patas cerradas de emergencia: ${cerradas.join(', ') || 'ninguna (fallo el cierre)'}`;
              cambios = true;
            } else {
              console.log(`[Tradier-IC-TPSL] (local, no ejecuta) detectaría fill parcial en orden ${ex.orderId}.`);
            }
          }
        }
        continue;
      }

      if (ex.creditReceived == null) continue;

      const legSymbols = [ex.legs?.putShortSym, ex.legs?.putLongSym, ex.legs?.callShortSym, ex.legs?.callLongSym].filter(Boolean);
      if (legSymbols.length < 4) continue;

      const quotes = await tradier.getQuotes(legSymbols);
      const q = {};
      quotes.forEach(x => { q[x.symbol] = x.mark; });
      if (q[ex.legs.putShortSym] == null || q[ex.legs.putLongSym] == null || q[ex.legs.callShortSym] == null || q[ex.legs.callLongSym] == null) {
        console.warn(`[Tradier-IC-TPSL] Cotizaciones incompletas para ${ex.orderId}, se salta este ciclo.`);
        continue;
      }

      // Costo de cerrar ahora = recomprar las cortas + vender las largas
      const costoDeCerrar = (q[ex.legs.putShortSym] - q[ex.legs.putLongSym]) + (q[ex.legs.callShortSym] - q[ex.legs.callLongSym]);
      const pnlActual = ex.creditReceived - costoDeCerrar;
      const tpUmbral    = ex.creditReceived * ((ex.tpPct || 25) / 100);
      // El multiplicador de SL aplica al COSTO DE CERRAR (bruto), no al P&L neto —
      // a 1.5x credito=$200 el costo de cerrar llega a $300, perdida neta real=200-300=-$100
      // (-0.5x), NO -$300 (-1.5x) como se calculaba antes (bug: comparaba el neto contra
      // -slMult directo, esperando que el neto cayera 1.5x en vez de que el costo SUBIERA 1.5x).
      const slCostoUmbral = ex.creditReceived * (ex.slMult || 1.5);

      let cerrarPor = null;
      if (pnlActual >= tpUmbral) cerrarPor = 'TP';
      else if (costoDeCerrar >= slCostoUmbral) cerrarPor = 'SL';
      if (!cerrarPor) continue;

      if (!IS_PRODUCTION) {
        console.log(`[Tradier-IC-TPSL] (local, no ejecuta) tocaría cerrar por ${cerrarPor} — orden ${ex.orderId}.`);
        continue;
      }

      try {
        await tradier.closeIronCondorOrder({
          underlyingRoot:  'SPXW', expiry: ex.expiry,
          putShortStrike:  ex.strikes.shortStrike,     putLongStrike:  ex.strikes.longStrike,
          callShortStrike: ex.strikes.callShortStrike, callLongStrike: ex.strikes.callLongStrike,
          quantity:        ex.contracts,
        });
        ex.status      = 'closed';
        ex.closedAt    = new Date().toISOString();
        ex.pnl         = +(pnlActual * 100 * ex.contracts).toFixed(2);
        ex.pnlSource   = 'tp_sl_auto';
        ex.closeReason = cerrarPor;
        cambios = true;
        console.log(`[Tradier-IC-TPSL] ✅ Cerrado por ${cerrarPor} — P&L: $${ex.pnl}`);
      } catch(e) {
        console.error(`[Tradier-IC-TPSL] ❌ Error cerrando ${ex.orderId}:`, e.message);
      }
    }

    if (cambios) saveTradierExecutions(executions);
  } catch(e) {
    console.error('[Tradier-IC-TPSL] Error:', e.message);
  }
}
setInterval(checkIronCondorTPSL, 90 * 1000); // cada 90s — el TP/SL necesita reaccionar rapido

// ── Monitor activo de TP/SL para direccionales (Bull Put/Bear Call) — mismo
// patron que Iron Condor. Antes de esto, los direccionales solo mostraban el
// objetivo de TP/SL de forma informativa (signal.trading.tpTarget/slTarget)
// pero nadie colocaba la orden de cierre — el usuario tenia que cerrar a mano
// en Tradier siempre. Cierra 2 patas (corta+larga) en vez de las 4 del IC.
async function checkDirectionalTPSL() {
  if (!isMarketHours()) return;
  return withExecutionsLock(checkDirectionalTPSLImpl);
}
async function checkDirectionalTPSLImpl() {
  lastDirectionalTPSLRun = Date.now(); // heartbeat para el watchdog — ver checkDirectionalMonitorHealth
  try {
    const executions = loadTradierExecutions();
    // Las 4 verticales direccionales (credito + debito, agregado 2026-07-08) — ver
    // isCredit mas abajo para la bifurcacion de la formula de P&L.
    const abiertas = executions.filter(e =>
      ['BULL_PUT_SPREAD', 'BEAR_CALL_SPREAD', 'BULL_CALL_SPREAD', 'BEAR_PUT_SPREAD'].includes(e.strategy) &&
      e.strategyFamily !== 'REVERSION' && // Alejamiento de SMA tiene su propio monitor (checkAlejamientoSMATPSL) — cierra por precio, no por % de credito
      (e.status === 'submitted' || e.status === 'filled')
    );
    if (!abiertas.length) return;

    // Precio actual del SPX — para el gatillo tecnico (Fractal 15m / POC), igual
    // de liviano que el que usa checkAlejamientoSMATPSLImpl, reusado para todas
    // las ejecuciones abiertas de este ciclo (normalmente solo hay una).
    let spxPriceActual = null;
    try {
      const rPx = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=1d',
        { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const jPx = await rPx.json();
      spxPriceActual = parseFloat(jPx.chart?.result?.[0]?.meta?.regularMarketPrice);
      if (!spxPriceActual) spxPriceActual = null;
    } catch(e) {}

    let cambios = false;
    for (const ex of abiertas) {
      // 1. Confirmar fill si aun no se confirmo
      if (ex.status === 'submitted') {
        const order = await tradier.getOrder(ex.orderId);
        if (order) {
          const fillCheck = verificarFillPorPata(order, ex.contracts);
          if (fillCheck.completo) {
            ex.status = 'filled';
            ex.entryFillPrice = order.avg_fill_price || null;
            ex.creditReceived = ex.entryFillPrice != null ? Math.abs(parseFloat(ex.entryFillPrice)) : null;
            ex.filledAt = new Date().toISOString();
            cambios = true;
            console.log(`[Tradier-DIR-TPSL] Orden ${ex.orderId} llenada — crédito recibido: $${ex.creditReceived}`);
          } else if (fillCheck.parcial) {
            console.error(`[Tradier-DIR-TPSL] 🚨 Fill parcial/desbalanceado en orden ${ex.orderId}.`);
            if (IS_PRODUCTION) {
              const cerradas = await aplanarPatasParciales(fillCheck.detalle, 'SPXW');
              ex.status      = 'closed_emergency_partial';
              ex.closedAt    = new Date().toISOString();
              ex.closeReason = 'PARTIAL_FILL_EMERGENCY';
              ex.pnlSource   = 'emergencia_fill_parcial';
              ex.notes       = `Fill parcial — patas cerradas de emergencia: ${cerradas.join(', ') || 'ninguna (fallo el cierre)'}`;
              cambios = true;
            } else {
              console.log(`[Tradier-DIR-TPSL] (local, no ejecuta) detectaría fill parcial en orden ${ex.orderId}.`);
            }
          }
        }
        continue;
      }

      if (ex.creditReceived == null) continue;

      const shortSym = ex.legs?.shortSym, longSym = ex.legs?.longSym;
      if (!shortSym || !longSym) continue;

      const quotes = await tradier.getQuotes([shortSym, longSym]);
      const q = {};
      quotes.forEach(x => { q[x.symbol] = x.mark; });
      if (q[shortSym] == null || q[longSym] == null) {
        console.warn(`[Tradier-DIR-TPSL] Cotizaciones incompletas para ${ex.orderId}, se salta este ciclo.`);
        continue;
      }

      // isCredit indefinido (ejecuciones viejas, previas a este campo) = credito,
      // que es lo unico que existia antes del soporte a debito (2026-07-08).
      const esCredito = ex.isCredit !== false;
      let pnlActual, cerrarPor = null;

      // Invalidacion tecnica (playbook Alejandro, agregado 2026-07-09): si el
      // precio rompe el Fractal 15m o el POC de sesion EN CONTRA de la direccion,
      // la razon tecnica por la que se entro deja de existir — se sale de inmediato,
      // incluso si no se tocaron los umbrales economicos de TP/SL. Ambos niveles se
      // congelaron al momento de entrar (ex.fractalLevel/ex.pocLevel); null en
      // ejecuciones previas a este cambio, o si no habia suficiente historial de
      // fractales/volumen en el momento de la senal — en ese caso simplemente no
      // hay gatillo tecnico disponible para esa ejecucion.
      if (spxPriceActual != null) {
        const esAlcista = ex.direction === 'BULLISH';
        const rompioFractal = ex.fractalLevel != null && (esAlcista ? spxPriceActual < ex.fractalLevel : spxPriceActual > ex.fractalLevel);
        const rompioPOC     = ex.pocLevel     != null && (esAlcista ? spxPriceActual < ex.pocLevel     : spxPriceActual > ex.pocLevel);
        if (rompioFractal || rompioPOC) {
          cerrarPor = 'TECHNICAL_STOP';
          console.log(`[Tradier-DIR-TPSL] ⚠️ Invalidación técnica en ${ex.orderId} — precio ${spxPriceActual} rompió ${rompioFractal ? `Fractal 15m (${ex.fractalLevel})` : ''}${rompioFractal && rompioPOC ? ' y ' : ''}${rompioPOC ? `POC (${ex.pocLevel})` : ''}`);
        }
      }

      if (cerrarPor) {
        // Ya hay motivo de cierre (tecnico) — igual se necesita pnlActual para el
        // registro, calculado con la misma formula de siempre segun credito/debito.
        const costoDeCerrar = q[shortSym] - q[longSym];
        pnlActual = esCredito ? (ex.creditReceived - costoDeCerrar) : ((q[longSym] - q[shortSym]) - ex.creditReceived);
      } else if (esCredito) {
        // Costo de cerrar ahora = recomprar la corta - vender la larga
        const costoDeCerrar = q[shortSym] - q[longSym];
        pnlActual = ex.creditReceived - costoDeCerrar;
        const tpUmbral      = ex.creditReceived * ((ex.tpPct || 30) / 100);
        const slCostoUmbral = ex.creditReceived * (ex.slMult || 1.5);
        if (pnlActual >= tpUmbral) cerrarPor = 'TP';
        else if (costoDeCerrar >= slCostoUmbral) cerrarPor = 'SL';
      } else {
        // Debito: valor actual de la posicion = vender la larga - recomprar la corta
        // (mismo par de cotizaciones, restado al reves porque acá se es largo la
        // pata "long" y corto la "short", no al reves como en credito). P&L = valor
        // actual menos lo pagado. El riesgo maximo ya es 100% de lo pagado, por eso
        // el SL se expresa como % perdido, no como un multiplicador.
        const valorActual = q[longSym] - q[shortSym];
        pnlActual = valorActual - ex.creditReceived; // ex.creditReceived duplica aca como "debito pagado" (ambos son Math.abs(fill))
        const tpUmbral = ex.creditReceived * ((ex.debitTpPct ?? 50) / 100);
        const slUmbral = ex.creditReceived * ((ex.debitSlPct ?? 50) / 100);
        if (pnlActual >= tpUmbral) cerrarPor = 'TP';
        else if (pnlActual <= -slUmbral) cerrarPor = 'SL';
      }
      if (!cerrarPor) continue;

      if (!IS_PRODUCTION) {
        console.log(`[Tradier-DIR-TPSL] (local, no ejecuta) tocaría cerrar por ${cerrarPor} — orden ${ex.orderId}.`);
        continue;
      }

      try {
        await tradier.closeSpreadOrder({
          strategy:       ex.strategy,
          underlyingRoot: 'SPXW',
          expiry:         ex.expiry,
          shortStrike:    ex.strikes.shortStrike,
          longStrike:     ex.strikes.longStrike,
          quantity:       ex.contracts,
        });
        ex.status      = 'closed';
        ex.closedAt    = new Date().toISOString();
        ex.pnl         = +(pnlActual * 100 * ex.contracts).toFixed(2);
        ex.pnlSource   = 'tp_sl_auto';
        ex.closeReason = cerrarPor;
        cambios = true;
        console.log(`[Tradier-DIR-TPSL] ✅ Cerrado por ${cerrarPor} — P&L: $${ex.pnl}`);
      } catch(e) {
        console.error(`[Tradier-DIR-TPSL] ❌ Error cerrando ${ex.orderId}:`, e.message);
      }
    }

    if (cambios) saveTradierExecutions(executions);
  } catch(e) {
    console.error('[Tradier-DIR-TPSL] Error:', e.message);
  }
}
setInterval(checkDirectionalTPSL, 30 * 1000); // 90s->30s (2026-07-09): estas son operaciones de scalping 0DTE, reaccionar mas rapido reduce (no elimina) la carrera contra un cierre manual

// ── Watchdog del monitor direccional (2026-07-09) — Tradier no soporta OTOCO/bracket
// nativo sobre spreads multi-pata (el segundo/tercer leg de un OTOCO debe compartir
// el mismo option_symbol, no sirve para una vertical de 2 patas distintas) — asi que
// la unica proteccion real depende de que este proceso siga vivo y corriendo cada 30s.
// Este watchdog no reemplaza esa proteccion, solo avisa si se cayo, para no descubrirlo
// tarde: si hay una posicion direccional abierta y el monitor lleva mas de 3 minutos
// sin correr (deberia correr cada 30s), manda una alerta ntfy — una sola vez por caida,
// se resetea sola cuando el monitor vuelve a correr.
let lastDirectionalTPSLRun = Date.now();
let directionalMonitorAlertSent = false;
const DIRECTIONAL_MONITOR_STALL_MS = 3 * 60 * 1000;
async function checkDirectionalMonitorHealth() {
  if (!isMarketHours()) return;
  const stalled = Date.now() - lastDirectionalTPSLRun > DIRECTIONAL_MONITOR_STALL_MS;
  if (!stalled) { directionalMonitorAlertSent = false; return; }
  if (directionalMonitorAlertSent) return;
  const executions = loadTradierExecutions();
  const hayAbiertaDirectional = executions.some(e =>
    ['BULL_PUT_SPREAD', 'BEAR_CALL_SPREAD', 'BULL_CALL_SPREAD', 'BEAR_PUT_SPREAD'].includes(e.strategy) &&
    e.strategyFamily !== 'REVERSION' &&
    (e.status === 'submitted' || e.status === 'filled')
  );
  if (!hayAbiertaDirectional) return; // sin posicion en riesgo, un monitor caido no es urgente
  directionalMonitorAlertSent = true;
  const minsSinCorrer = Math.round((Date.now() - lastDirectionalTPSLRun) / 60000);
  console.error(`[MONITOR-WATCHDOG] 🚨 checkDirectionalTPSL lleva ${minsSinCorrer} min sin correr, con posicion abierta.`);
  try {
    await fetch('https://ntfy.sh/bitacora_gcarvaja51', {
      method: 'POST',
      headers: { 'Title': '🚨 Monitor direccional caído', 'Priority': 'urgent', 'Tags': 'warning,rotating_light', 'Content-Type': 'text/plain' },
      body: `El monitor de TP/SL direccional lleva ${minsSinCorrer} min sin correr, con una posición abierta sin protección activa. Revisar el servidor / Railway.`,
    });
  } catch(e) { console.error('[MONITOR-WATCHDOG] Error enviando ntfy:', e.message); }
}
setInterval(checkDirectionalMonitorHealth, 60 * 1000);

// ══════════════════════════════════════════════════════════════
// ── Alejamiento de SMA — reversión a la media (playbook Luis Silva) ──
// ══════════════════════════════════════════════════════════════
// Pipeline independiente y paralelo al direccional/Iron Condor — no depende de
// una alerta de Pine, se evalúa periódicamente igual que el Iron Condor, pero
// con su propio gate horario, su propio score, y su propio slot de exclusividad
// (NO usa hasOpenPosition('SPXW') a propósito: el hold es de 2-10 min y no debe
// bloquearse por un Iron Condor/direccional ya abierto — decisión del usuario.
// Limitación conocida: al revés sí puede pasar, el hasOpenPosition('SPXW') de
// esos otros dos SÍ va a ver esta posición mientras dure y se van a pausar
// solos — inevitable sin tracking de posición por estrategia a nivel Tradier).
async function checkAlejamientoSMA() {
  try {
    const et = getETHour();
    const gate = evaluateReversionGate(et.hour, et.min);
    if (!gate.valid) return;

    const spxConfig = loadSPXConfig();
    const cfg = (spxConfig.trading || SPX_CONFIG_DEFAULTS.trading).smaReversion || SPX_CONFIG_DEFAULTS.trading.smaReversion;

    const today = new Date().toISOString().slice(0, 10);
    const executions = loadTradierExecutions();

    // Circuito diario (regla de Luis Silva): 2 PERDIDAS CONSECUTIVAS o un drawdown
    // diario de 3-4% de la cuenta, lo que llegue primero — no un simple conteo total
    // de stops (una ganadora en el medio resetea el contador de consecutivas).
    const reversionesHoy = executions
      .filter(e => e.strategyFamily === 'REVERSION' && (e.closedAt || '').slice(0, 10) === today)
      .sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt));

    let perdidasConsecutivas = 0;
    for (let i = reversionesHoy.length - 1; i >= 0; i--) {
      if (reversionesHoy[i].closeReason === 'TP') break;
      perdidasConsecutivas++;
    }
    if (perdidasConsecutivas >= (cfg.maxStopsPerDay || 2)) {
      console.log(`[SPX-REV] ❌ Circuito diario: ${perdidasConsecutivas} pérdidas consecutivas hoy`);
      return;
    }

    let capital = 10000;
    try {
      const balances = await tradier.getBalances();
      capital = parseFloat(balances?.total_equity || capital);
    } catch(e) {}

    const pnlHoy = reversionesHoy.reduce((sum, e) => sum + (e.pnl || 0), 0);
    const drawdownPct = capital > 0 ? (pnlHoy / capital) * 100 : 0;
    const maxDrawdown = cfg.maxDailyDrawdownPct ?? 3.5;
    if (drawdownPct <= -maxDrawdown) {
      console.log(`[SPX-REV] ❌ Circuito diario: drawdown ${drawdownPct.toFixed(2)}% (límite -${maxDrawdown}%)`);
      return;
    }

    // Exclusividad propia — no comparte hasOpenPosition('SPXW') con las otras dos
    const yaHayReversionAbierta = executions.some(e =>
      e.strategyFamily === 'REVERSION' && (e.status === 'submitted' || e.status === 'filled')
    );
    if (yaHayReversionAbierta) return;

    const ctx = await buildSPXContext();

    // Gate duro (no ponderado): fuera de GEX positivo la reversión "pierde su hábitat"
    // (dealers amplifican en vez de estabilizar) — no debe poder compensarse con el
    // resto del score como pasaba cuando regimen_gex era solo el 10% del puntaje.
    if (ctx.gex?.regime !== 'POSITIVO') {
      console.log(`[SPX-REV] ❌ GEX ${ctx.gex?.regime || 'desconocido'} — reversión requiere gamma positivo (gate duro)`);
      return;
    }

    const bars = ctx.indicators?.m2?.bars || [];
    if (bars.length < 25) return;

    const closes = bars.map(b => b.close);
    const price  = closes[closes.length - 1];
    const sma8Arr = calcSMAArray(closes, 8);
    const sma8 = sma8Arr[sma8Arr.length - 1];
    if (sma8 == null) return;

    const ext8 = priceExtension(price, sma8);
    const rsi  = calcRSI(closes);
    // Direccion candidata: precio debajo de SMA8 -> reversion alcista; arriba -> bajista
    const direction = price < sma8 ? 'BULLISH' : 'BEARISH';
    const patronReversion = evaluateReversionPattern(bars, direction);

    const scoreResult = calcReversionScore({
      direction, ext8, patronReversion, rsi,
      m15: ctx.indicators?.m15 || {},
      gammaRegime: ctx.gex?.regime,
      spxPrice: ctx.spxPrice,
      callWall: ctx.gex?.callWall,
      putWall: ctx.gex?.putWall,
      wallProximityPts: cfg.wallProximityPts,
    }, cfg);

    if (!scoreResult.passed) {
      console.log(`[SPX-REV] ❌ Score insuficiente: ${scoreResult.score}% (mínimo ${scoreResult.minScore}%)`);
      return;
    }

    const strategy = direction === 'BULLISH' ? 'BULL_PUT_SPREAD' : 'BEAR_CALL_SPREAD';
    const chainRes = await fetch(`http://localhost:${process.env.PORT||3000}/api/option-chain/SPX`);
    const chainData = await chainRes.json();
    const strikes = findStrikesByDelta(chainData.expirations || [], strategy, ctx.spxPrice, '0DTE', cfg.targetDelta, cfg.spreadWidth);
    if (!strikes || !strikes.shortStrike) {
      console.log(`[SPX-REV] ❌ No se encontraron strikes con delta ${cfg.targetDelta}`);
      return;
    }

    // Sizing conservador: 1% de riesgo (vs 2% de las otras dos) por ser un
    // scalp de alta frecuencia potencial — varias entradas por sesión posibles.
    // `capital` ya se obtuvo arriba para el circuito de riesgo diario, se reusa aqui.
    const maxRisk   = capital * 0.01;
    const contracts = Math.max(1, Math.floor(maxRisk / (cfg.spreadWidth * 100)));

    const entryBar = bars[bars.length - 1];

    const signal = buildSignalSummary(strategy, strikes, {
      valid: true, strategy, isCredit: true, expType: '0DTE', spreadWidth: cfg.spreadWidth, contracts,
    }, {
      direction, spxPrice: ctx.spxPrice, vix: ctx.vix, ivRank: ctx.ivRank,
      gammaRegime: ctx.gex?.regime, callWall: ctx.gex?.callWall, putWall: ctx.gex?.putWall,
      gammaFlip: ctx.gex?.gammaFlip, maxPain: ctx.gex?.maxPain,
      technicalStop: null, technicalStopSource: null, etTime: ctx.etTime,
    });
    signal.strategyFamily = 'REVERSION';
    signal.playbook = scoreResult;
    signal.notes = `Alejamiento de SMA — patrón ${patronReversion.pattern || 'ninguno'}, SMA8 ${sma8}`;

    if (IS_PRODUCTION && cfg.tradierAutoExecute !== false) {
      try {
        const order = await tradier.placeSpreadOrder({
          strategy, underlyingRoot: 'SPXW', expiry: strikes.expiry,
          shortStrike: strikes.shortStrike, longStrike: strikes.longStrike, quantity: contracts,
        });
        signal.tradierOrder = { orderId: order.orderId, status: order.status, legs: order.legs };
        signal.status   = 'EXECUTED';
        signal.actionAt = new Date().toISOString();
        console.log(`[Tradier-REV] ✅ Orden enviada: ${order.orderId} (${order.status}) — ${strategy} ${strikes.shortStrike}/${strikes.longStrike}`);

        await withExecutionsLock(() => {
          const execs = loadTradierExecutions();
          execs.unshift({
            id:             `tex-${Date.now()}`,
            signalId:       signal.id,
            timestamp:      signal.timestamp,
            strategy,
            strategyFamily: 'REVERSION',
            direction,
            strikes:        signal.strikes,
            expiry:         strikes.expiry,
            contracts,
            orderId:        order.orderId,
            legs:           order.legs,
            status:         'submitted',
            entryFillPrice: null,
            creditReceived: null,
            // Ancla del SL (ruptura de la vela de entrada) y objetivo de TP
            // (SMA8 al momento de entrar — se congela por simplicidad, no se
            // recalcula en vivo cada 15-20s; con un hold de minutos la SMA8
            // no se mueve mucho, revisar si esto necesita ser mas preciso
            // despues del curso con Luis Silva).
            entryCandleLow:  entryBar.low,
            entryCandleHigh: entryBar.high,
            smaTarget:       sma8,
            pattern:         patronReversion.pattern,
            filledAt:   null,
            closedAt:   null,
            closeReason: null,
            pnl:        null,
            pnlSource:  null,
          });
          saveTradierExecutions(execs);
        });
      } catch(e) {
        signal.tradierOrder = { error: e.message };
        console.error('[Tradier-REV] ❌ Error enviando orden:', e.message);
      }
    }

    const signals = loadSPXSignals();
    signals.unshift(signal);
    saveSPXSignals(signals.slice(0, 50));
    console.log(`[SPX-REV] ✅ Señal generada: ${strategy} ${signal.strikes?.shortStrike}/${signal.strikes?.longStrike} (${patronReversion.pattern}, score ${scoreResult.score}%)`);
  } catch(e) {
    console.error('[SPX-REV] Error:', e.message);
  }
}
setInterval(checkAlejamientoSMA, 60 * 1000); // cada 60s — solo puede confirmar con una vela de 2m ya cerrada

// ── Monitor de cierre de Alejamiento de SMA — rapido (15-20s, el hold es de
// minutos) y por PRECIO del SPX, no por % de credito como las otras dos
// estrategias (decision explicita del usuario, fiel al setup de Luis Silva):
// TP = toque de SMA8, SL = ruptura de la vela de entrada, + stop de tiempo.
async function checkAlejamientoSMATPSL() {
  if (!isMarketHours()) return;
  return withExecutionsLock(checkAlejamientoSMATPSLImpl);
}
async function checkAlejamientoSMATPSLImpl() {
  try {
    const executions = loadTradierExecutions();
    const abiertas = executions.filter(e =>
      e.strategyFamily === 'REVERSION' && (e.status === 'submitted' || e.status === 'filled')
    );
    if (!abiertas.length) return;

    let cambios = false;
    for (const ex of abiertas) {
      if (ex.status === 'submitted') {
        const order = await tradier.getOrder(ex.orderId);
        if (order) {
          const fillCheck = verificarFillPorPata(order, ex.contracts);
          if (fillCheck.completo) {
            ex.status = 'filled';
            ex.entryFillPrice = order.avg_fill_price || null;
            ex.creditReceived = ex.entryFillPrice != null ? Math.abs(parseFloat(ex.entryFillPrice)) : null;
            ex.filledAt = new Date().toISOString();
            cambios = true;
            console.log(`[Tradier-REV-TPSL] Orden ${ex.orderId} llenada`);
          } else if (fillCheck.parcial) {
            console.error(`[Tradier-REV-TPSL] 🚨 Fill parcial/desbalanceado en orden ${ex.orderId}.`);
            if (IS_PRODUCTION) {
              const cerradas = await aplanarPatasParciales(fillCheck.detalle, 'SPXW');
              ex.status      = 'closed_emergency_partial';
              ex.closedAt    = new Date().toISOString();
              ex.closeReason = 'PARTIAL_FILL_EMERGENCY';
              ex.pnlSource   = 'emergencia_fill_parcial';
              cambios = true;
            } else {
              console.log(`[Tradier-REV-TPSL] (local, no ejecuta) detectaría fill parcial en orden ${ex.orderId}.`);
            }
          }
        }
        continue;
      }

      // Precio actual del SPX — liviano (mismo endpoint que usa buildSPXContext
      // para el precio, sin reconstruir todo el contexto cada 15-20s).
      let price;
      try {
        const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=1d',
          { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const j = await r.json();
        price = parseFloat(j.chart?.result?.[0]?.meta?.regularMarketPrice);
      } catch(e) { continue; }
      if (!price) continue;

      const isBullish = ex.direction === 'BULLISH';
      const cfg = (loadSPXConfig().trading || {}).smaReversion || SPX_CONFIG_DEFAULTS.trading.smaReversion;
      const candlesElapsed = ex.filledAt ? Math.floor((Date.now() - new Date(ex.filledAt).getTime()) / (2 * 60 * 1000)) : 0;

      let cerrarPor = null;
      if      (isBullish  && price >= ex.smaTarget)      cerrarPor = 'TP';
      else if (!isBullish && price <= ex.smaTarget)       cerrarPor = 'TP';
      else if (isBullish  && price < ex.entryCandleLow)  cerrarPor = 'SL';
      else if (!isBullish && price > ex.entryCandleHigh) cerrarPor = 'SL';
      else if (candlesElapsed >= (cfg.maxCandlesTimeStop || 5)) cerrarPor = 'TIME_STOP';

      if (!cerrarPor) continue;

      if (!IS_PRODUCTION) {
        console.log(`[Tradier-REV-TPSL] (local, no ejecuta) tocaría cerrar por ${cerrarPor} — orden ${ex.orderId}.`);
        continue;
      }

      try {
        await tradier.closeSpreadOrder({
          strategy:       ex.strategy,
          underlyingRoot: 'SPXW',
          expiry:         ex.expiry,
          shortStrike:    ex.strikes.shortStrike,
          longStrike:     ex.strikes.longStrike,
          quantity:       ex.contracts,
        });
        ex.status      = 'closed';
        ex.closedAt    = new Date().toISOString();
        ex.closeReason = cerrarPor;
        // P&L real se completa despues via checkTradierExecutions (reconciliacion
        // pasiva con tradier.getClosedPnl), igual que ya pasa hoy para posiciones
        // que "desaparecen" sin que un monitor activo haya calculado el numero.
        ex.pnlSource   = 'precio_spx_auto';
        cambios = true;
        console.log(`[Tradier-REV-TPSL] ✅ Cerrado por ${cerrarPor} — orden ${ex.orderId}`);
      } catch(e) {
        console.error(`[Tradier-REV-TPSL] ❌ Error cerrando ${ex.orderId}:`, e.message);
      }
    }

    if (cambios) saveTradierExecutions(executions);
  } catch(e) {
    console.error('[Tradier-REV-TPSL] Error:', e.message);
  }
}
setInterval(checkAlejamientoSMATPSL, 15 * 1000); // cada 15s — hold de minutos, necesita reaccionar rapido

// POST /api/tradier/executions/clear — limpieza manual del historial (uso puntual,
// para arrancar en limpio antes de una sesion de mercado real).
app.post('/api/tradier/executions/clear', async (req, res) => {
  await withExecutionsLock(() => saveTradierExecutions([]));
  res.json({ ok: true, cleared: true });
});

// POST /api/tradier/executions/add — insercion manual puntual (uso de emergencia,
// para reconciliar una posicion real en Tradier que por algun motivo no quedo
// registrada por checkIronCondor/webhook, y que el monitor de TP/SL necesita
// conocer para poder gestionarla).
app.post('/api/tradier/executions/add', async (req, res) => {
  const total = await withExecutionsLock(() => {
    const executions = loadTradierExecutions();
    executions.unshift(req.body);
    saveTradierExecutions(executions);
    return executions.length;
  });
  res.json({ ok: true, added: true, total });
});

// POST /api/tradier/executions/:id/patch — correccion manual puntual de un registro
// ya existente (ej. pnl/pnlSource/closeReason que la reconciliacion pasiva dejo en
// 'pendiente_verificar' porque el gain_loss de Tradier todavia no estaba asentado
// en el momento del chequeo). Mezcla superficialmente los campos dados, no reemplaza
// el registro completo.
app.post('/api/tradier/executions/:id/patch', async (req, res) => {
  const result = await withExecutionsLock(() => {
    const executions = loadTradierExecutions();
    const idx = executions.findIndex(e => e.id === req.params.id);
    if (idx === -1) return { ok: false, error: 'not_found' };
    executions[idx] = { ...executions[idx], ...req.body };
    saveTradierExecutions(executions);
    return { ok: true, execution: executions[idx] };
  });
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

// GET /api/tradier/executions — historial + balance real de la cuenta demo
const TRADIER_STARTING_BALANCE = 100000; // capital inicial de la cuenta sandbox
app.get('/api/tradier/executions', async (req, res) => {
  const executions = loadTradierExecutions();
  let account = null;
  try {
    const balances = await tradier.getBalances();
    if (balances) {
      account = {
        netLiq:        balances.total_equity,
        totalCash:     balances.total_cash,
        // Tradier anida el buying power bajo una clave distinta segun account_type:
        // "margin" -> balances.margin, "pdt" -> balances.pdt (confirmado 2026-07-09,
        // esta cuenta sandbox es tipo "pdt" — el codigo viejo solo miraba .margin,
        // que ni existe en la respuesta para pdt, mostrando siempre $0).
        buyingPower:   balances.margin?.option_buying_power ?? balances.margin?.stock_buying_power
                    ?? balances.pdt?.option_buying_power    ?? balances.pdt?.stock_buying_power
                    ?? balances.cash?.cash_available ?? null,
        startingBalance: TRADIER_STARTING_BALANCE,
        pnlTotal:      balances.total_equity - TRADIER_STARTING_BALANCE,
      };
    }
  } catch(e) {
    console.error('[TRADIER] Error obteniendo balance:', e.message);
  }
  res.json({ executions, account });
});

// POST /api/spx/signals/:id/action — ejecutar o rechazar
app.post('/api/spx/signals/:id/action', async (req, res) => {
  try {
    const { action, notes = '' } = req.body; // action: EXECUTED | REJECTED
    const signals = loadSPXSignals();
    const idx = signals.findIndex(s => s.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Señal no encontrada' });

    signals[idx].status    = action;
    signals[idx].notes     = notes;
    signals[idx].actionAt  = new Date().toISOString();
    saveSPXSignals(signals);

    res.json({ ok: true, signal: signals[idx] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Extrínseco — chequeo automático ─────────────────────────
// Estado de alertas: { 'UNDERLYING::EXP': { firstAlert: Date, lastAlert: Date } }
const extrinsicAlertState = new Map();
const EXTR_REMINDER_MS   = 2 * 60 * 60 * 1000; // 2 horas
const EXTR_CHECK_MS      = 15 * 60 * 1000;       // chequeo cada 15 min

function detectStrategy(legs) {
  const shorts = legs.filter(l => l['quantity-direction'] === 'Short');
  const longs  = legs.filter(l => l['quantity-direction'] === 'Long');
  const hasShortPut  = shorts.some(l => /P\d{8}$/.test(l.symbol));
  const hasShortCall = shorts.some(l => /C\d{8}$/.test(l.symbol));
  const hasLongPut   = longs.some(l =>  /P\d{8}$/.test(l.symbol));
  const hasLongCall  = longs.some(l =>  /C\d{8}$/.test(l.symbol));
  if (hasShortPut  && hasLongPut  && !hasShortCall) return 'Bull Put Spread';
  if (hasShortCall && hasLongCall && !hasShortPut)  return 'Bear Call Spread';
  if (hasShortPut  && hasShortCall)                 return 'Short Strangle';
  if (hasShortPut  && !hasLongPut)                  return 'CSP';
  if (hasShortCall && !hasLongCall)                 return 'Covered Call';
  return 'Spread';
}

const NYSE_HOLIDAYS = new Set([
  // 2026
  '2026-01-01','2026-01-19','2026-02-16','2026-04-03',
  '2026-05-25','2026-06-19','2026-07-03','2026-09-07',
  '2026-11-26','2026-12-25',
  // 2027
  '2027-01-01','2027-01-18','2027-02-15','2027-03-26',
  '2027-05-31','2027-06-18','2027-07-05','2027-09-06',
  '2027-11-25','2027-12-24',
]);

function isMarketHours() {
  // OJO: antes hacia new Date(now.toLocaleString(...)) y leia .getDay()/.getHours()
  // sobre ese resultado — eso solo da la hora ET correcta si el timezone LOCAL del
  // proceso que corre el codigo es UTC (cierto en Railway, pero NO en el servidor
  // local en Windows, que corre en la zona horaria del usuario). Mismo patron
  // robusto (independiente del TZ del sistema) que ya usa getETHour(): extraer los
  // componentes como texto en vez de reconstruir un Date y confiar en el TZ local.
  const now = new Date();
  const dateStr = now.toLocaleString('en-CA', { timeZone: 'America/New_York' }).slice(0, 10);
  const dayName = now.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  if (dayName === 'Sat' || dayName === 'Sun') return false;
  if (NYSE_HOLIDAYS.has(dateStr)) return false;
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
  let [hour, min] = etStr.split(':').map(Number);
  if (hour === 24) hour = 0;
  const mins = hour * 60 + min;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

async function checkExtrinsicAndNotify() {
  console.log('[EXTR] Iniciando chequeo de extrínseco...');
  try {
    const positions = await tt.getPositions();
    if (!positions || !positions.length) return;

    const optPositions = positions.filter(p => p['instrument-type'] !== 'Equity');
    const underlyings  = [...new Set(optPositions.map(p => p['underlying-symbol'] || p.symbol))];
    const optSymbols   = optPositions.map(p => p.symbol).filter(Boolean);

    const priceMap = {};
    const markMap  = {};

    // Fetch subyacentes por separado para no contaminar con precios de opciones
    try {
      const params = underlyings.map(s => `symbols[]=${encodeURIComponent(s)}`).join('&');
      const d = await tt._req(`/market-data?${params}`);
      for (const item of (d?.data?.items || [])) {
        const price = parseFloat(item.last || item.mark || item.mid || 0);
        if (price > 0) priceMap[item.symbol] = price;
      }
    } catch(e) { console.warn('[EXTR] Error precios subyacentes:', e.message); }

    // Fetch opciones por separado
    try {
      const BATCH = 50;
      for (let i = 0; i < optSymbols.length; i += BATCH) {
        const batch  = optSymbols.slice(i, i + BATCH);
        const params = batch.map(s => `symbols[]=${encodeURIComponent(s)}`).join('&');
        const d      = await tt._req(`/market-data?${params}`);
        for (const item of (d?.data?.items || [])) {
          const price = parseFloat(item.mark || item.mid || item.last || 0);
          if (price > 0) markMap[item.symbol] = price;
        }
      }
    } catch(e) { console.warn('[EXTR] Error precios opciones:', e.message); }

    console.log('[EXTR] Subyacentes:', JSON.stringify(priceMap));
    console.log('[EXTR] Opciones mark:', JSON.stringify(markMap));


    // Construir grupos por underlying+exp para detectar estrategia
    const legGroups = {};
    for (const p of positions) {
      if (p['instrument-type'] === 'Equity') continue;
      const und = p['underlying-symbol'] || p.symbol;
      const exp = p['expires-at'] ? new Date(p['expires-at']).toISOString().slice(0,10) : '';
      const key = `${und}::${exp}`;
      if (!legGroups[key]) legGroups[key] = [];
      legGroups[key].push(p);
    }

    const activeKeys = new Set();
    for (const p of positions) {
      if (p['instrument-type'] === 'Equity') continue;
      if (p['quantity-direction'] !== 'Short') continue;
      const und = p['underlying-symbol'] || p.symbol;
      const exp = p['expires-at'] ? new Date(p['expires-at']).toISOString().slice(0,10) : '';
      activeKeys.add(`${und}::${exp}::${p.symbol}`);
    }
    for (const k of extrinsicAlertState.keys()) {
      if (!activeKeys.has(k)) extrinsicAlertState.delete(k);
    }

    // Revisar cada short leg individualmente (risk de asignacion)
    for (const p of positions) {
      if (p['instrument-type'] === 'Equity') continue;
      if (p['quantity-direction'] !== 'Short') continue;

      const und    = p['underlying-symbol'] || p.symbol;
      const exp    = p['expires-at'] ? new Date(p['expires-at']).toISOString().slice(0,10) : '';
      const legKey = `${und}::${exp}::${p.symbol}`;

      const uPrice = priceMap[und] || 0;
      if (!uPrice) {
        console.log(`[EXTR] ${und}: precio no disponible, saltando`);
        continue;
      }

      const mp  = markMap[p.symbol] || parseFloat(p['mark-price'] || p['close-price'] || 0);
      if (!mp) {
        console.log(`[EXTR] ${und} ${p.symbol}: mark-price no disponible, saltando`);
        continue;
      }

      const sym      = (p.symbol || '').replace(/\s+/g,' ').trim();
      const occMatch = sym.match(/([CP])(\d{8})$/);
      if (!occMatch) continue;

      const isCall    = occMatch[1] === 'C';
      const strike    = parseInt(occMatch[2]) / 1000;
      const intrinsic = isCall ? Math.max(0, uPrice - strike) : Math.max(0, strike - uPrice);
      const extrLeg   = Math.max(0, mp - intrinsic);
      const qty       = parseFloat(p.quantity || 1);
      const mul       = parseFloat(p.multiplier || 100);
      const premium   = parseFloat(p['average-open-price'] || 0) * qty * mul;
      const extrPct   = premium > 0 ? (extrLeg * qty * mul) / premium * 100 : 0;
      const optType   = isCall ? 'Call' : 'Put';
      const groupKey  = `${und}::${exp}`;
      const strategy  = legGroups[groupKey] ? detectStrategy(legGroups[groupKey]) : 'Opcion';

      console.log(`[EXTR] Short ${optType} ${und} strike ${strike} exp ${exp}: mp=$${mp} extr=$${extrLeg.toFixed(2)} (${extrPct.toFixed(1)}% del premium)`);

      if (extrPct < 5) {
        const now   = Date.now();
        const state = extrinsicAlertState.get(legKey);
        const isNew = !state;
        const isReminder = state && (now - state.lastAlert) >= EXTR_REMINDER_MS && isMarketHours();

        if (isNew || isReminder) {
          const tag   = isNew ? 'NUEVA ALERTA' : 'RECORDATORIO';
          const title = `Bitacora - ${tag}`;
          const body  = [
            tag,
            `Activo: ${und}`,
            `Estrategia: ${strategy}`,
            `Riesgo: Short ${optType} en ${strategy}`,
            `Strike $${strike} — Vence ${exp}`,
            `Extrínseco $${extrLeg.toFixed(2)} (${extrPct.toFixed(1)}% de la prima)`,
            `Riesgo de Asignacion`
          ].join('\n');
          console.log(`[EXTR] Enviando ntfy: ${body}`);
          try {
            const ntfyResp = await fetch('https://ntfy.sh/bitacora_gcarvaja51', {
              method: 'POST',
              headers: { 'Title': title, 'Priority': 'urgent', 'Tags': 'warning,rotating_light', 'Content-Type': 'text/plain' },
              body
            });
            const ntfyJson = await ntfyResp.json();
            console.log(`[EXTR] ntfy resp:`, JSON.stringify(ntfyJson));
          } catch(e) { console.warn('[EXTR] ntfy error:', e.message); }

          extrinsicAlertState.set(legKey, {
            firstAlert: state?.firstAlert || now,
            lastAlert: now
          });
        }
      } else {
        // Volvió sobre 5% — resetear estado
        if (extrinsicAlertState.has(legKey)) {
          console.log(`[EXTR] ${und} volvió sobre 5%, reseteando alerta`);
          extrinsicAlertState.delete(legKey);
        }
      }
    }
    console.log('[EXTR] Chequeo completado.');
  } catch(e) { console.error('[EXTR] Error:', e.message); }
}

function scheduleExtrinsicChecks() {
  async function tick() {
    if (isMarketHours()) {
      await checkExtrinsicAndNotify();
    } else {
      console.log('[EXTR] Fuera de horario de mercado, saltando chequeo');
    }
    setTimeout(tick, EXTR_CHECK_MS);
  }
  // Primer chequeo en 1 minuto para que el servidor termine de iniciar
  setTimeout(tick, 60 * 1000);
  console.log(`[EXTR] Monitor iniciado — chequeo cada 15 min en horario de mercado`);
}

// ── Limpieza automatica de ordenes "pending" huerfanas en Tradier — hoy (2026-07-05
// y 2026-07-07) tuvimos ordenes de prueba que se quedaron en pending indefinidamente
// (nunca fillean en el sandbox) y bloqueaban hasOpenPosition() para senales reales
// nuevas; habia que cancelarlas a mano. Cancela cualquier orden 'pending' con mas
// de 10 min de antiguedad, automaticamente, solo en produccion.
// IMPORTANTE: solo actua sobre ordenes de SPXW (nuestro universo) — antes cancelaba
// CUALQUIER orden pending de la cuenta sin distinguir si era nuestra, arriesgando
// cancelar algo que el usuario hubiera colocado manualmente en el sandbox.
const PENDING_ORDER_MAX_AGE_MS = 10 * 60 * 1000; // 10 min
function ordenEsDeNuestroUniverso(o, root = 'SPXW') {
  if ((o.symbol || '').startsWith(root)) return true;
  const legs = Array.isArray(o.leg) ? o.leg : (o.leg ? [o.leg] : []);
  return legs.some(l => (l.option_symbol || '').startsWith(root));
}
async function cleanupStalePendingOrders() {
  if (!IS_PRODUCTION) return;
  return withExecutionsLock(cleanupStalePendingOrdersImpl);
}
async function cleanupStalePendingOrdersImpl() {
  try {
    const orders = await tradier.getOrders();
    const ahora = Date.now();
    for (const o of orders) {
      if (o.status !== 'pending') continue;
      if (!ordenEsDeNuestroUniverso(o)) continue;
      const edadMs = ahora - new Date(o.create_date).getTime();
      if (edadMs < PENDING_ORDER_MAX_AGE_MS) continue;
      try {
        await tradier.cancelOrder(o.id);
        console.log(`[TRADIER-CLEANUP] 🗑️ Orden pending huérfana cancelada: ${o.id} (${Math.round(edadMs/60000)} min de antigüedad).`);
        // Si esta orden esta en nuestro propio tracking como 'submitted', marcarla
        // cancelada tambien — si no, los monitores activos (checkIronCondorTPSL/
        // checkDirectionalTPSL) seguirian consultando getOrder() cada 90s para
        // siempre sobre una orden que ya no existe, con un registro "fantasma"
        // atascado en 'submitted' de forma permanente.
        const executions = loadTradierExecutions();
        const ex = executions.find(e => String(e.orderId) === String(o.id) && e.status === 'submitted');
        if (ex) {
          ex.status = 'canceled';
          ex.closedAt = new Date().toISOString();
          ex.notes = (ex.notes ? ex.notes + ' | ' : '') + 'Orden cancelada automaticamente por quedar pending mas de 10 min sin llenarse.';
          saveTradierExecutions(executions);
          console.log(`[TRADIER-CLEANUP] Registro de seguimiento ${ex.id} marcado como cancelado.`);
        }
      } catch(e) {
        console.error(`[TRADIER-CLEANUP] Error cancelando orden ${o.id}:`, e.message);
      }
    }
  } catch(e) {
    console.error('[TRADIER-CLEANUP] Error:', e.message);
  }
}
setInterval(cleanupStalePendingOrders, 10 * 60 * 1000); // cada 10 min

// ── Seguimiento de ejecuciones en Tradier (dashboard independiente) ──
const TRADIER_TRACK_MS = 5 * 60 * 1000; // 5 min

async function checkTradierExecutions() {
  return withExecutionsLock(checkTradierExecutionsImpl);
}
async function checkTradierExecutionsImpl() {
  const executions = loadTradierExecutions();
  const pendientes = executions.filter(e => e.status === 'submitted' || e.status === 'filled');
  if (!pendientes.length) return;

  console.log(`[TRADIER-TRACK] Revisando ${pendientes.length} ejecución(es) en curso...`);
  let cambios = false;

  for (const ex of pendientes) {
    try {
      // La confirmacion de fill (con verificacion pata-por-pata) ya la hacen
      // checkIronCondorTPSL/checkDirectionalTPSL cada 90s para las 3 estrategias
      // que hoy se auto-ejecutan — este monitor pasivo ya no la duplica (la version
      // vieja aqui solo miraba el agregado, el mismo bug que se corrigio en los
      // monitores activos). Este chequeo se salta las que siguen 'submitted' y
      // solo se encarga de detectar cuando una 'filled' ya no existe (se cerro
      // manual, por vencimiento, o por el cierre de emergencia de fill parcial).
      if (ex.status === 'submitted') continue;

      // ¿La posición ya no existe? (se cerró, manual o por vencimiento)
      // IMPORTANTE: antes solo miraba shortSym/longSym (nomenclatura direccional) —
      // para Iron Condor (putShortSym/putLongSym/callShortSym/callLongSym) esa lista
      // quedaba vacia SIEMPRE, haciendo que "sigueAbierta" fuera false de inmediato y
      // este monitor pasivo marcara CUALQUIER Iron Condor como cerrado apenas se
      // confirmaba el fill, aunque siguiera genuinamente abierto — pisando el estado
      // que el monitor activo (checkIronCondorTPSL) si esta gestionando bien.
      const positions = await tradier.getPositions();
      const symbolsAbiertos = new Set(positions.map(p => p.symbol));
      const legSymbols = [
        ex.legs?.shortSym, ex.legs?.longSym,
        ex.legs?.putShortSym, ex.legs?.putLongSym, ex.legs?.callShortSym, ex.legs?.callLongSym,
      ].filter(Boolean);
      const sigueAbierta = legSymbols.some(s => symbolsAbiertos.has(s));

      if (!sigueAbierta) {
        ex.status = 'closed';
        ex.closedAt = new Date().toISOString();
        // Este monitor es pasivo — no coloco la orden de cierre, solo detecto que la
        // posicion ya no esta. Pudo ser el usuario cerrandola a mano, o el vencimiento
        // natural del 0DTE; no hay forma de distinguirlo desde aqui, MANUAL es la
        // etiqueta mas honesta para "se cerro fuera de mis monitores activos".
        ex.closeReason = ex.closeReason || 'MANUAL';

        // Bug real encontrado 2026-07-09: si dos ejecuciones distintas usan los MISMOS
        // strikes el mismo dia (comun en scalping 0DTE, los strikes se repiten cuando
        // el precio vuelve a una zona), getClosedPnl trae varias entradas para el mismo
        // symbol y el filtro viejo (legSymbols.includes(p.symbol), sin mas) las sumaba
        // TODAS sin importar a cual ejecucion pertenecian de verdad — le pego el P&L
        // completo de las dos ejecuciones a la que se reconciliaba de ultima. Tradier no
        // expone un id que ate cada entrada de gain_loss a una orden especifica, asi que
        // la mitigacion es por conteo: las entradas de un symbol vienen mas-reciente-
        // primero (confirmado empiricamente); si ya hay OTRAS ejecuciones YA CERRADAS
        // (sin importar por que camino calcularon su propio pnl — tp_sl_auto tambien
        // cuenta, no solo gainloss, porque esas entradas de Tradier existen igual
        // aunque esa ejecucion no las haya usado) con este mismo conjunto de
        // legSymbols, se saltan esas tantas entradas (mas nuevas, ya "ocupadas" por
        // esas otras ejecuciones) antes de tomar la que le toca a esta. Sigue siendo
        // una heuristica, no un ID real — si el orden no es estrictamente por
        // recencia se puede reconciliar mal, pero es mucho mejor que sumar todo sin
        // distincion.
        const pnlList = await tradier.getClosedPnl(ex.timestamp.slice(0, 10));
        const legSymbolsSorted = legSymbols.slice().sort();
        const claveSimbolos = JSON.stringify(legSymbolsSorted);
        const otrasConMismosSimbolos = executions.filter(o => {
          if (o.id === ex.id || o.status !== 'closed') return false;
          const legsO = [o.legs?.shortSym, o.legs?.longSym, o.legs?.putShortSym, o.legs?.putLongSym, o.legs?.callShortSym, o.legs?.callLongSym].filter(Boolean).sort();
          return JSON.stringify(legsO) === claveSimbolos;
        }).length;

        let pnlTotal = 0, faltaAlgunaPata = false;
        for (const sym of legSymbols) {
          const entradasDelSimbolo = (pnlList || []).filter(p => p.symbol === sym && typeof p.gain_loss === 'number');
          const disponibles = entradasDelSimbolo.slice(otrasConMismosSimbolos);
          if (!disponibles.length) { faltaAlgunaPata = true; continue; }
          pnlTotal += disponibles[0].gain_loss;
        }

        if (!faltaAlgunaPata && legSymbols.length) {
          ex.pnl = +pnlTotal.toFixed(2);
          ex.pnlSource = 'gainloss';
        } else {
          ex.pnl = null;
          ex.pnlSource = 'pendiente_verificar';
        }
        cambios = true;
        console.log(`[TRADIER-TRACK] Ejecución ${ex.orderId} cerrada — P&L: ${ex.pnl ?? 'pendiente de verificar'}`);
      }
    } catch(e) {
      console.error(`[TRADIER-TRACK] Error revisando orden ${ex.orderId}:`, e.message);
    }
  }

  if (cambios) saveTradierExecutions(executions);
}

function scheduleTradierTracking() {
  async function tick() {
    if (isMarketHours()) {
      await checkTradierExecutions();
    }
    setTimeout(tick, TRADIER_TRACK_MS);
  }
  setTimeout(tick, 90 * 1000); // arranca 90s despues del boot
  console.log('[TRADIER-TRACK] Monitor iniciado — chequeo cada 5 min en horario de mercado');
}


// ── Extrínseco — notify endpoint ─────────────────────────────
app.post('/api/notify-extrinsic', async (req, res) => {
  try {
    const { title = '⚠ Extrínseco casi cero', body = '' } = req.body || {};
    const safeTitle = title.replace(/[^-]/g, '').trim() || 'Alerta Bitacora';
    const resp = await fetch('https://ntfy.sh/bitacora_gcarvaja51', {
      method: 'POST',
      headers: { 'Title': safeTitle, 'Priority': 'high', 'Tags': 'warning,chart_decreasing', 'Content-Type': 'text/plain' },
      body
    });
    res.json({ ok: resp.ok, status: resp.status });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Extrínseco — test endpoint ───────────────────────────────
app.get('/api/test-extrinsic', async (req, res) => {
  try {
    await checkExtrinsicAndNotify();
    res.json({ ok: true, msg: 'Chequeo completado - revisa ntfy' });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/extrinsic-report', async (req, res) => {
  try {
    const positions = await tt.getPositions();
    if (!positions || !positions.length) return res.json({ results: [] });

    const optPos      = positions.filter(p => p['instrument-type'] !== 'Equity');
    const underlyings = [...new Set(optPos.map(p => p['underlying-symbol'] || p.symbol))];
    const optSymbols  = optPos.map(p => p.symbol).filter(Boolean);
    const priceMap = {};
    const markMap  = {};
    try {
      const params = underlyings.map(s => `symbols[]=${encodeURIComponent(s)}`).join('&');
      const d = await tt._req(`/market-data?${params}`);
      for (const item of (d?.data?.items || [])) {
        const price = parseFloat(item.last || item.mark || item.mid || 0);
        if (price > 0) priceMap[item.symbol] = price;
      }
    } catch(e) { console.warn('[EXTR-REPORT] Error precios subyacentes:', e.message); }
    try {
      const BATCH = 50;
      for (let i = 0; i < optSymbols.length; i += BATCH) {
        const batch  = optSymbols.slice(i, i + BATCH);
        const params = batch.map(s => `symbols[]=${encodeURIComponent(s)}`).join('&');
        const d      = await tt._req(`/market-data?${params}`);
        for (const item of (d?.data?.items || [])) {
          const price = parseFloat(item.mark || item.mid || item.last || 0);
          if (price > 0) markMap[item.symbol] = price;
        }
      }
    } catch(e) { console.warn('[EXTR-REPORT] Error precios opciones:', e.message); }

    const groups = {};
    for (const p of positions) {
      if (p['instrument-type'] === 'Equity') continue;
      const und = p['underlying-symbol'] || p.symbol;
      const exp = p['expires-at'] ? new Date(p['expires-at']).toISOString().slice(0,10) : '';
      const key = `${und}::${exp}`;
      if (!groups[key]) groups[key] = { underlying: und, exp, legs: [], premiumNet: 0 };
      const g = groups[key];
      g.legs.push(p);
      const qty = parseFloat(p.quantity || 0);
      const op  = parseFloat(p['average-open-price'] || 0);
      const mul = parseFloat(p.multiplier || 100);
      if (p['quantity-direction'] === 'Short') g.premiumNet += op * qty * mul;
      else                                      g.premiumNet -= op * qty * mul;
    }

    // Detectar estrategia por grupo (underlying + exp)
    function detectStrategy(legs) {
      const shorts = legs.filter(l => l['quantity-direction'] === 'Short');
      const longs  = legs.filter(l => l['quantity-direction'] === 'Long');
      const hasShortPut  = shorts.some(l => /P\d{8}$/.test(l.symbol));
      const hasShortCall = shorts.some(l => /C\d{8}$/.test(l.symbol));
      const hasLongPut   = longs.some(l =>  /P\d{8}$/.test(l.symbol));
      const hasLongCall  = longs.some(l =>  /C\d{8}$/.test(l.symbol));
      if (hasShortPut  && hasLongPut  && !hasShortCall) return 'Bull Put Spread';
      if (hasShortCall && hasLongCall && !hasShortPut)  return 'Bear Call Spread';
      if (hasShortPut  && hasLongCall)                  return 'Short Strangle';
      if (hasShortPut  && hasShortCall)                 return 'Short Strangle';
      if (hasShortPut  && !hasLongPut)                  return 'CSP';
      if (hasShortCall && !hasLongCall)                 return 'Covered Call';
      return 'Spread';
    }

    // Agrupar por underlying+exp para detectar estrategia
    const legGroups = {};
    for (const p of positions) {
      if (p['instrument-type'] === 'Equity') continue;
      const und = p['underlying-symbol'] || p.symbol;
      const exp = p['expires-at'] ? new Date(p['expires-at']).toISOString().slice(0,10) : '';
      const key = `${und}::${exp}`;
      if (!legGroups[key]) legGroups[key] = { und, exp, legs: [] };
      legGroups[key].legs.push(p);
    }

    // Revisar cada short leg individualmente
    const results = [];
    for (const p of positions) {
      if (p['instrument-type'] === 'Equity') continue;
      if (p['quantity-direction'] !== 'Short') continue;

      const und    = p['underlying-symbol'] || p.symbol;
      const exp    = p['expires-at'] ? new Date(p['expires-at']).toISOString().slice(0,10) : '';
      const groupKey = `${und}::${exp}`;
      const strategy = legGroups[groupKey] ? detectStrategy(legGroups[groupKey].legs) : '—';

      const uPrice = priceMap[und] || 0;
      const mp     = markMap[p.symbol] || parseFloat(p['mark-price'] || p['close-price'] || 0);

      const sym      = (p.symbol || '').replace(/\s+/g,' ').trim();
      const occMatch = sym.match(/([CP])(\d{8})$/);
      if (!occMatch) continue;

      const isCall    = occMatch[1] === 'C';
      const optType   = isCall ? 'Call' : 'Put';
      const strike    = parseInt(occMatch[2]) / 1000;
      const intrinsic = uPrice > 0 ? (isCall ? Math.max(0, uPrice - strike) : Math.max(0, strike - uPrice)) : null;
      const extrLeg   = intrinsic !== null && mp > 0 ? Math.max(0, mp - intrinsic) : null;
      const qty       = parseFloat(p.quantity || 1);
      const mul       = parseFloat(p.multiplier || 100);
      const premium   = parseFloat(p['average-open-price'] || 0) * qty * mul;
      const extrPct   = extrLeg !== null && premium > 0 ? (extrLeg * qty * mul) / premium * 100 : null;

      results.push({
        label: `Short ${optType} — ${strategy} — ${und}`,
        underlying: und,
        strategy,
        optType,
        strike,
        exp,
        markPrice: mp,
        uPrice: uPrice || null,
        intrinsic: intrinsic !== null ? +intrinsic.toFixed(2) : null,
        extrinsic: extrLeg !== null ? +(extrLeg * qty * mul).toFixed(2) : null,
        premium: +premium.toFixed(2),
        extrPct: extrPct !== null ? +extrPct.toFixed(1) : null,
        alerta: extrPct !== null && extrPct < 5
      });
    }

    results.sort((a, b) => (a.extrPct ?? 999) - (b.extrPct ?? 999));
    res.json({ results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Guardado automático diario de NLV ─────────────────────────
async function snapshotNlv() {
  try {
    const bal = await tt.getBalances();
    const nlv = parseFloat(bal?.['net-liquidating-value'] || 0);
    if (nlv > 0) {
      const date = todayStr();
      saveNlvSnapshot(date, nlv);
      console.log(`[NLV] Snapshot guardado: ${date} = $${nlv.toFixed(2)}`);
    }
  } catch(e) { console.log('[NLV] Error guardando snapshot:', e.message); }
}

function scheduleDaily() {
  // Calcular milisegundos hasta las 4:35 PM ET (20:35 UTC)
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(20, 35, 0, 0);
  if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
  const ms = target - now;
  console.log(`[NLV] Próximo snapshot automático en ${Math.round(ms/60000)} minutos`);
  setTimeout(async () => {
    await snapshotNlv();
    scheduleDaily(); // reprogramar para mañana
  }, ms);
}

app.listen(PORT, async () => {
  console.log(`\n🚀  Bitácora Tasty → http://localhost:${PORT}`);
  scheduleExtrinsicChecks();
  scheduleTradierTracking();
  console.log(`[ENV] Token length: ${(process.env.TT_SESSION_TOKEN || '').length}`);
  try {
    await tt.authenticate();
    const bal = await tt.getBalances();
    const nlv = parseFloat(bal?.['net-liquidating-value'] || 0);
    console.log(`✅  Conectado — Cuenta: ${tt.accountNumber} | Net Liq: $${nlv.toFixed(2)}\n`);
    // Guardar snapshot de hoy al arrancar
    saveNlvSnapshot(todayStr(), nlv);
    // Programar guardado diario a las 4:35 PM ET
    scheduleDaily();
  } catch (e) {
    console.error(`⚠️   Auth falló: ${e.message}\n`);
  }
});

// ── Playbooks ────────────────────────────────────────────────
const PB_FILE = path.join(DATA_DIR, 'playbooks.json');
function loadPlaybooks() {
  try { return JSON.parse(fs.readFileSync(PB_FILE,'utf8')); }
  catch(e) { return { playbooks:[] }; }
}
function savePlaybooks(data) { fs.writeFileSync(PB_FILE, JSON.stringify(data,null,2),'utf8'); }

app.get('/api/playbooks', (req, res) => res.json(loadPlaybooks()));

app.post('/api/playbooks', (req, res) => {
  const data = loadPlaybooks();
  const pb = req.body;
  pb.id = pb.id || `pb-${Date.now()}`;
  const idx = data.playbooks.findIndex(p=>p.id===pb.id);
  if (idx>=0) data.playbooks[idx]=pb; else data.playbooks.push(pb);
  savePlaybooks(data);
  res.json(pb);
});

app.delete('/api/playbooks/:id', (req, res) => {
  const data = loadPlaybooks();
  data.playbooks = data.playbooks.filter(p=>p.id!==req.params.id);
  savePlaybooks(data);
  res.json({ok:true});
});
app.post('/api/ai-chat', async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'ANTHROPIC_API_KEY no configurada' });

    const { question, history = [], startDate = '2026-02-01', endDate = todayStr() } = req.body;

    // Obtener métricas del período + posiciones abiertas
    const [items, positions] = await Promise.all([
      tt.getAllTransactions(startDate, endDate),
      tt.getPositions(),
    ]);
    const { buildMetrics } = require('./src/metrics');
    const m = buildMetrics(items);
    const bal = await tt.getBalances();
    const nlv = parseFloat(bal?.['net-liquidating-value'] || 0);
    const nlvHistory = loadNlvHistory();
    const nlvByMonth = computeMonthlyNlv(nlvHistory, nlv);

    // Calcular P&L no realizado por posición
    const openPositions = positions
      .filter(p => p['instrument-type'] === 'Equity Option' || p['instrument-type'] === 'Equity')
      .map(p => {
        const op  = parseFloat(p['average-open-price'] || 0);
        const cp  = parseFloat(p['mark-price'] || p['average-daily-market-close-price'] || p['close-price'] || 0);
        const qty = parseFloat(p.quantity || 0);
        const mul = parseFloat(p.multiplier || 1);
        const dir = p['quantity-direction'] === 'Short' ? -1 : 1;
        const pnl = dir * (cp - op) * qty * mul;
        return {
          sym:    p['underlying-symbol'],
          tipo:   (p.symbol||'').match(/P\d{8}$/) ? 'Put' : (p.symbol||'').match(/C\d{8}$/) ? 'Call' : 'Stock',
          dir:    p['quantity-direction'],
          strike: p['strike-price'],
          expiry: (p['expires-at']||'').slice(0,10),
          qty,
          openPrice: op,
          currentPrice: cp,
          pnlNoReal: +pnl.toFixed(2),
        };
      });

    const context = `Eres un coach experto en trading de opciones. Tienes acceso a los datos reales del trader para el período ${startDate} al ${endDate}.

DATOS DEL PERÍODO:
- Net Liq actual: $${nlv.toFixed(2)}
- Capital inicial: $10,644
- Retorno total: ${(((nlv-10644)/10644)*100).toFixed(2)}%
- Total trades: ${m.totalStrategies}
- Win Rate: ${m.winRate}%
- Profit Factor: ${m.profitFactor}x
- P&L Realizado: $${m.totalPnL}
- Comisiones pagadas: $${m.totalComm}

P&L MENSUAL (Net Liq):
${Object.entries(nlvByMonth).sort().map(([mo,v])=>`- ${mo}: $${v.toFixed(2)}`).join('\n')}

POSICIONES ABIERTAS AHORA:
${openPositions.map(p=>`- ${p.sym} ${p.tipo} ${p.dir} Strike:${p.strike} Exp:${p.expiry} Qty:${p.qty} P&L No Real: $${p.pnlNoReal}`).join('\n')}

POR ESTRATEGIA:
${Object.entries(m.byStrategy||{}).slice(0,6).map(([t,d])=>`- ${t}: ${d.trades} trades, Win ${d.winRate}%, P&L $${d.pnl.toFixed(2)}`).join('\n')}

POR SUBYACENTE:
${Object.entries(m.byUnderlying||{}).sort((a,b)=>Math.abs(b[1].pnl)-Math.abs(a[1].pnl)).slice(0,6).map(([s,d])=>`- ${s}: ${d.trades} trades, P&L $${d.pnl.toFixed(2)}`).join('\n')}

HORARIO:
${Object.entries(m.byTimeSlot||{}).map(([sl,d])=>`- ${sl}: ${d.trades} trades, Win ${d.trades?((d.wins/d.trades)*100).toFixed(1):0}%, P&L $${d.pnl.toFixed(2)}`).join('\n')}

DURACIÓN:
${Object.entries(m.byDuration||{}).map(([dur,d])=>`- ${dur}: ${d.trades} trades, Win ${d.trades?((d.wins/d.trades)*100).toFixed(1):0}%, P&L $${d.pnl.toFixed(2)}`).join('\n')}

TRADES INDIVIDUALES CERRADOS (todos en el período, ordenados por fecha de cierre):
${(m.strategies||[]).sort((a,b)=>a.closeDate?.localeCompare(b.closeDate)).map(s=>`- ${s.closeDate} | ${s.underlying} | ${s.stratType} | ${s.durationCat} | Prima cobrada: $${Math.abs(s.openValue||0).toFixed(2)} | P&L: $${(s.pnl||0).toFixed(2)} | ${s.win?'WIN':'LOSS'}`).join('\n')}

Responde en español, de forma concisa y directa. Usa bullet points cuando sea útil. Sé específico con números de los datos reales. Máximo 500 palabras.`;

    const messages = [
      ...history.slice(-8).map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: question }
    ];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        system: context,
        messages,
      }),
    });

    if (!response.ok) throw new Error(`API error: ${response.status}`);
    const data = await response.json();
    const reply = data.content?.[0]?.text || 'Sin respuesta';
    res.json({ reply });

  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/ai-analysis', async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'ANTHROPIC_API_KEY no configurada' });

    // Obtener datos frescos
    const [txData, overview, curveData] = await Promise.all([
      cached('transactions', 120, async () => {
        const { buildMetrics } = require('./src/metrics');
        const items = await tt.getAllTransactions('2026-02-01', todayStr());
        return { items, metrics: buildMetrics(items) };
      }),
      cached('overview', 60, async () => {
        const [balances, positions] = await Promise.all([tt.getBalances(), tt.getPositions()]);
        return { balances, positions };
      }),
      cached('curve', 300, async () => {
        const nlvHistory = loadNlvHistory();
        const bal = await tt.getBalances();
        const currentNlv = parseFloat(bal?.['net-liquidating-value'] || 0);
        return { nlvByMonth: computeMonthlyNlv(nlvHistory, currentNlv) };
      }),
    ]);

    const m   = txData.metrics;
    const nlv = parseFloat(overview.balances?.['net-liquidating-value'] || 0);
    const nlvByMonth = curveData.nlvByMonth || {};

    // Construir resumen para Claude
    const summary = {
      cuenta: { netLiq: nlv, capitalInicial: 10644, retornoTotal: +((nlv - 10644) / 10644 * 100).toFixed(2) },
      rendimiento: { winRate: m.winRate, profitFactor: m.profitFactor, totalTrades: m.totalStrategies, totalPnL: m.totalPnL, comisiones: m.totalComm },
      mensual: Object.entries(nlvByMonth).sort().map(([mo, pnl]) => ({ mes: mo, pnl: +pnl.toFixed(2) })),
      porEstrategia: Object.entries(m.byStrategy || {}).sort((a,b) => b[1].trades - a[1].trades).slice(0, 8).map(([tipo, d]) => ({ tipo, trades: d.trades, winRate: d.winRate, pnl: +d.pnl.toFixed(2), promGan: d.avgWin, promPer: d.avgLoss })),
      porSubyacente: Object.entries(m.byUnderlying || {}).sort((a,b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl)).slice(0, 8).map(([sym, d]) => ({ sym, trades: d.trades, pnl: +d.pnl.toFixed(2) })),
      horario: Object.entries(m.byTimeSlot || {}).map(([slot, d]) => ({ slot, trades: d.trades, winRate: d.trades ? +((d.wins/d.trades)*100).toFixed(1) : 0, pnl: +d.pnl.toFixed(2) })),
      duracion: Object.entries(m.byDuration || {}).map(([dur, d]) => ({ dur, trades: d.trades, winRate: d.trades ? +((d.wins/d.trades)*100).toFixed(1) : 0, pnl: +d.pnl.toFixed(2) })),
      posicionesAbiertas: overview.positions.filter(p => p['instrument-type'] === 'Equity Option').map(p => ({ sym: p['underlying-symbol'], tipo: (p.symbol||'').match(/P\d{8}$/) ? 'Put' : 'Call', dir: p['quantity-direction'], strike: p['strike-price'], expiry: (p['expires-at']||'').slice(0,10), qty: p.quantity })),
    };

    const prompt = `Eres un coach experto en trading de opciones. Analiza estos datos reales de un trader y da recomendaciones específicas y accionables en español.

DATOS DEL TRADER:
${JSON.stringify(summary, null, 2)}

Responde SOLO en JSON con esta estructura exacta (sin markdown, sin texto extra):
{
  "diagnostico": "2-3 frases resumiendo la situación actual del trader",
  "patrones": [
    {"titulo": "...", "detalle": "...", "impacto": "positivo|negativo|neutral"},
    {"titulo": "...", "detalle": "...", "impacto": "positivo|negativo|neutral"},
    {"titulo": "...", "detalle": "...", "impacto": "positivo|negativo|neutral"}
  ],
  "recomendaciones": [
    {"prioridad": "alta|media|baja", "titulo": "...", "accion": "...", "razon": "..."},
    {"prioridad": "alta|media|baja", "titulo": "...", "accion": "...", "razon": "..."},
    {"prioridad": "alta|media|baja", "titulo": "...", "accion": "...", "razon": "..."},
    {"prioridad": "alta|media|baja", "titulo": "...", "accion": "...", "razon": "..."}
  ],
  "riesgos": [
    {"titulo": "...", "detalle": "..."},
    {"titulo": "...", "detalle": "..."}
  ],
  "metaProximos30dias": "Una meta específica y medible para los próximos 30 días"
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: `Claude API error: ${err.slice(0, 200)}` });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const analysis = JSON.parse(clean);
    res.json({ analysis, generatedAt: new Date().toISOString() });

  } catch(e) { res.status(500).json({ error: e.message }); }
});
