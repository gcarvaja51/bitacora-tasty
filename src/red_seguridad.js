// Red de seguridad global del proceso (2026-11-21, pedido de Guillermo tras la 2.ª auditoría de la hoja Hiro).
//
// Por qué: Node 24 TERMINA el proceso ante cualquier promesa rechazada sin catch o excepción no atrapada, venga de
// donde venga (una hoja informativa, un parseo de un proveedor externo...). En este servidor eso apaga también el
// robot de trading hasta que Railway lo relanza, y pierde el estado en memoria.
//
// Qué hace:
//   - promesa rechazada sin catch  → se anota (consola + DATA_DIR/errores_globales.json) y el proceso SIGUE.
//   - excepción no atrapada        → se anota y el proceso SIGUE, salvo que haya más de `limite` en `ventanaMs`
//                                     (algo está roto en bucle): entonces sale con código 1 para que Railway reinicie
//                                     limpio, en vez de seguir operando con el estado corrompido.
// Lo anotado se ve en /api/health (erroresGlobales) para que la torre de control lo detecte.
const fs = require('fs');
const path = require('path');

function instalar({ dataDir, proceso = process, log = console.error, limite = 10, ventanaMs = 60000, ahora = () => Date.now() } = {}) {
  const ruta = dataDir ? path.join(dataDir, 'errores_globales.json') : null;
  const ultimos = [];          // los 50 más recientes
  const recientes = [];        // marcas de tiempo de excepciones (para el freno de reinicio)
  let total = 0;

  const guardar = () => {
    if (!ruta) return;
    try { fs.writeFileSync(ruta, JSON.stringify({ total, ultimos }, null, 1)); } catch { /* la red no puede tumbar nada */ }
  };

  function anotar(tipo, err) {
    total++;
    const e = err instanceof Error ? err : new Error(String(err));
    const reg = { tipo, ts: new Date(ahora()).toISOString(), mensaje: String(e.message).slice(0, 300),
      pila: String(e.stack || '').split('\n').slice(1, 7).map((l) => l.trim()).join(' | ').slice(0, 800) };
    ultimos.push(reg);
    if (ultimos.length > 50) ultimos.shift();
    try { log(`[RED DE SEGURIDAD] ${tipo}: ${reg.mensaje}\n  ${reg.pila}`); } catch { /* sin consola */ }
    guardar();
    return reg;
  }

  const alRechazo = (motivo) => { anotar('promesa sin catch', motivo); };
  const alExcepcion = (err) => {
    anotar('excepción no atrapada', err);
    const t = ahora();
    recientes.push(t);
    while (recientes.length && t - recientes[0] > ventanaMs) recientes.shift();
    if (recientes.length > limite) {
      try { log(`[RED DE SEGURIDAD] ${recientes.length} excepciones en ${Math.round(ventanaMs / 1000)} s: se reinicia el proceso`); } catch {}
      proceso.exit(1);
    }
  };
  proceso.on('unhandledRejection', alRechazo);
  proceso.on('uncaughtException', alExcepcion);

  return {
    resumen: () => ({ total, ultimo: ultimos[ultimos.length - 1] || null }),
    lista: () => ultimos.slice(),
    desinstalar: () => { proceso.removeListener('unhandledRejection', alRechazo); proceso.removeListener('uncaughtException', alExcepcion); },
  };
}

module.exports = { instalar };
