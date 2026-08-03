// Ciclo manual completo: lee Sigma Terminal EN VIVO (reusando el navegador que
// el daemon ya tiene abierto, via su CDP en puerto aleatorio) y empuja los
// niveles a TradingView (CDP 9223) + al servidor (POST /api/spx/sigma-levels).
// Existe porque push_gdv_now.js lanza su propio Puppeteer y falla mientras el
// daemon tiene el perfil sigma_profile bloqueado.
import CDP from 'chrome-remote-interface';
import { execSync } from 'child_process';

const TV_PORT = 9223;

// ── Descubrir el puerto CDP del navegador del daemon (Puppeteer lo abre en un
// puerto aleatorio; se ubica por el PID que usa sigma_profile).
function findSigmaCdpPort() {
  // Una sola linea con ';' -- un script multilinea pasado por -Command se
  // colapsa a una linea y rompe el pipeline entre statements.
  const ps = `$tree = Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Where-Object { $_.CommandLine -like '*sigma_profile*' } | Select-Object -ExpandProperty ProcessId; Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $tree -contains $_.OwningProcess } | Select-Object -First 1 -ExpandProperty LocalPort`;
  const out = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8' });
  const port = parseInt(out.trim(), 10);
  if (!port) throw new Error('No se encontro el puerto CDP del navegador del daemon');
  return port;
}

function parseMoney(str) {
  if (str == null) return null;
  const s = String(str).replace(/,/g, '').trim();
  const m = s.match(/(-)?\$?(-)?([\d.]+)\s*(B|M|K)?/i);
  if (!m) return null;
  const neg = !!(m[1] || m[2]);
  let num = parseFloat(m[3]);
  if (Number.isNaN(num)) return null;
  const suffix = (m[4] || '').toUpperCase();
  if (suffix === 'B') num *= 1e9;
  else if (suffix === 'M') num *= 1e6;
  else if (suffix === 'K') num *= 1e3;
  return neg ? -num : num;
}

const LABEL_MAP = {
  'Spot SPX': 'spxPrice', 'Net GEX': 'netGex', 'Net DEX': 'netDex',
  'Net Vanna': 'netVanna', 'Gamma Flip': 'gammaFlip', 'Put Wall': 'putWall',
  'Call Wall': 'callWall', 'MVS': 'mvs',
};

async function evalOn(client, expression) {
  const r = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}

// ── 1. Leer Sigma Terminal en vivo ──────────────────────────────────
const sigmaPort = findSigmaCdpPort();
console.log('Puerto CDP del navegador del daemon:', sigmaPort);

const respS = await fetch(`http://localhost:${sigmaPort}/json/list`);
const sigmaPages = (await respS.json()).filter((t) => t.type === 'page' && /web\.sigma\.trade/i.test(t.url || ''));
if (sigmaPages.length === 0) throw new Error('No hay pagina de Sigma Terminal abierta');

const sClient = await CDP({ port: sigmaPort, target: sigmaPages[0].id });
await sClient.Runtime.enable();

const symbol = await evalOn(sClient, `
  (function(){ var el = document.querySelector('[class*="greeks_sym__"]'); return el ? el.textContent.trim() : null; })()
`);
if (!symbol || !/^SPX$/i.test(symbol)) throw new Error(`Sigma Terminal no esta en SPX (simbolo: "${symbol}")`);

await evalOn(sClient, `
  (function(){
    var btn = Array.from(document.querySelectorAll('button')).find(function(b){ return b.textContent.trim() === 'MVS Abs'; });
    if (!btn) return false;
    var pressed = btn.getAttribute('aria-pressed') === 'true' || /active|selected/i.test(btn.className || '');
    if (!pressed) btn.click();
    return true;
  })()
`);
await new Promise((r) => setTimeout(r, 800));

const rawJson = await evalOn(sClient, `
  (function(){
    var cards = document.querySelectorAll('[class*="greeks_metricCard__"]');
    var out = {};
    for (var i = 0; i < cards.length; i++) {
      var labelEl = cards[i].querySelector('[class*="greeks_metricLabel__"]');
      var valueEl = cards[i].querySelector('[class*="greeks_metricValue__"]');
      if (!labelEl || !valueEl) continue;
      var textNode = Array.from(labelEl.childNodes).find(function(n){ return n.nodeType === 3; });
      var label = (textNode ? textNode.textContent : labelEl.textContent).trim();
      out[label] = valueEl.textContent.trim();
    }
    return JSON.stringify(out);
  })()
`);
await sClient.close();

