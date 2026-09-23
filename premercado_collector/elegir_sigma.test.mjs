// node --test elegir_sigma.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elegirSigma } from './elegir_sigma.mjs';

const MAX = 45;
const T0830 = Date.parse('2026-09-09T12:30:00Z'); // 08:30 ET, la hora del recolector

const nivelesPremercado = { callWall: 7700, putWall: 7630, gammaFlip: 7688, expiry: '2026-09-09' };
const nivelesAyer       = { callWall: 7680, putWall: 7675, gammaFlip: 7692, expiry: '2026-09-08' };

test('a las 08:30 gana la lectura de premercado, no el cierre de ayer', () => {
  const r = elegirSigma({
    premercado: { levels: nivelesPremercado, leidoEn: '2026-09-09T12:15:30Z' },
    lastLevels: nivelesAyer,
    lastSuccessAt: '2026-09-08T19:52:40Z',
  }, T0830, MAX);
  assert.equal(r.fuente, 'premercado');
  assert.equal(r.levels.putWall, 7630);
  assert.equal(r.rancio, false);
  assert.equal(r.antiguedadMin, 15);
});

test('el fallo real del 2026-09-09: sin fase de premercado, el cierre de ayer sale marcado RANCIO', () => {
  const r = elegirSigma({
    lastLevels: nivelesAyer,
    lastSuccessAt: '2026-09-08T19:52:40Z',
  }, T0830, MAX);
  assert.equal(r.fuente, 'ultimo_ciclo_operacion');
  assert.equal(r.rancio, true);
  assert.ok(r.antiguedadMin > 16 * 60, `esperaba mas de 16h, dio ${r.antiguedadMin} min`);
});

test('en plena sesion manda lastLevels aunque exista un premercado mas viejo', () => {
  const T1400 = Date.parse('2026-09-09T18:00:00Z'); // 14:00 ET
  const r = elegirSigma({
    premercado: { levels: nivelesPremercado, leidoEn: '2026-09-09T12:15:30Z' },
    lastLevels: { callWall: 7710, putWall: 7640, gammaFlip: 7690, expiry: '2026-09-09' },
    lastSuccessAt: '2026-09-09T17:59:30Z',
  }, T1400, MAX);
  assert.equal(r.fuente, 'ultimo_ciclo_operacion');
  assert.equal(r.rancio, false);
});

test('una lectura de premercado del dia ANTERIOR no se cuela como fresca', () => {
  const r = elegirSigma({
    premercado: { levels: nivelesPremercado, leidoEn: '2026-09-08T12:15:30Z' },
    lastLevels: nivelesAyer,
    lastSuccessAt: '2026-09-08T19:52:40Z',
  }, T0830, MAX);
  // Gana lastLevels por ser mas reciente, y aun asi va marcado rancio.
  assert.equal(r.fuente, 'ultimo_ciclo_operacion');
  assert.equal(r.rancio, true);
});

test('sin sello de tiempo se considera rancio, no fresco', () => {
  const r = elegirSigma({ lastLevels: nivelesAyer }, T0830, MAX);
  assert.equal(r.antiguedadMin, null);
  assert.equal(r.rancio, true);
});

test('justo en el limite de 45 min todavia vale; a los 46 no', () => {
  const enLimite = elegirSigma({
    premercado: { levels: nivelesPremercado, leidoEn: new Date(T0830 - 45 * 60000).toISOString() },
  }, T0830, MAX);
  assert.equal(enLimite.rancio, false);
  const pasado = elegirSigma({
    premercado: { levels: nivelesPremercado, leidoEn: new Date(T0830 - 46 * 60000).toISOString() },
  }, T0830, MAX);
  assert.equal(pasado.rancio, true);
});

test('status vacio lanza en vez de devolver niveles inventados', () => {
  assert.throws(() => elegirSigma({}, T0830, MAX), /no tiene ni premercado ni lastLevels/);
});

// ── esperarSigmaDeHoy (2026-09-23) ──
import { esperarSigmaDeHoy, diagnosticoDaemon } from './elegir_sigma.mjs';

function relojFalso(t0) {
  let t = t0;
  return { ahora: () => t, dormir: async (ms) => { t += ms; } };
}

test('espera: si el dato fresco llega al tercer intento, devuelve OK', async () => {
  const r = relojFalso(T0830);
  let n = 0;
  const rancio = { lastLevels: nivelesAyer, lastSuccessAt: '2026-09-08T19:52:40Z' };
  const res = await esperarSigmaDeHoy({
    leerStatus: () => {
      n += 1;
      if (n < 3) return rancio;
      return { ...rancio, premercado: { levels: nivelesPremercado, leidoEn: new Date(r.ahora()).toISOString() } };
    },
    ...r, maxAntiguedadMin: MAX, esperaMs: 240000, pasoMs: 20000,
  });
  assert.equal(res.rancio, false);
  assert.equal(res.fuente, 'premercado');
  assert.equal(res.intentos, 3);
});

test('espera: si nunca llega, respeta el tope y devuelve rancio', async () => {
  const r = relojFalso(T0830);
  const res = await esperarSigmaDeHoy({
    leerStatus: () => ({ lastLevels: nivelesAyer, lastSuccessAt: '2026-09-08T19:52:40Z' }),
    ...r, maxAntiguedadMin: MAX, esperaMs: 240000, pasoMs: 20000,
  });
  assert.equal(res.rancio, true);
  assert.ok(res.esperaMs <= 240000);
});

test('espera: un status.json a medio escribir no tumba la espera', async () => {
  const r = relojFalso(T0830);
  let n = 0;
  const res = await esperarSigmaDeHoy({
    leerStatus: () => {
      n += 1;
      if (n === 1) throw new SyntaxError('Unexpected end of JSON input');
      return { premercado: { levels: nivelesPremercado, leidoEn: new Date(r.ahora()).toISOString() } };
    },
    ...r, maxAntiguedadMin: MAX, esperaMs: 240000, pasoMs: 20000,
  });
  assert.equal(res.rancio, false);
});

test('diagnostico: daemon parado se dice con su antiguedad', () => {
  const d = diagnosticoDaemon({ lastCycleAt: '2026-09-09T12:20:00Z' }, T0830);
  assert.match(d, /NO cicla hace 10 min/);
});
