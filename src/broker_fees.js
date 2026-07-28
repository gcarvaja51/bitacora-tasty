'use strict';

// Estimador de comisiones reales de Tradier (2026-07-28, a pedido del usuario:
// "no estamos cargando los costos del broker... para que esto sea lo mas real
// posible"). La API de Tradier NO expone comision por orden — se probaron
// GET /orders, GET /accounts/.../gainloss y GET /accounts/.../history (esta
// ultima devuelve null en el sandbox) y ninguna trae un campo de comision;
// las cuentas reales tampoco la itemizan por orden via API. Por eso esto es
// un CALCULO puro sobre la tarifa publicada, no un dato que se pueda leer del
// broker — no hay forma de "traerlo", solo de aplicarlo.
//
// Fuente: https://tradier.com/individuals/pricing (verificado 2026-07-28).
// El usuario esta en la cuenta demo/sandbox, sin plan pago elegido todavia —
// se asume el plan **Lite** (gratis, el que aplica por defecto sin upgrade):
//   - Opciones equity/ETF: $0.35/contrato, $0 base
//   - Opciones de indice (SPX incluido): $0.35/contrato base
//   - SPX especificamente carga ademas un fee de "single listed index option"
//     de $0.60/contrato
//   - Clearing: $0.0775/contrato
//   - ORF (Options Regulatory Fee): $0.02/contrato
// Total por contrato por transaccion (apertura O cierre, no ambas):
//   SPX:    0.35 + 0.60 + 0.0775 + 0.02 = 1.0475 -> redondeado a $1.05
//   Equity: 0.35 + 0.0775 + 0.02        = 0.4475 -> redondeado a $0.45
// Omitido a proposito: la SEC fee (proceeds-based, ~$0.0000206 por $1
// vendido — submilesima de dolar en este tamano de cuenta, no justifica la
// complejidad de necesitar el fill price a mano solo para esto) y el max de
// $15/leg de clearing (jamas se alcanza con 1-4 contratos).
const SPX_FEE_PER_CONTRACT_PER_LEG    = 1.05;
const EQUITY_FEE_PER_CONTRACT_PER_LEG = 0.45;

// Numero de patas segun la estrategia — Iron Condor y el Condor de debito son
// las unicas de 4 patas en este sistema, el resto (verticales direccionales y
// de reversion) son de 2.
function legsForStrategy(strategy) {
  if (strategy === 'IRON_CONDOR' || strategy === 'DEBIT_PUT_CONDOR') return 4;
  return 2;
}

// Comision estimada de un trade SPX 0DTE/1DTE (tradier_executions.json).
// Simplificacion conocida: siempre asume ida y vuelta (abrir + cerrar) para
// una ejecucion 'closed' — este sistema cierra activamente todo por TP/SL/
// stop tecnico/tiempo (nunca deja expirar sin mandar una orden de cierre en
// la practica, ver monitores de server.js), asi que esa asuncion es realista
// para el patron de trading actual, aunque no se puede distinguir con
// certeza absoluta un 'MANUAL' que en realidad fue vencimiento sin trade.
function estimateSpxCommission(ex) {
  const legs      = legsForStrategy(ex.strategy);
  const contracts = ex.contracts || 1;
  const transacciones = ex.status === 'closed' ? 2 : 1; // 1 = solo la apertura ya ocurrida
  return +(SPX_FEE_PER_CONTRACT_PER_LEG * legs * contracts * transacciones).toFixed(2);
}

// Comision estimada de un ciclo de la Rueda (wheel_trading_executions.json).
// Aproximacion, no exacta: usa ex.rollCount (cada roll exitoso = cerrar la
// pata vieja + abrir la nueva, 2 transacciones) mas la entrada inicial (1),
// mas 1 transaccion extra si el ciclo termino en un roll con reapertura
// fallida (closeReason:'ROLL_REAPERTURA_FALLIDA') — ese caso cerro la pata
// vieja de verdad (una transaccion real) pero rollCount nunca se incremento
// porque la reapertura no llego a confirmarse. No modela la venta de la
// Covered Call ni sus rolls por separado (STO_CALL/ROLL_CALL) — ningun ciclo
// real llego a esa fase todavia al momento de escribir esto.
function estimateWheelCommission(ex) {
  const contracts = (ex.leg && ex.leg.contracts) || 1;
  let transacciones = 1 + (ex.rollCount || 0) * 2;
  if (ex.closeReason === 'ROLL_REAPERTURA_FALLIDA') transacciones += 1;
  return +(EQUITY_FEE_PER_CONTRACT_PER_LEG * contracts * transacciones).toFixed(2);
}

module.exports = {
  SPX_FEE_PER_CONTRACT_PER_LEG,
  EQUITY_FEE_PER_CONTRACT_PER_LEG,
  legsForStrategy,
  estimateSpxCommission,
  estimateWheelCommission,
};
