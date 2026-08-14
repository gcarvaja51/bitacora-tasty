// Prueba de sincronizacion de dibujos PC -> celular.
// Crea UNA linea horizontal de prueba en la ventana SPCFD:SPX y guarda su id en
// _test_draw_sync_id.txt para poder borrar EXACTAMENTE esa despues.
//
// NUNCA llama removeAllShapes: el chart del usuario ya tiene dibujos propios.
//
// Uso:
//   node _test_draw_sync.mjs crear [precio]
//   node _test_draw_sync.mjs borrar
//   node _test_draw_sync.mjs listar
import CDP from 'chrome-remote-interface';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ID_PATH = path.join(__dirname, '_test_draw_sync_id.txt');
const CDP_PORT = Number(process.env.TV_CDP_PORT || 9223);

const accion = process.argv[2] || 'listar';
const precio = Number(process.argv[3] || 7745);

// awaitPromise es obligatorio para createShape: devuelve una PROMESA, no el id.
// Sin esto el id que vuelve es la cadena "[object Promise]" y el conteo de shapes
// se lee antes de que el dibujo exista (pasado real, 2026-08-14: la linea se creo
// igual pero quedo sin id registrado y hubo que buscarla a mano en getAllShapes).
async function evalOn(client, expression, awaitPromise = false) {
  const r = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}

async function conectarSpx() {
  const resp = await fetch(`http://localhost:${CDP_PORT}/json/list`);
  const targets = (await resp.json()).filter((t) => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
  for (const t of targets) {
    let client;
    try {
      client = await CDP({ port: CDP_PORT, target: t.id });
      await client.Runtime.enable();
      const esSpx = await evalOn(client, `
        (function() {
          try {
            return window.TradingViewApi._chartWidgetCollection.getAll().some(function(c) {
              try { return /^SPCFD:SPX$/i.test(c.model().mainSeries().symbol()); } catch (e) { return false; }
            });
          } catch (e) { return false; }
        })()
      `);
      if (esSpx) return { client, targetId: t.id };
      await client.close();
    } catch (e) {
      if (client) { try { await client.close(); } catch {} }
    }
  }
  throw new Error('No hay ninguna ventana con SPCFD:SPX cargado.');
}

const { client, targetId } = await conectarSpx();
console.log(`ventana SPX: ${targetId.slice(0, 8)}`);

try {
  if (accion === 'crear') {
    const res = await evalOn(client, `
      (async function() {
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          var antes = chart.getAllShapes().length;
          var sync = null;
          try { sync = !!chart._canUseLineToolsSynchronizer; } catch (e) {}
          // Un punto en el tiempo dentro del rango visible; para horizontal_line
          // solo manda el precio, pero la API pide el par time/price igual.
          var t = Math.floor(Date.now() / 1000);
          var id = await chart.createShape(
            { time: t, price: ${precio} },
            {
              shape: 'horizontal_line',
              lock: false,
              disableSelection: false,
              overrides: {
                linecolor: '#FF00FF',
                linewidth: 2,
                linestyle: 2,
                showLabel: true,
                text: 'TEST SYNC - BORRAR',
                textcolor: '#FF00FF'
              }
            }
          );
          return { ok: true, id: String(id), antes: antes, despues: chart.getAllShapes().length, syncDisponible: sync };
        } catch (e) { return { ok: false, error: e.message }; }
      })()
    `, true);
    console.log(JSON.stringify(res, null, 2));
    if (res && res.ok && res.id) {
      writeFileSync(ID_PATH, res.id, 'utf8');
      console.log(`id guardado en ${ID_PATH}`);
    }
  } else if (accion === 'borrar') {
    if (!existsSync(ID_PATH)) throw new Error('No hay id guardado: nada que borrar.');
    const id = readFileSync(ID_PATH, 'utf8').trim();
    const res = await evalOn(client, `
      (function() {
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          var antes = chart.getAllShapes().length;
          chart.removeEntity(${JSON.stringify(id)});
          return { ok: true, antes: antes, despues: chart.getAllShapes().length };
        } catch (e) { return { ok: false, error: e.message }; }
      })()
    `);
    console.log(JSON.stringify(res, null, 2));
    if (res && res.ok) unlinkSync(ID_PATH);
  } else {
    const res = await evalOn(client, `
      (function() {
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          return { total: chart.getAllShapes().length, shapes: chart.getAllShapes() };
        } catch (e) { return { error: e.message }; }
      })()
    `);
    console.log(JSON.stringify(res, null, 2));
  }
} finally {
  await client.close();
}
