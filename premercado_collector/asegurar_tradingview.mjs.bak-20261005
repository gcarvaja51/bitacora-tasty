// Deja TradingView en condiciones de ser leido ANTES de que corra el recolector.
//
// POR QUE EXISTE (2026-09-09). El recolector y base_sp500.js leen el chart por CDP
// en el puerto 9223, y ese puerto solo existe si TradingView se lanzo con
// --remote-debugging-port=9223. Nada en el arranque de Windows lo hace: no hay nada
// en la carpeta Inicio, ni en HKCU\...\Run, ni una tarea programada. O sea que cuando
// el usuario abre TradingView a mano --lo normal, un clic en el icono-- la app arranca
// SIN el puerto y todo lo que lee el grafico se queda ciego. Fue exactamente lo que
// paso el 09-09: TradingView abierto desde las 5:59am sin la bandera, y a las 08:30 el
// recolector devolvio "[tv] FALLO: fetch failed" y base_sp500 "exit 1".
//
// Y hay algo peor que la ceguera. Cuando el gamma_daemon entra en su ventana a las
// 09:00 y no encuentra el puerto, su pushToTradingViewWithRetry hace
// taskkill /F /IM TradingView.exe y relanza -- el incidente del 2026-08-06, que deja
// al usuario sin ventana justo antes de la apertura. Este script mueve ese mismo
// relanzamiento a las 08:25, cuando todavia no hay nada en juego, y verifica que la
// ventana vuelva con SPCFD:SPX. Si el puerto YA responde no toca nada: en el caso
// normal esto no cuesta ni un parpadeo.
import * as tv from '../gamma_daemon/tv.js';

const PORT = Number(process.env.TV_CDP_PORT || 9223);

async function cdpVivo() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch {
    return false;
  }
}

// El puerto abierto no basta: la ventana tiene que tener el SPX cargado, que es lo
// que de verdad va a leer el recolector. healthCheck() de tv.js ya valida las dos
// cosas (conecta y exige una ventana con SPCFD:SPX).
async function ventanaUtil() {
  try {
    const h = await tv.healthCheck();
    return h?.success === true;
  } catch {
    return false;
  }
}

if (await cdpVivo() && await ventanaUtil()) {
  console.log(`[tv] listo -- puerto ${PORT} responde y hay ventana con SPCFD:SPX. No se toca nada.`);
  process.exit(0);
}

console.log(`[tv] el puerto ${PORT} no responde o no hay ventana con SPCFD:SPX.`);
console.log('[tv] relanzando TradingView con la bandera de depuracion (esto CIERRA la ventana actual).');

try {
  const r = await tv.launch({ killExisting: true });
  console.log(`[tv] relanzado (pid ${r.pid}, cdpReady=${r.cdpReady})`);
} catch (e) {
  console.log(`[tv] FALLO al relanzar: ${e.message}`);
  process.exit(1);
}

// Cargar el layout y pintar el SPX tarda mas que abrir el puerto. 12 intentos x 5s.
for (let i = 1; i <= 12; i++) {
  await new Promise((res) => setTimeout(res, 5000));
  if (await ventanaUtil()) {
    console.log(`[tv] OK -- ventana con SPCFD:SPX confirmada tras ${i * 5}s.`);
    process.exit(0);
  }
}

console.log('[tv] FALLO: TradingView se relanzo pero no aparecio una ventana con SPCFD:SPX en 60s.');
process.exit(1);
