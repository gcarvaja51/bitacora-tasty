// node gamma_daemon/flujo.test.mjs
// Flujo Sigma (2026-11-12): parseo de los textos de Sigma, serie del dia, marcas y
// recuperacion tras reinicio. Los textos son copias de lo que se vio en vivo.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { aMillones, parseFlujo, parseMeter, baseMinuto, fechaET, crearFlujo, calcularMarcas, armarSerie } from './flujo.js';

let ok = 0;
async function caso(nombre, fn) { await fn(); ok++; console.log('  ok -', nombre); }

await caso('montos: M, B, K, negativos y sin datos', () => {
  assert.equal(aMillones('$841.55 M'), 841.55);
  assert.equal(aMillones('$1.12 B'), 1120);
  assert.equal(aMillones('$950 K'), 0.95);
  assert.equal(aMillones('-$8.00 M'), -8);
  assert.equal(aMillones('−$3.5 M'), -3.5);
  assert.equal(aMillones('+$227.87 M'), 227.87);
  assert.equal(aMillones('$0'), 0);
  assert.equal(aMillones(null), null);
  assert.equal(aMillones('sin dato'), null);
});

await caso('Flow Dashboard del 12-nov 9:42 ET', () => {
  const t = 'Net Flow\n● Calls $302.50 M ● Puts $253.55 M ● SPX $7,565.07\nmandan los alcistas · +$48.95 M\n'
          + 'MOMENTUM ▲ +$12.40 M\nCapturas: 418 (09:30 — 09:41)';
  const r = parseFlujo(t);
  assert.equal(r.calls, 302.5);
  assert.equal(r.puts, 253.55);
  assert.equal(r.spx, 7565.07);
  assert.equal(r.momentum, 12.4);
  assert.equal(r.capturas, '418 (09:30 — 09:41)');
  assert.equal(r.esperando, false);
});

await caso('Flow Dashboard fuera de horario: sin numeros', () => {
  const r = parseFlujo('Net Flow\nEsperando datos de flujo… (disponible para SPX)');
  assert.equal(r.calls, null);
  assert.equal(r.esperando, true);
});

await caso('Flow Meter: con prima, con $0 (aun cargando) y ausente', () => {
  const m = parseMeter('FLOW METER\nNeutral\n44% alcista · 56% bajista\nPRIMA TOTAL $6.13 B');
  assert.deepEqual(m, { pctAlcista: 44, pctBajista: 56, primaTotal: 6130, dir: -735.6 });
  assert.equal(parseMeter('FLOW METER\nNeutral\n50% alcista · 50% bajista\nPRIMA TOTAL $0\n'), null);
  assert.equal(parseMeter(null), null);
});

await caso('9:30 ET con y sin horario de verano', () => {
  // 12-nov-2026 (EST, UTC-5): 14:30 UTC.  15-jul-2026 (EDT, UTC-4): 13:30 UTC.
  assert.equal(baseMinuto('2026-11-12') * 60000, Date.UTC(2026, 10, 12, 14, 30));
  assert.equal(baseMinuto('2026-07-15') * 60000, Date.UTC(2026, 6, 15, 13, 30));
  assert.equal(fechaET(new Date(Date.UTC(2026, 10, 13, 3, 0))), '2026-11-12');   // 22:00 ET del 12
});

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-')); }
const silencio = { warn: () => {} };
const enMin = (dia, min) => new Date((baseMinuto(dia) + min) * 60000 + 5000);

await caso('serie: desde las 9:30, fuera de sesion no entra, minuto repetido se reemplaza', () => {
  const dir = tmpDir();
  const f = crearFlujo({ dir, log: silencio });
  const dia = '2026-11-12';
  assert.equal(f.registrar({ calls: 1, puts: 1 }, { ahora: enMin(dia, -5) }), null);     // 9:25
  f.registrar({ calls: 0.5, puts: 0.4, spx: 7600 }, { ahora: enMin(dia, 0) });
  f.registrar({ calls: 10, puts: 8, spx: 7601, meter: { dir: -20.4 } }, { ahora: enMin(dia, 2) });
  f.registrar({ calls: 11, puts: 8.5 }, { ahora: enMin(dia, 2) });                         // mismo minuto
  assert.equal(f.registrar({ calls: 1, puts: 1 }, { ahora: enMin(dia, 391) }), null);     // 16:01
  assert.equal(f.registrar({ calls: null, puts: 1 }, { ahora: enMin(dia, 4) }), null);
  const t = f.textoParaTV(enMin(dia, 3));
  assert.equal(t.serie, `${baseMinuto(dia)}|0:0.5:0.4;2:11.0:8.5`);
  assert.equal(t.marcas, '');
});

