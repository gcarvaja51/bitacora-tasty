'use strict';
// ── Archivo permanente (Guillermo 2026-11-09: "tenemos que guardar toda esa data... no la podemos perder") ──
//
// Por que existe: los dos historiales que mas sirven para analizar se recortaban solos y se perdian:
//   - las lecturas de gamma y muros del Monitor SPX (sigma_levels: tope 10.000 ~ 3 semanas), y
//   - el log de decisiones del robot (spx_strategy_log: tope 5.000 ~ 10 dias).
// El 9-nov, para saber si el veto de muro (DIR-5) funciona con gamma negativa, solo quedaban 16 dias de gamma
// intradia. Desde aca, cada lectura y cada evento se escribe ADEMAS en un archivo por dia que nunca se recorta:
//
//   <DATA_DIR>/archivo/<tipo>/<AAAA-MM-DD>.jsonl      el dia en curso (una linea JSON por registro)
//   <DATA_DIR>/archivo/<tipo>/<AAAA-MM-DD>.jsonl.gz   los dias cerrados, comprimidos (~0,05 MB/dia)
//
// La fecha es la del dia de mercado en Nueva York. Los historiales con tope siguen igual (las pantallas y las
// estrategias leen de ellos): esto es una copia aparte, solo para no perder nada. Nunca lanza: archivar no puede
// tumbar una estrategia. La copia a la PC y a MEGA la hace scripts/respaldo_archivo.ps1 (Tarea Programada).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TIPOS_VALIDOS = /^[a-z][a-z0-9_-]{1,30}$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const fechaET = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);

function crearArchivo({ dataDir, log = console }) {
  const raiz = path.join(dataDir, 'archivo');
  const ultimoDiaPorTipo = new Map();

  const dirTipo = (tipo) => path.join(raiz, tipo);

  // Comprime los .jsonl de dias anteriores al de hoy (se llama al cambiar de dia, no en cada escritura).
  function comprimirCerrados(tipo, hoy) {
    try {
      for (const f of fs.readdirSync(dirTipo(tipo))) {
        const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (!m || m[1] >= hoy) continue;
        const crudo = path.join(dirTipo(tipo), f);
        const gz = crudo + '.gz';
        const datos = fs.readFileSync(crudo);
        const previo = fs.existsSync(gz) ? zlib.gunzipSync(fs.readFileSync(gz)) : Buffer.alloc(0);
        fs.writeFileSync(gz, zlib.gzipSync(Buffer.concat([previo, datos])));
        fs.unlinkSync(crudo);
      }
    } catch (e) { log.warn?.(`[ARCHIVO] no se pudo comprimir ${tipo}: ${e.message}`); }
  }

  function archivar(tipo, registro, cuando = new Date()) {
    try {
      if (!TIPOS_VALIDOS.test(tipo)) return false;
      const dia = fechaET(cuando instanceof Date ? cuando : new Date(cuando));
      fs.mkdirSync(dirTipo(tipo), { recursive: true });
      if (ultimoDiaPorTipo.get(tipo) !== dia) {
        ultimoDiaPorTipo.set(tipo, dia);
        comprimirCerrados(tipo, dia);
      }
      fs.appendFileSync(path.join(dirTipo(tipo), `${dia}.jsonl`), JSON.stringify(registro) + '\n', 'utf8');
      return true;
    } catch (e) {
      log.warn?.(`[ARCHIVO] no se pudo archivar ${tipo}: ${e.message}`);
      return false;
    }
  }

  // Inventario: { tipo: [{ fecha, archivo, bytes, comprimido }] }, mas reciente primero.
  function listar() {
    const out = {};
    if (!fs.existsSync(raiz)) return out;
    for (const tipo of fs.readdirSync(raiz)) {
      if (!TIPOS_VALIDOS.test(tipo)) continue;
      const filas = [];
      for (const f of fs.readdirSync(dirTipo(tipo))) {
        const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/);
        if (!m) continue;
        filas.push({ fecha: m[1], archivo: f, bytes: fs.statSync(path.join(dirTipo(tipo), f)).size, comprimido: !!m[2] });
      }
      out[tipo] = filas.sort((a, b) => b.fecha.localeCompare(a.fecha) || a.archivo.localeCompare(b.archivo));
    }
    return out;
  }

  // Contenido crudo (jsonl, sin comprimir) de un dia: junta el .gz y el .jsonl si existieran los dos.
  function leerDia(tipo, fecha) {
    if (!TIPOS_VALIDOS.test(tipo) || !FECHA.test(fecha)) return null;
    const base = path.join(dirTipo(tipo), `${fecha}.jsonl`);
    const partes = [];
    if (fs.existsSync(base + '.gz')) partes.push(zlib.gunzipSync(fs.readFileSync(base + '.gz')));
    if (fs.existsSync(base)) partes.push(fs.readFileSync(base));
    return partes.length ? Buffer.concat(partes).toString('utf8') : null;
  }

  return { archivar, listar, leerDia, raiz };
}

module.exports = { crearArchivo, fechaET };
