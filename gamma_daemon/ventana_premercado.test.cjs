// node --test ventana_premercado.test.cjs
//
// La franja de premercado del daemon (08:15-09:00 ET, solo lectura) contra el
// calendario real de la NYSE. En .cjs porque calendario_nyse.js es CommonJS.
//
// El caso que justifica el archivo es el ultimo: enVentanaET recorta el final de
// la ventana en las MEDIAS SESIONES (-180 min, pensado para adelantar el cierre de
// 16:05 a 13:05). Aplicado a una ventana que termina a las 09:00 la deja en
// 08:15-06:00, o sea vacia -- el 27-nov-2026 el premercado se habria quedado sin
// dato fresco sin que saltara ninguna alarma. De ahi el recortarMedioDia:false.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const calendario = require('../src/calendario_nyse.js');

const PREMERCADO_DESDE_MIN = 8 * 60 + 15;
const enPremercado = (iso) => calendario.enVentanaET(PREMERCADO_DESDE_MIN, 9 * 60, {
  finInclusivo: false,
  recortarMedioDia: false,
  ahora: new Date(iso),
});
const enOperacion = (iso) => calendario.enVentanaET(9 * 60, 16 * 60 + 5, { ahora: new Date(iso) });

test('la franja cubre la hora del recolector (08:30 ET) y sus bordes', () => {
  assert.equal(enPremercado('2026-09-10T12:00:00Z'), false, '08:00 ET todavia no');
  assert.equal(enPremercado('2026-09-10T12:15:00Z'), true,  '08:15 ET arranca');
  assert.equal(enPremercado('2026-09-10T12:30:00Z'), true,  '08:30 ET, el recolector');
  assert.equal(enPremercado('2026-09-10T12:59:00Z'), true,  '08:59 ET aun dentro');
  assert.equal(enPremercado('2026-09-10T13:00:00Z'), false, '09:00 ET ya es la ventana de operacion');
});

test('no corre en dias sin mercado', () => {
  assert.equal(enPremercado('2026-09-12T12:30:00Z'), false, 'sabado');
  assert.equal(enPremercado('2026-11-26T13:30:00Z'), false, 'Accion de Gracias');
});

test('SI corre en media sesion: la campana suena a las 09:30 igual', () => {
  assert.equal(calendario.esMedioDia('2026-11-27'), true, 'el 27-nov-2026 debe estar como media sesion');
  assert.equal(enPremercado('2026-11-27T13:30:00Z'), true);
});

test('la ventana de OPERACION no se movio: sigue empezando a las 09:00', () => {
  assert.equal(enOperacion('2026-09-10T12:30:00Z'), false, '08:30 ET fuera');
  assert.equal(enOperacion('2026-09-10T12:59:00Z'), false, '08:59 ET fuera');
  assert.equal(enOperacion('2026-09-10T13:00:00Z'), true,  '09:00 ET dentro');
  assert.equal(enOperacion('2026-09-10T19:00:00Z'), true,  '15:00 ET dentro');
});

test('premercado y operacion no se solapan nunca', () => {
  for (let m = 7 * 60; m <= 17 * 60; m += 1) {
    const iso = new Date(Date.UTC(2026, 8, 10, 4, 0, 0) + m * 60000).toISOString();
    assert.ok(!(enPremercado(iso) && enOperacion(iso)), `se solapan en ${iso}`);
  }
});