const raw = JSON.parse(rawJson);
const missing = Object.keys(LABEL_MAP).filter((k) => !(k in raw));
if (missing.length > 0) throw new Error(`Faltan metricas: ${missing.join(', ')}`);

const levels = {};
for (const [label, key] of Object.entries(LABEL_MAP)) levels[key] = parseMoney(raw[label]);
levels.regime = levels.netGex > 0 ? 'POSITIVO' : 'NEGATIVO';
console.log('\nNiveles EN VIVO:', JSON.stringify(levels, null, 2));

// ── 2. Empujar a TradingView ────────────────────────────────────────
const inputs = {
  in_20: true,
  in_21: levels.callWall, in_22: levels.putWall, in_23: levels.gammaFlip, in_24: levels.mvs,
  in_25: levels.netGex,  in_26: levels.netGex,
  in_27: levels.netDex,  in_28: levels.netDex,
  in_29: levels.netVanna, in_30: levels.netVanna,
};

const respT = await fetch(`http://localhost:${TV_PORT}/json/list`);
const tvTargets = (await respT.json()).filter((t) => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));

for (const t of tvTargets) {
  let client;
  try {
    client = await CDP({ port: TV_PORT, target: t.id });
    await client.Runtime.enable();
    const panes = await evalOn(client, `
      window.TradingViewApi._chartWidgetCollection.getAll().map(function(c, i) {
        try { return { index: i, symbol: c.model().mainSeries().symbol() }; } catch(e) { return { index: i, error: e.message }; }
      })
    `);
    if (!panes.some((p) => p.symbol && /^SPCFD:SPX$/i.test(p.symbol))) {
      console.log(`${t.id.slice(0,8)}: sin SPCFD:SPX (${panes.map(p=>p.symbol).join(', ')}) — se salta`);
      await client.close(); continue;
    }
    for (const p of panes) {
      if (p.error) continue;
      await evalOn(client, `
        (function(){ var w = window.TradingViewApi._chartWidgetCollection.getAll()[${p.index}]; if (w && w._mainDiv) w._mainDiv.click(); return true; })()
      `);
      await new Promise((r) => setTimeout(r, 300));
      const entityId = await evalOn(client, `
        (function(){
          try {
            var chart = window.TradingViewApi._activeChartWidgetWV.value();
            var studies = chart.getAllStudies();
            for (var i = 0; i < studies.length; i++) {
              var name = studies[i].name || studies[i].title || '';
              if (/CIARG_V\\d/i.test(name)) return studies[i].id;
            }
            return null;
          } catch (e) { return null; }
        })()
      `);
      if (!entityId) { console.log(`${t.id.slice(0,8)} pane ${p.index}: CIARG no encontrado`); continue; }
      const result = await evalOn(client, `
        (function(){
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          var study = chart.getStudyById(${JSON.stringify(entityId)});
          var currentInputs = study.getInputValues();
          var overrides = ${JSON.stringify(inputs)};
          var updated = {};
          for (var i = 0; i < currentInputs.length; i++) {
            if (overrides.hasOwnProperty(currentInputs[i].id)) {
              currentInputs[i].value = overrides[currentInputs[i].id];
              updated[currentInputs[i].id] = overrides[currentInputs[i].id];
            }
          }
          study.setInputValues(currentInputs);
          return JSON.stringify(updated);
        })()
      `);
      console.log(`${t.id.slice(0,8)} pane ${p.index} (${p.symbol}): ✅ TradingView actualizado`);
    }
    await client.close();
  } catch (e) {
    console.error(`${t.id.slice(0,8)}: ERROR`, e.message);
    if (client) { try { await client.close(); } catch {} }
  }
}

// ── 3. Empujar al servidor ──────────────────────────────────────────
try {
  const r = await fetch('https://web-production-23473.up.railway.app/api/spx/sigma-levels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(levels),
  });
  console.log('\nServidor (/api/spx/sigma-levels):', r.ok ? '✅ actualizado' : `❌ HTTP ${r.status}`);
} catch (e) {
  console.error('\nServidor: ERROR', e.message);
}
