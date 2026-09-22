// node gamma_daemon/vencimiento.test.mjs
// Cubre el caso del 22-sep: pestaña en el vencimiento de ayer -> recarga -> lee hoy.
import assert from 'assert';
import { crearLectorDeHoy, exigirVencimientoDeHoy, RECARGA_MIN_MS } from './vencimiento.js';

const HOY = '2026-09-22';
let ok = 0;
async function caso(nombre, fn) { await fn(); ok++; console.log('  ok -', nombre); }

function montar(secuencia, t0 = 1_000_000) {
  const lecturas = [...secuencia];
  const s = { recargas: 0, t: t0 };
  s.leer = crearLectorDeHoy({
    readLevels: async () => ({ expiry: lecturas.length > 1 ? lecturas.shift() : lecturas[0] }),
    recargar: async () => { s.recargas++; },
    fechaET: () => HOY,
    ahora: () => s.t,
    log: () => {},
  });
  return s;
}

await caso('vencimiento de hoy: no recarga', async () => {
  const s = montar([HOY]);
  assert.equal((await s.leer()).expiry, HOY);
  assert.equal(s.recargas, 0);
});

await caso('22-sep: pestaña en el de ayer -> recarga y devuelve el de hoy', async () => {
  const s = montar(['2026-09-21', HOY]);
  assert.equal((await s.leer()).expiry, HOY);
  assert.equal(s.recargas, 1);
});

await caso('Sigma aun no cambio de dia: una recarga, y no otra antes de 5 min', async () => {
  const s = montar(['2026-09-21']);
  assert.equal((await s.leer()).expiry, '2026-09-21');
  s.t += 30_000;
  await s.leer();
  assert.equal(s.recargas, 1);
  s.t += RECARGA_MIN_MS;
  await s.leer();
  assert.equal(s.recargas, 2);
});

await caso('expiry null (rotulo ilegible): no recarga ni bloquea', async () => {
  const s = montar([null]);
  assert.equal((await s.leer()).expiry, null);
  assert.equal(s.recargas, 0);
  assert.doesNotThrow(() => exigirVencimientoDeHoy({ expiry: null }, HOY));
});

await caso('cerrojo de sesion: vencimiento de ayer lanza, el de hoy pasa', async () => {
  assert.throws(() => exigirVencimientoDeHoy({ expiry: '2026-09-21' }, HOY), /no se empujan muros/);
  assert.doesNotThrow(() => exigirVencimientoDeHoy({ expiry: HOY }, HOY));
});

console.log(`vencimiento: ${ok} casos OK`);
