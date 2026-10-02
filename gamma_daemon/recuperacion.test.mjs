// node gamma_daemon/recuperacion.test.mjs
// Cubre el caso del 02-oct: lectura trabada -> recargar, recargar, relanzar.
import assert from 'assert';
import { crearRecuperador } from './recuperacion.js';

let ok = 0;
async function caso(nombre, fn) { await fn(); ok++; console.log('  ok -', nombre); }

function montar({ fallaRecargar = false, fallaRelanzar = false } = {}) {
  const s = { acciones: [] };
  s.recuperar = crearRecuperador({
    recargar: async () => { s.acciones.push('recargar'); if (fallaRecargar) throw new Error('Navigation timeout'); },
    relanzar: async () => { s.acciones.push('relanzar'); if (fallaRelanzar) throw new Error('boom'); },
    log: () => {},
  });
  return s;
}

await caso('sin fallos no hace nada', async () => {
  const s = montar();
  assert.equal(await s.recuperar(0), null);
  assert.deepEqual(s.acciones, []);
});

await caso('02-oct: escalera recargar, recargar, relanzar y vuelve a empezar', async () => {
  const s = montar();
  for (let n = 1; n <= 6; n++) await s.recuperar(n);
  assert.deepEqual(s.acciones, ['recargar', 'recargar', 'relanzar', 'recargar', 'recargar', 'relanzar']);
});

await caso('si la recarga falla no tira excepcion (el loop sigue)', async () => {
  const s = montar({ fallaRecargar: true });
  assert.equal(await s.recuperar(1), 'recargar_fallo');
});

await caso('si el relanzamiento falla no tira excepcion', async () => {
  const s = montar({ fallaRelanzar: true });
  assert.equal(await s.recuperar(3), 'relanzar_fallo');
});

console.log(`recuperacion: ${ok} casos OK`);
