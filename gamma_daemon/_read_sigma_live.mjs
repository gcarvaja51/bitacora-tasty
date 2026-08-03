// Lectura EN VIVO de Sigma Terminal reutilizando el navegador que el daemon ya
// tiene abierto (su CDP escucha en un puerto aleatorio, se descubre por el PID
// que usa sigma_profile). Evita lanzar un Puppeteer propio, que falla porque el
// perfil esta bloqueado mientras el daemon corre.
import CDP from 'chrome-remote-interface';

const port = Number(process.argv[2]);
if (!port) { console.error('Uso: node _read_sigma_live.mjs <puerto_cdp>'); process.exit(1); }

const resp = await fetch(`http://localhost:${port}/json/list`);
const pages = (await resp.json()).filter(
  (t) => t.type === 'page' && /web\.sigma\.trade/i.test(t.url || '')
);
if (pages.length === 0) { console.error('No hay pagina de Sigma Terminal abierta'); process.exit(1); }

const client = await CDP({ port, target: pages[0].id });
await client.Runtime.enable();

async function ev(expression) {
  const r = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}

// Simbolo — mismo selector que sigma.js
const symbol = await ev(`
  (function(){
    var el = document.querySelector('[class*="greeks_sym__"]');
    return el ? el.textContent.trim() : null;
  })()
`);
console.log('Simbolo en Sigma Terminal:', symbol);

// Forzar "MVS Abs" (mismo criterio que sigma.js: el toggle controla la tarjeta MVS)
const mvsState = await ev(`
  (function(){
    var btns = Array.from(document.querySelectorAll('button'));
    var btn = btns.find(function(b){ return b.textContent.trim() === 'MVS Abs'; });
    if (!btn) return 'boton MVS Abs no encontrado';
    var pressed = btn.getAttribute('aria-pressed') === 'true' ||
                  /active|selected/i.test(btn.className || '');
    if (!pressed) { btn.click(); return 'clickeado (estaba en Neto)'; }
    return 'ya estaba en Abs';
  })()
`);
console.log('MVS Abs:', mvsState);
await new Promise((r) => setTimeout(r, 800));

// Metricas crudas — mismo selector que sigma.js
const raw = await ev(`
  (function(){
    var cards = document.querySelectorAll('[class*="greeks_metricCard__"]');
    var out = {};
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var labelEl = card.querySelector('[class*="greeks_metricLabel__"]');
      var valueEl = card.querySelector('[class*="greeks_metricValue__"]');
      if (!labelEl || !valueEl) continue;
      var textNode = Array.from(labelEl.childNodes).find(function(n){ return n.nodeType === 3; });
      var label = (textNode ? textNode.textContent : labelEl.textContent).trim();
      out[label] = valueEl.textContent.trim();
    }
    return JSON.stringify(out);
  })()
`);
console.log('\nMetricas EN VIVO:');
console.log(raw);

await client.close();
