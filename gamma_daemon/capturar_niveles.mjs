// Captura de niveles por SIMBOLO y VENCIMIENTO — el registro que pidio el usuario
// el 2026-08-22: el max pain del dia y el del viernes siguiente, no solo del SPX
// sino de los activos abiertos, para buscar una regla del movimiento esperado.
//
//   node gamma_daemon/capturar_niveles.mjs              # SPX, dia + viernes
//   node gamma_daemon/capturar_niveles.mjs --todos      # + los activos abiertos
//   node gamma_daemon/capturar_niveles.mjs --simbolos NU,BA
//
// ⚠️ LA REGLA QUE MANDA SOBRE TODO LO DEMAS: al terminar, Sigma Terminal TIENE
// que quedar en SPX y en el vencimiento del dia.
//
// El daemon exige SPX y falla en cada ciclo si encuentra otra cosa ("Sigma
// Terminal no esta en SPX"). Dejarlo mal significa lunes sin muros en
// TradingView y sin niveles para las tres estrategias. Por eso la restauracion
// va en un `finally`, se VERIFICA leyendo, y si no se logra el script grita y
// sale con codigo distinto de cero.
import { ensurePage, readLevels, readExpiryChips, seleccionarExpiry,
         seleccionarSimbolo, readSymbol, close } from './sigma.js';

const PROD = process.env.PROD_BASE || 'https://web-production-23473.up.railway.app';
const args = process.argv.slice(2);
const TODOS = args.includes('--todos');
const iSim = args.indexOf('--simbolos');
const SIMBOLOS_ARG = iSim >= 0 ? (args[iSim + 1] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : [];

let fallos = 0;

async function underlyingsAbiertos() {
  try {
    const r = await fetch(`${PROD}/api/overview`);
    const d = await r.json();
    const u = new Set();
    for (const p of d.positions || []) {
      const s = p['underlying-symbol'] || p.underlyingSymbol || p.symbol;
      if (s) u.add(String(s).toUpperCase());
    }
    return [...u];
  } catch (e) {
    console.error('[captura] no se pudieron leer las posiciones abiertas:', e.message);
    return [];
  }
}

// El viernes siguiente entre los chips disponibles. Si hoy ES viernes, se toma
// el de la semana que viene: el del dia ya lo cubre la lectura normal.
function chipDelViernes(chips, hoy = new Date()) {
  const candidatos = chips
    .map(c => {
      const d = new Date(hoy);
      d.setDate(d.getDate() + c.dte);
      return { ...c, fecha: d, esViernes: d.getDay() === 5 };
    })
    .filter(c => c.esViernes && c.dte > 0)
    .sort((a, b) => a.dte - b.dte);
  return candidatos[0] || null;
}

async function guardar(symbol, levels, dte) {
  const r = await fetch(`${PROD}/api/spx/niveles-historicos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol, expiry: levels.expiry, dte, levels,
                           capturadoEn: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`POST devolvio ${r.status}`);
  console.log(`   guardado  ${symbol.padEnd(6)} exp=${levels.expiry}  maxPain=${levels.maxPain}  MVS=${levels.mvs}  cw=${levels.callWall}  pw=${levels.putWall}`);
}

async function capturarSimbolo(p, symbol) {
  console.log(`\n[${symbol}]`);
  if (symbol !== 'SPX') {
    await seleccionarSimbolo(p, symbol);
  }
  const chips = await readExpiryChips(p);
  const activo = chips.find(c => c.activo);

  // 1. El vencimiento del dia (el que ya esta activo).
  const hoy = await readLevels({ exigirSPX: false });
  await guardar(symbol, hoy, activo?.dte ?? null);

  // 2. El viernes siguiente.
  const vie = chipDelViernes(chips);
  if (!vie) {
    console.log('   (sin chip de viernes disponible)');
  } else if (activo && vie.etiqueta === activo.etiqueta) {
    console.log('   (el vencimiento del dia YA es el viernes: no se duplica)');
  } else {
    await seleccionarExpiry(p, vie.etiqueta);
    const lv = await readLevels({ exigirSPX: false });
    await guardar(symbol, lv, vie.dte);
    if (activo) await seleccionarExpiry(p, activo.etiqueta);   // volver al del dia
  }
}

const p = await ensurePage();
try {
  const lista = SIMBOLOS_ARG.length ? SIMBOLOS_ARG
              : TODOS ? ['SPX', ...(await underlyingsAbiertos()).filter(s => s !== 'SPX')]
              : ['SPX'];
  console.log('a capturar:', lista.join(', '));
  for (const s of lista) {
    try { await capturarSimbolo(p, s); }
    catch (e) { fallos++; console.error(`   FALLO ${s}: ${e.message}`); }
  }
} finally {
  // ── RESTAURACION, pase lo que pase ──────────────────────────────────────
  let restaurado = false;
  for (let i = 1; i <= 3 && !restaurado; i++) {
    try {
      const sim = await readSymbol(p);
      if (!/^SPX$/i.test(sim || '')) await seleccionarSimbolo(p, 'SPX');
      const chips = await readExpiryChips(p);
      const primero = chips[0];                       // el mas cercano = el del dia
      if (primero && !primero.activo) await seleccionarExpiry(p, primero.etiqueta);
      const final = await readSymbol(p);
      restaurado = /^SPX$/i.test(final || '');
    } catch (e) {
      console.error(`[captura] intento ${i} de restaurar fallo: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (restaurado) {
    console.log('\n[captura] Sigma restaurado a SPX + vencimiento del dia');
  } else {
    console.error('\n[captura] *** NO SE PUDO RESTAURAR SIGMA A SPX ***');
    console.error('[captura] El daemon fallara en cada ciclo hasta que se arregle a mano.');
    fallos += 100;
  }
  await close();
}

process.exit(fallos ? 1 : 0);
