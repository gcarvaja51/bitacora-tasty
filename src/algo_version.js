'use strict';

// ── Control de cambios y versionado del algoritmo (2026-08-03) ──────────────
//
// Por que existe: hasta hoy los cambios quedaban en git y en CLAUDE.md, pero no
// habia forma de ATRIBUIR resultados a versiones. Cuando el usuario pregunta
// "¿este ajuste mejoro o empeoro?", la unica respuesta honesta era "no se
// puede saber": los trades no llevan sello de bajo que configuracion corrieron.
//
// Sin eso el objetivo de llegar a 80% de win rate por familia es inalcanzable —
// se puede iterar, pero no se puede aprender de la iteracion.
//
// Dos mecanismos, deliberadamente separados:
//
//   1. HUELLA (calcularHuella): se calcula SOLA a partir de los parametros que
//      de verdad cambian el comportamiento. Se estampa en cada ejecucion al
//      crearla. Es objetiva y no depende de que nadie se acuerde de anotar
//      nada — si alguien toca un peso via POST /api/spx/config sin avisar, la
//      huella cambia igual y los trades quedan separados.
//
//   2. BITACORA (changelog): entradas escritas a mano con el porque, quien lo
//      pidio y que se esperaba. La huella dice QUE cambio; la bitacora dice
//      POR QUE. Ninguna de las dos sustituye a la otra.

const crypto = require('crypto');

// Parametros que afectan el comportamiento de cada familia. Cambiar cualquiera
// de estos produce una huella distinta y separa los trades en el reporte.
// OJO: agregar una clave aca invalida la comparacion con el historial previo
// (la huella cambia para todos), asi que solo se suman parametros que de
// verdad cambien decisiones.
function parametrosRelevantes(cfg = {}) {
  const t = cfg.trading || {};
  const rev = t.smaReversion || {};
  const ic = t.ironCondor || {};
  return {
    TENDENCIA: {
      entryMode:           cfg.entryMode ?? 'camino_b',
      minScore:            cfg.minScore ?? 80,
      minScoreTrasPerdida: cfg.minScoreTrasPerdida ?? null,
      weights:             cfg.weights ?? {},
      targetDelta:         t.targetDelta ?? null,
      tpPct:               t.tpPct ?? null,
      slMult:              t.slMult ?? null,
      debit:               t.debit ?? null,
    },
    REVERSION: {
      minScore:            rev.minScore ?? null,
      weights:             rev.weights ?? {},
      earlyExitPct:        rev.earlyExitPct ?? null,
      riskPctPerTrade:     rev.riskPctPerTrade ?? null,
      maxDailyDrawdownPct: rev.maxDailyDrawdownPct ?? null,
    },
    NEUTRAL: {
      targetDelta:        ic.targetDelta ?? null,
      spreadWidth:        ic.spreadWidth ?? null,
      tpPct:              ic.tpPct ?? null,
      slMult:             ic.slMult ?? null,
      ivRankThreshold:    ic.ivRankThreshold ?? null,
      minCreditoAnchoPct: ic.minCreditoAnchoPct ?? null,
      gammaFlipBufferPts: ic.gammaFlipBufferPts ?? null,
    },
  };
}

// Huella corta y estable. JSON.stringify con claves ordenadas para que el mismo
// contenido de en el mismo hash sin importar el orden en que se guardo.
function estable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(estable).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + estable(v[k])).join(',') + '}';
}

function calcularHuella(cfg, familia) {
  const p = parametrosRelevantes(cfg);
  const rel = familia && p[familia] ? p[familia] : p;
  return crypto.createHash('sha1').update(estable(rel)).digest('hex').slice(0, 8);
}

// Sello completo que se guarda en cada ejecucion. Ademas de la huella se
// guardan los parametros EN CLARO: dentro de tres meses la huella sola no dice
// nada, y la config del volumen ya habra cambiado.
function sellarVersion(cfg, familia) {
  return {
    huella:     calcularHuella(cfg, familia),
    familia:    familia || null,
    commit:     process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || null,
    sellado:    new Date().toISOString(),
    parametros: (parametrosRelevantes(cfg)[familia]) || null,
  };
}

module.exports = { calcularHuella, sellarVersion, parametrosRelevantes };
