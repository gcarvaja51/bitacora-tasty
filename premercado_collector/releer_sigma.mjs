// Segunda oportunidad para Sigma, justo antes de escribir el informe (2026-09-23).
//
// POR QUE. El colector lee Sigma a las 08:30 (esperando hasta 6 min), pero el skill
// escribe el informe 5-10 min despues. Si el colector se fue con el dato RANCIO y el
// daemon se recupero entretanto --el 23-sep el vigilante lo relanzo a las 08:36 ET--
// el dato de hoy ya esta en status.json y el informe no lo usaba. Esto lo vuelve a
// leer y, si ahora es de hoy, reemplaza `sigma` en el bundle.json del dia.
//
// Solo toca bundle.json (con copia .bak antes). No abre Chrome ni toca Sigma
// Terminal: lee el status.json que el gamma_daemon ya escribe cada 30s.
//
//     node releer_sigma.mjs            -> espera hasta 3 min a que haya dato de hoy
//     node releer_sigma.mjs --sin-espera
//
// Salida: exit 0 si el bundle queda con Sigma de hoy, exit 2 si sigue rancio.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { esperarSigmaDeHoy, diagnosticoDaemon } from './elegir_sigma.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAMMA_STATUS_PATH = path.join(__dirname, '..', 'gamma_daemon', 'status.json');
// PREMERCADO_DATA_DIR solo para probarlo contra una copia sin tocar el bundle real.
const OUT_ROOT = process.env.PREMERCADO_DATA_DIR || 'C:\\Users\\gcarv\\Documents\\CARPETA PERSONAL\\01. guillermo carvajal\\01_Sigma\\mentoria alejandro\\premercados alejandro\\control premercado\\data_collector';
const MAX_ANTIGUEDAD_MIN = Number(process.env.SIGMA_MAX_ANTIGUEDAD_MIN || 45);
const SIN_ESPERA = process.argv.includes('--sin-espera');

function stampET() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.month}${p.day}${p.year}`;
}

const r = await esperarSigmaDeHoy({
  leerStatus: () => JSON.parse(readFileSync(GAMMA_STATUS_PATH, 'utf8')),
  ahora: () => Date.now(),
  dormir: (ms) => new Promise((res) => setTimeout(res, ms)),
  maxAntiguedadMin: MAX_ANTIGUEDAD_MIN,
  esperaMs: SIN_ESPERA ? 0 : 3 * 60 * 1000,
  pasoMs: 20000,
});

const resumen = `Call Wall ${r.levels.callWall}, Put Wall ${r.levels.putWall}, Gamma Flip ${r.levels.gammaFlip},`
  + ` MVS ${r.levels.mvs}, vto ${r.levels.expiry}`;

if (r.rancio) {
  console.log(`[sigma] SIGUE RANCIO: ${r.antiguedadMin ?? '?'} min (fuente ${r.fuente}, sello ${r.asOf}) -- ${resumen}`);
  console.log(`[sigma] causa: ${diagnosticoDaemon(r.status, Date.now())}`);
  process.exit(2);
}

const bundlePath = path.join(OUT_ROOT, stampET(), 'bundle.json');
if (existsSync(bundlePath)) {
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  if (bundle.sigma?.rancio === false && bundle.sigma?.asOf === r.asOf) {
    console.log(`[sigma] el bundle ya tenia este dato de hoy -- ${resumen}`);
    process.exit(0);
  }
  copyFileSync(bundlePath, `${bundlePath}.bak_antes_releer`);
  bundle.sigma = {
    ...r.levels, asOf: r.asOf, fuente: r.fuente, antiguedadMin: r.antiguedadMin, rancio: false,
    releidoEn: new Date().toISOString(),
  };
  bundle.errors = (bundle.errors || []).filter((e) => !e.startsWith('sigma:'));
  writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
  console.log(`[sigma] OK -- bundle.json actualizado con el dato de hoy (${r.antiguedadMin} min) -- ${resumen}`);
} else {
  console.log(`[sigma] OK (no hay bundle de hoy que actualizar) -- ${resumen}`);
}
process.exit(0);