await caso('reinicio del robot: recupera lo leido hoy del archivo', () => {
  const dir = tmpDir();
  const dia = '2026-11-12';
  const a = crearFlujo({ dir, log: silencio });
  a.registrar({ calls: 5, puts: 4, spx: 7600, meter: { dir: 12.3 } }, { ahora: enMin(dia, 10) });
  a.registrar({ calls: 7, puts: 4, spx: 7602 }, { ahora: enMin(dia, 12) });
  const b = crearFlujo({ dir, log: silencio });
  assert.equal(b.textoParaTV(enMin(dia, 13)).serie, `${baseMinuto(dia)}|10:5.0:4.0:12.3;12:7.0:4.0`);
  // y al dia siguiente arranca vacio
  assert.equal(b.textoParaTV(enMin('2026-11-13', 1)), null);
});

await caso('marcas regla v2: subida, bajada, pausa de 30 min y sin precio no marca', () => {
  const regla = { ventanaMin: 30, umbralM: 8.7, pausaMin: 30 };
  const fila = (min, neto, spx) => ({ min, calls: 100 + neto, puts: 100, spx });
  const filas = [
    fila(0, 0, 7600), fila(30, 10, 7610),     // +10 M y sube -> S en 30
    fila(40, 25, 7615),                         // dentro de la pausa -> nada
    fila(60, 30, 7620),                         // vs min 30: +20 y sube -> S (pasaron 30)
    fila(90, 15, 7600),                         // vs 60: -15 y baja -> B
    fila(120, 0, null),                         // sin precio -> nada
  ];
  assert.deepEqual(calcularMarcas(filas, regla).map((m) => `${m.min}:${m.tipo}`), ['30:S', '60:S', '90:B']);
  // neto sube pero precio baja: no es "con respaldo"
  assert.deepEqual(calcularMarcas([fila(0, 0, 7600), fila(30, 20, 7590)], regla), []);
});

await caso('serie con el dia real del 11-nov (lector viejo): formato que entiende el Pine', () => {
  const archivo = 'C:/Users/gcarv/Documents/CARPETA PERSONAL/01. guillermo carvajal/01_Sigma/chalito/datos/sigma_flow/2026-11-11.jsonl';
  if (!fs.existsSync(archivo)) { console.log('    (sin archivo del 11-nov, se salta)'); return; }
  const dir = tmpDir();
  const f = crearFlujo({ dir, log: silencio });
  for (const linea of fs.readFileSync(archivo, 'utf8').split('\n')) {
    if (!linea.trim()) continue;
    const d = JSON.parse(linea);
    f.registrar({ calls: d.calls, puts: d.puts, spx: d.spx, meter: d.meter_ok ? { dir: d.dir_neto } : null }, { ahora: new Date(d.ts) });
  }
  const t = f.textoParaTV(new Date('2026-11-11T18:00:00Z'));
  const [base, puntos] = t.serie.split('|');
  assert.equal(Number(base), baseMinuto('2026-11-11'));
  const ps = puntos.split(';');
  assert.ok(ps.length >= 20);
  for (const p of ps) assert.match(p, /^\d+:-?\d+\.\d:-?\d+\.\d(:-?\d+\.\d)?$/);
  assert.equal(ps[0].split(':').slice(0, 3).join(':'), '129:860.8:632.9');   // 11:39 ET
  // jornada completa a 2 min = 196 puntos: el texto debe seguir siendo razonable
  const largo = armarSerie(base, Array.from({ length: 196 }, (_, i) => ({ min: i * 2, calls: 1234.5, puts: 1100.2, dir: -735.6 })));
  assert.ok(largo.length < 6000, `serie de un dia completo mide ${largo.length}`);
});

console.log(`flujo.test: ${ok} casos ok`);
