'use strict';
require('dotenv').config();
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { TastytradeClient }                              = require('./src/tastytrade');
const { buildMetrics, buildEquityCurve, buildCalendar } = require('./src/metrics');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── NLV History ────────────────────────────────────────────────
// Snapshots históricos obtenidos de TastyTrade (fin de mes)
const NLV_FILE = path.join(__dirname, 'nlv_history.json');
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
  username:      process.env.TT_USERNAME,
  password:      process.env.TT_PASSWORD,
  rememberToken: process.env.TT_REMEMBER_TOKEN,
  sessionToken:  process.env.TT_SESSION_TOKEN,
  accountNumber: process.env.TT_ACCOUNT_NUMBER,
});
if (process.env.TT_SESSION_TOKEN) tt.sessionToken = process.env.TT_SESSION_TOKEN;

const _cache = new Map();
function cached(k, s, fn) {
  const h = _cache.get(k);
  if (h && Date.now() < h.exp) return Promise.resolve(h.v);
  return fn().then(v => { _cache.set(k, { v, exp: Date.now() + s * 1000 }); return v; });
}
function bustCache() { _cache.clear(); }

const todayStr = () => new Date().toISOString().slice(0, 10);
const daysAgo  = n  => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Balance + posiciones + Greeks
app.get('/api/overview', async (req, res) => {
  try {
    const data = await cached('overview', 60, async () => {
      const [balances, positions] = await Promise.all([tt.getBalances(), tt.getPositions()]);
      // Obtener Greeks para posiciones de opciones
      const optionSymbols = positions
        .filter(p => p['instrument-type'] === 'Equity Option')
        .map(p => p.symbol);
      const greeks = await tt.getGreeks(optionSymbols);
      // Adjuntar Greeks a cada posición
      const posWithGreeks = positions.map(p => ({
        ...p,
        greeks: greeks[p.symbol] || null,
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

      let peak = initial, maxDD = 0, maxDDPct = 0;
      values.forEach(v => {
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

      return {
        curve: { labels, values, initial, maxDD: +maxDD.toFixed(2), maxDDPct: +maxDDPct.toFixed(2) },
        calendar, byMonth, byWeek,
        nlvByMonth,
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
      // Para métricas usar solo Trade; para display mostrar todo
      const tradeItems = allItems.filter(tx => tx['transaction-type'] === 'Trade');
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
const WHEEL_CFG = path.join(__dirname, 'wheel_config.json');

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
  const { action, underlying } = req.body;
  const cfg = loadWheelConfig();
  const sym = (underlying||'').toUpperCase().trim();
  if (!sym) return res.status(400).json({ error: 'Ticker requerido' });
  if (action === 'add' && !cfg.underlyings.includes(sym)) cfg.underlyings.push(sym);
  if (action === 'remove') cfg.underlyings = cfg.underlyings.filter(u => u !== sym);
  saveWheelConfig(cfg);
  bustCache();
  res.json(cfg);
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
      return { wheels: buildWheelData(items, positions, cfg.underlyings), underlyings: cfg.underlyings, ts: new Date().toISOString() };
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

app.get('/api/health', (req, res) => res.json({
  ok: true, auth: !!tt.sessionToken,
  tokenLen: (tt.sessionToken || '').length,
  account: tt.accountNumber,
  ts: new Date().toISOString()
}));

// ── Watchlist ─────────────────────────────────────────────────
const WL_FILE = path.join(__dirname, 'watchlist.json');
function loadWatchlist() {
  try { return JSON.parse(fs.readFileSync(WL_FILE,'utf8')); }
  catch(e) { return { stocks:[] }; }
}
function saveWatchlist(d) { fs.writeFileSync(WL_FILE, JSON.stringify(d,null,2),'utf8'); }

app.get('/api/watchlist', (req, res) => res.json(loadWatchlist()));

app.post('/api/watchlist', (req, res) => {
  const wl = loadWatchlist();
  const { symbol, name, status } = req.body;
  const sym = symbol.toUpperCase();
  if (wl.stocks.find(s => s.symbol === sym)) return res.status(409).json({ error:'Ya existe' });
  const stock = { symbol:sym, name:name||sym, status:status||'orange', addedDate:todayStr(), notes:[] };
  wl.stocks.push(stock);
  saveWatchlist(wl);
  res.json(stock);
});

app.put('/api/watchlist/:symbol', (req, res) => {
  const wl = loadWatchlist();
  const s  = wl.stocks.find(s => s.symbol === req.params.symbol.toUpperCase());
  if (!s) return res.status(404).json({ error:'No encontrado' });
  if (req.body.status) s.status = req.body.status;
  if (req.body.name)   s.name   = req.body.name;
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
      fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${yhSym}?modules=summaryDetail,defaultKeyStatistics,calendarEvents`, { headers:{'User-Agent':'Mozilla/5.0'} }),
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

    // RSI 14d del símbolo
    const prR = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${yhSym}?interval=1d&range=45d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const prJ = await prR.json();
    const closes = prJ.chart.result[0].indicators.quote[0].close.filter(v => v != null);
    const rsi    = calcRSI(closes);
    const price  = Math.round(closes.at(-1) * 100) / 100;

    // Earnings — solo acciones individuales
    let earningsDays = 999;
    if (!isIndex) {
      try {
        const eR = await fetch(
          `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${yhSym}?modules=calendarEvents`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const eJ  = await eR.json();
        const eTs = eJ.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate?.[0]?.raw;
        if (eTs) earningsDays = Math.round((eTs * 1000 - Date.now()) / 86400000);
      } catch(e) {}
    }

    res.json({ symbol, price, vix, ivRank, rsi, earningsDays });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Playbooks ────────────────────────────────────────────────
const PB_FILE2 = path.join(__dirname, 'playbooks.json');
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
const PB_FILE = path.join(__dirname, 'playbooks.json');
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
        const cp  = parseFloat(p['close-price'] || 0);
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

Responde en español, de forma concisa y directa. Usa bullet points cuando sea útil. Sé específico con números de los datos reales. Máximo 300 palabras.`;

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
        model: 'claude-sonnet-4-20250514',
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
        model: 'claude-sonnet-4-20250514',
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
