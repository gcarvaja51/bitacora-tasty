// ══════════════════════════════════════════════════════════════════
//  IMPUESTOS — Hoja de trabajo fiscal Colombia
// ══════════════════════════════════════════════════════════════════
//
//  Convierte el P&L realizado de la bitácora en la información que exige
//  la DIAN para la declaración de renta de persona natural residente.
//
//  Marco normativo de referencia (documentado en detalle en
//  "01_Sigma/reporte impuestos financiero legal/"):
//
//   - Arts. 7, 9, 10 ET   → residente fiscal tributa renta mundial
//   - Art. 300 ET         → activo poseído 2+ años = ganancia ocasional
//   - Art. 314 ET         → tarifa ganancia ocasional 15% (Ley 2277/2022)
//   - Art. 241 ET         → tabla progresiva renta ordinaria 0%-39%
//   - Art. 336 ET         → límite 40% / 1.340 UVT a rentas exentas y
//                           deducciones especiales (NO aplica a costos)
//   - Art. 107 ET         → costos y gastos con relación de causalidad
//   - Art. 607 ET         → declaración de activos en el exterior (F-160)
//   - Arts. 592, 594-3 ET → topes de obligación de declarar
//   - Art. 254 ET         → descuento por impuestos pagados en el exterior
//   - Arts. 147, 330 ET   → compensación de pérdidas, 12 años, misma cédula
//
//  ⚠️ ADVERTENCIA DE ALCANCE
//  Esto es una hoja de trabajo, NO una declaración. Los números salen del
//  feed de Tastytrade y de supuestos configurables. Antes de declarar hay
//  que validarlos con contador público. Ver los "puntos grises" que el
//  propio módulo marca en `advertencias`.
//
// ══════════════════════════════════════════════════════════════════

// ── Constantes fiscales ────────────────────────────────────────────

// Valor de la UVT por año. Fuente: resoluciones DIAN.
// OJO: los topes de la obligación de declarar se miden con la UVT del AÑO
// GRAVABLE, no la del año en que se presenta la declaración.
const UVT = {
  2022: 38004,
  2023: 42412,
  2024: 47065,
  2025: 49799,
  2026: 52374,   // Resolución DIAN 000187 del 28-nov-2025
};

// Tabla del art. 241 ET. Rangos en UVT, tarifa marginal, impuesto acumulado
// de los rangos anteriores (también en UVT).
const TABLA_241 = [
  { desde: 0,      hasta: 1090,     tarifa: 0.00, acum: 0     },
  { desde: 1090,   hasta: 1700,     tarifa: 0.19, acum: 0     },
  { desde: 1700,   hasta: 4100,     tarifa: 0.28, acum: 116   },
  { desde: 4100,   hasta: 8670,     tarifa: 0.33, acum: 788   },
  { desde: 8670,   hasta: 18970,    tarifa: 0.35, acum: 2296  },
  { desde: 18970,  hasta: 31000,    tarifa: 0.37, acum: 5901  },
  { desde: 31000,  hasta: Infinity, tarifa: 0.39, acum: 10352 },
];

const TARIFA_GANANCIA_OCASIONAL = 0.15;  // Art. 314 ET (Ley 2277/2022)

// Art. 300 ET — el corte que separa renta ordinaria de ganancia ocasional.
// 730 días = 2 años. Para trading de opciones esto NUNCA se alcanza.
const DIAS_GANANCIA_OCASIONAL = 730;

// Topes de obligación de declarar (arts. 592, 594-3 ET), en UVT
const TOPES_DECLARAR = {
  patrimonioBruto:  4500,
  ingresosBrutos:   1400,
  consumosTarjeta:  1400,
  comprasTotales:   1400,
  consignaciones:   1400,
};

// Umbrales del Formulario 160 (art. 607 ET), en UVT
const TOPES_ACTIVOS_EXTERIOR = {
  presentar:   2000,   // activos en el exterior > 2.000 UVT al 1 de enero
  discriminar: 3580,   // > 3.580 UVT → activo por activo
};

// Límites de la cédula general (art. 336 ET)
const LIMITE_RENTAS_EXENTAS_PCT = 0.40;
const LIMITE_RENTAS_EXENTAS_UVT = 1340;

// Deducciones que quedan FUERA del límite del 40% / 1.340 UVT
const DEDUCCION_DEPENDIENTE_UVT     = 72;   // por dependiente
const MAX_DEPENDIENTES              = 4;

// Retención de EEUU sobre dividendos para no residentes.
// Colombia NO tiene tratado vigente con EEUU, así que el W-8BEN no la baja.
const RETENCION_USA_DIVIDENDOS = 0.30;

// ── Utilidades ─────────────────────────────────────────────────────

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round0 = (n) => Math.round(Number(n) || 0);

function uvtDe(year) {
  return UVT[year] || UVT[Math.max(...Object.keys(UVT).map(Number))];
}

/**
 * Impuesto de renta según la tabla del art. 241 ET.
 * La tarifa es MARGINAL: solo se aplica al exceso sobre el límite inferior
 * del rango, sumando el impuesto acumulado de los rangos anteriores.
 *
 * @param {number} baseCOP  renta líquida gravable en pesos
 * @param {number} year     año gravable (define la UVT)
 * @returns {{impuestoCOP:number, baseUVT:number, tarifaMarginal:number, rango:object}}
 */
function impuestoRenta241(baseCOP, year) {
  const uvt = uvtDe(year);
  const baseUVT = (Number(baseCOP) || 0) / uvt;
  if (baseUVT <= 0) {
    return { impuestoCOP: 0, baseUVT: 0, tarifaMarginal: 0, rango: TABLA_241[0] };
  }
  const rango = TABLA_241.find(r => baseUVT > r.desde && baseUVT <= r.hasta) || TABLA_241[TABLA_241.length - 1];
  const impuestoUVT = (baseUVT - rango.desde) * rango.tarifa + rango.acum;
  return {
    impuestoCOP:    round0(impuestoUVT * uvt),
    baseUVT:        round2(baseUVT),
    tarifaMarginal: rango.tarifa,
    rango,
  };
}

/**
 * Clasificación fiscal de una operación cerrada según el tiempo de tenencia.
 * Art. 300 ET.
 */
function clasificarOperacion(durationDays) {
  const d = Number(durationDays) || 0;
  return d >= DIAS_GANANCIA_OCASIONAL ? 'ganancia_ocasional' : 'renta_ordinaria';
}

// ── TRM ────────────────────────────────────────────────────────────

/**
 * Busca la TRM aplicable a una fecha en un mapa {'YYYY-MM-DD': valor}.
 * Si la fecha no existe (fin de semana, festivo), retrocede hasta 7 días
 * buscando la última TRM vigente — que es exactamente cómo funciona la TRM:
 * la del viernes rige el fin de semana.
 */
function trmDe(fecha, trmMap) {
  if (!fecha || !trmMap) return null;
  let d = new Date(fecha + 'T12:00:00Z');
  for (let i = 0; i < 8; i++) {
    const key = d.toISOString().slice(0, 10);
    if (trmMap[key]) return trmMap[key];
    d = new Date(d.getTime() - 86400000);
  }
  return null;
}

// ── Dividendos ─────────────────────────────────────────────────────

/**
 * Extrae dividendos del feed crudo de Tastytrade.
 *
 * Tastytrade parte cada dividendo en DOS asientos con el mismo
 * `transaction-sub-type: "Dividend"` — el bruto (Credit) y la retención
 * de impuesto (Debit, 30% para no residentes). Verificado contra un caso
 * real (GAP, 29-jul-2026: +17.50 bruto, −5.25 retención = exactamente 30%).
 *
 * Se consolidan por fecha+símbolo en un solo registro con bruto, retención
 * y neto separados — la retención es la que sustenta el descuento del
 * art. 254 ET, así que no puede quedar mezclada en el neto.
 */
function extraerDividendos(items = [], year) {
  const porClave = new Map();

  for (const tx of items) {
    const subType = tx['transaction-sub-type'] || '';
    const desc    = tx.description || '';
    const esDiv   = /dividend/i.test(subType) || /dividend/i.test(desc);
    if (!esDiv) continue;

    const fecha = (tx['transaction-date'] || '').slice(0, 10);
    if (!fecha || Number(fecha.slice(0, 4)) !== year) continue;

    const symbol = tx['underlying-symbol'] || tx.symbol || '—';
    const clave  = `${fecha}|${symbol}`;

    // El signo importa: el mismo sub-type trae el crédito y la retención.
    // Un Math.abs() acá haría que la retención SUME en vez de restar — es
    // el error que se corrigió en la auditoría del 2026-08-03.
    const efecto = tx['net-value-effect'] || tx.value_effect || '';
    const bruto  = parseFloat(tx['net-value'] ?? tx.value ?? 0);
    const monto  = /debit/i.test(efecto) ? -Math.abs(bruto) : Math.abs(bruto);

    if (!porClave.has(clave)) {
      porClave.set(clave, { fecha, symbol, bruto: 0, retencion: 0, neto: 0 });
    }
    const reg = porClave.get(clave);
    if (monto >= 0) reg.bruto     += monto;
    else            reg.retencion += Math.abs(monto);
    reg.neto = round2(reg.bruto - reg.retencion);
  }

  return [...porClave.values()]
    .map(d => ({ ...d, bruto: round2(d.bruto), retencion: round2(d.retencion) }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
}

// ── Comisiones y fees ──────────────────────────────────────────────

/**
 * Suma comisiones y fees del año desde el feed crudo.
 *
 * ⚠️ NO restar esto del P&L. El `net-value` de Tastytrade —del que sale el
 * `pnl` de cada estrategia— YA viene neto de comisiones y fees. Este total
 * es informativo y documental: sirve para saber cuánto se pagó al broker
 * y para soportar el rubro ante la DIAN, no para volver a descontarlo.
 * Restarlo otra vez sería deducir dos veces el mismo costo.
 */
function sumarComisiones(items = [], year) {
  let commission = 0, fees = 0, n = 0;
  for (const tx of items) {
    const fecha = (tx['transaction-date'] || '').slice(0, 10);
    if (!fecha || Number(fecha.slice(0, 4)) !== year) continue;
    const c = parseFloat(tx.commission || 0);
    const f = parseFloat(tx['clearing-fees'] || 0)
            + parseFloat(tx['regulatory-fees'] || 0)
            + parseFloat(tx['proprietary-index-option-fees'] || 0);
    if (c || f) n++;
    commission += c;
    fees       += f;
  }
  return { commission: round2(commission), fees: round2(fees), total: round2(commission + fees), transacciones: n };
}

// ── Núcleo: construcción de la hoja fiscal ─────────────────────────

/**
 * Construye la hoja de trabajo fiscal de un año gravable.
 *
 * @param {object}   p
 * @param {Array}    p.strategies   round-trips cerrados (metrics.strategies)
 * @param {Array}    p.items        transacciones crudas del feed
 * @param {Array}    p.nlvHistory   [{date, nlv}] snapshots de Net Liq
 * @param {object}   p.trmMap       {'YYYY-MM-DD': trm}
 * @param {number}   p.year         año gravable
 * @param {object}   p.config       supuestos del contribuyente
 * @param {Array}    p.gastos       registro de gastos deducibles
 * @param {Array}    p.perdidas     pérdidas fiscales de años anteriores
 */
function buildImpuestos({
  strategies = [],
  items      = [],
  nlvHistory = [],
  trmMap     = {},
  year,
  config     = {},
  gastos     = [],
  perdidas   = [],
} = {}) {

  const uvt         = uvtDe(year);
  const advertencias = [];
  const hoy         = new Date().toISOString().slice(0, 10);
  const anioEnCurso = Number(hoy.slice(0, 4)) === year;

  // ── 1. Operaciones cerradas dentro del año gravable ──────────────
  // Regla de corte: solo entra lo CERRADO entre el 1-ene y el 31-dic.
  // Una posición abierta al 31 de diciembre no realizó utilidad ni pérdida
  // fiscal — pero sí forma parte del patrimonio a esa fecha.
  const operaciones = [];
  let sinTRM = 0;

  for (const s of strategies) {
    const cierre = (s.closeDate || '').slice(0, 10);
    if (!cierre || Number(cierre.slice(0, 4)) !== year) continue;
    // Un Roll no es un cierre: deja la posición viva. No realiza resultado.
    if (s.stratType === 'Roll') continue;

    const trm = trmDe(cierre, trmMap);
    if (!trm) sinTRM++;

    const clasificacion = clasificarOperacion(s.durationDays);
    const pnlUSD = round2(s.pnl);

    operaciones.push({
      key:           s.key || `${s.underlying}_${cierre}`,
      underlying:    s.underlying || '—',
      stratType:     s.stratType || 'Otro',
      openDate:      (s.openDate || '').slice(0, 10),
      closeDate:     cierre,
      durationDays:  Number(s.durationDays) || 0,
      qty:           Number(s.qty) || 0,
      openValue:     round2(s.openValue),
      closeValue:    round2(s.closeValue),
      pnlUSD,
      trm:           trm ? round2(trm) : null,
      pnlCOP:        trm ? round0(pnlUSD * trm) : null,
      clasificacion,
      partialClose:  !!s.partialClose,
    });
  }

  operaciones.sort((a, b) => a.closeDate.localeCompare(b.closeDate));

  if (sinTRM > 0) {
    advertencias.push({
      nivel: 'alta',
      titulo: 'Operaciones sin TRM',
      detalle: `${sinTRM} operación(es) no encontraron TRM para su fecha de cierre. ` +
               `Los totales en pesos están incompletos. Refrescar la serie de TRM.`,
    });
  }

  // ── 2. Totales por clasificación fiscal ──────────────────────────
  const acumular = (arr) => arr.reduce((acc, o) => {
    acc.usd += o.pnlUSD;
    acc.cop += (o.pnlCOP || 0);
    acc.n   += 1;
    if (o.pnlUSD >= 0) {
      acc.ganadoras++;
      acc.utilidadesUSD += o.pnlUSD;
      acc.utilidadesCOP += (o.pnlCOP || 0);
    } else {
      acc.perdedoras++;
      acc.perdidasUSD += Math.abs(o.pnlUSD);
      acc.perdidasCOP += Math.abs(o.pnlCOP || 0);
    }
    return acc;
  }, { usd: 0, cop: 0, n: 0, ganadoras: 0, perdedoras: 0,
       utilidadesUSD: 0, perdidasUSD: 0, utilidadesCOP: 0, perdidasCOP: 0 });

  const opsOrdinaria = operaciones.filter(o => o.clasificacion === 'renta_ordinaria');
  const opsOcasional = operaciones.filter(o => o.clasificacion === 'ganancia_ocasional');

  const rentaOrdinaria    = acumular(opsOrdinaria);
  const gananciaOcasional = acumular(opsOcasional);

  [rentaOrdinaria, gananciaOcasional].forEach(t => {
    t.usd = round2(t.usd); t.cop = round0(t.cop);
    t.utilidadesUSD = round2(t.utilidadesUSD); t.perdidasUSD = round2(t.perdidasUSD);
    t.utilidadesCOP = round0(t.utilidadesCOP); t.perdidasCOP = round0(t.perdidasCOP);
  });

  // ── 3. Dividendos y retención en EEUU (art. 254 ET) ──────────────
  const dividendos = extraerDividendos(items, year);
  const divTotales = dividendos.reduce((a, d) => {
    const trm = trmDe(d.fecha, trmMap);
    a.brutoUSD     += d.bruto;
    a.retencionUSD += d.retencion;
    a.netoUSD      += d.neto;
    a.brutoCOP     += trm ? d.bruto * trm : 0;
    a.retencionCOP += trm ? d.retencion * trm : 0;
    return a;
  }, { brutoUSD: 0, retencionUSD: 0, netoUSD: 0, brutoCOP: 0, retencionCOP: 0 });

  divTotales.brutoUSD     = round2(divTotales.brutoUSD);
  divTotales.retencionUSD = round2(divTotales.retencionUSD);
  divTotales.netoUSD      = round2(divTotales.netoUSD);
  divTotales.brutoCOP     = round0(divTotales.brutoCOP);
  divTotales.retencionCOP = round0(divTotales.retencionCOP);
  divTotales.tarifaEfectiva = divTotales.brutoUSD > 0
    ? round2((divTotales.retencionUSD / divTotales.brutoUSD) * 100) : 0;

  if (divTotales.retencionUSD > 0) {
    advertencias.push({
      nivel: 'info',
      titulo: 'Descuento art. 254 ET disponible',
      detalle: `Hay USD ${divTotales.retencionUSD.toFixed(2)} de retención en EEUU sobre dividendos. ` +
               `Es descontable del impuesto colombiano, pero exige el Formulario 1042-S del broker ` +
               `como certificado fiscal. Sin ese documento la DIAN rechaza el descuento.`,
    });
  }

  // ── 4. Comisiones y fees ─────────────────────────────────────────
  const comisiones = sumarComisiones(items, year);

  // ── 5. Patrimonio al 31 de diciembre ─────────────────────────────
  // Saldo de la cuenta = efectivo + valor de mercado de posiciones abiertas.
  // Se toma el último snapshot de NLV del año gravable.
  const snapsDelAnio = (nlvHistory || [])
    .filter(h => (h.date || '').slice(0, 4) === String(year))
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  const ultimoSnap = snapsDelAnio[snapsDelAnio.length - 1] || null;
  const fechaCorte = anioEnCurso ? (ultimoSnap?.date || hoy) : `${year}-12-31`;
  const trmCorte   = trmDe(ultimoSnap?.date || fechaCorte, trmMap);
  const nlvUSD     = ultimoSnap ? round2(ultimoSnap.nlv) : 0;

  const patrimonio = {
    fecha:        ultimoSnap?.date || null,
    esProyeccion: anioEnCurso,
    nlvUSD,
    trm:          trmCorte ? round2(trmCorte) : null,
    nlvCOP:       trmCorte ? round0(nlvUSD * trmCorte) : null,
    snapshots:    snapsDelAnio.length,
  };

  if (!ultimoSnap) {
    advertencias.push({
      nivel: 'alta',
      titulo: 'Sin snapshot de patrimonio',
      detalle: `No hay snapshots de Net Liq para ${year}. El patrimonio al cierre no se puede ` +
               `establecer y sin él no se puede evaluar el tope de 4.500 UVT ni el Formulario 160.`,
    });
  }

  advertencias.push({
    nivel: 'media',
    titulo: 'Valor patrimonial en moneda extranjera — zona gris',
    detalle: `Acá se convierte el saldo a la TRM de la fecha de corte, que es lo intuitivo. ` +
             `Pero los arts. 269 y 288 ET dicen que el valor patrimonial se fija a la TRM del ` +
             `RECONOCIMIENTO INICIAL y que la diferencia en cambio no tiene efecto fiscal hasta ` +
             `la enajenación. Aplicarlo a una cuenta de broker con movimientos permanentes ` +
             `requiere criterio de contador. Punto crítico a validar.`,
  });

  // ── 6. Gastos deducibles (art. 107 ET) ───────────────────────────
  // Caja 1: NO tienen el límite del 40% / 1.340 UVT del art. 336.
  const gastosDelAnio = (gastos || []).filter(g =>
    (g.fecha || '').slice(0, 4) === String(year) && g.deducible !== false
  );

  const gastosTotal = gastosDelAnio.reduce((a, g) => {
    const cop = Number(g.valorCOP) || 0;
    a.cop += cop;
    a.porCategoria[g.categoria || 'Sin categoría'] =
      (a.porCategoria[g.categoria || 'Sin categoría'] || 0) + cop;
    if (!g.numeroSoporte) a.sinSoporte++;
    return a;
  }, { cop: 0, porCategoria: {}, sinSoporte: 0 });
  gastosTotal.cop = round0(gastosTotal.cop);
  gastosTotal.n   = gastosDelAnio.length;

  if (gastosTotal.sinSoporte > 0) {
    advertencias.push({
      nivel: 'alta',
      titulo: 'Gastos sin soporte documental',
      detalle: `${gastosTotal.sinSoporte} gasto(s) sin número de soporte. Un gasto sin factura ` +
               `electrónica o documento soporte (Resolución 000167 de 2021) es legalmente ` +
               `deducible pero prácticamente rechazable en fiscalización.`,
    });
  }

  // ── 7. Renta líquida y liquidación del impuesto ──────────────────
  const otrosIngresosCOP        = Number(config.otrosIngresosCOP) || 0;
  const dependientes            = Math.min(Number(config.dependientes) || 0, MAX_DEPENDIENTES);
  const deduccionesEspecialesCOP = Number(config.deduccionesEspecialesCOP) || 0;

  // Compensación de pérdidas de años anteriores — solo misma cédula (art. 330 ET)
  const perdidasDisponiblesCOP = (perdidas || [])
    .filter(p => Number(p.anoOrigen) < year && (Number(p.saldoPendienteCOP) || 0) > 0)
    .reduce((a, p) => a + (Number(p.saldoPendienteCOP) || 0), 0);

  // Renta líquida de la cédula: utilidad del trading − costos y gastos
  const rentaLiquidaTradingCOP = rentaOrdinaria.cop - gastosTotal.cop;

  // Solo se compensa contra utilidad positiva de la misma cédula
  const compensacionAplicadaCOP = rentaLiquidaTradingCOP > 0
    ? Math.min(perdidasDisponiblesCOP, rentaLiquidaTradingCOP)
    : 0;

  const rentaDepuradaCOP = Math.max(
    0,
    rentaLiquidaTradingCOP - compensacionAplicadaCOP + otrosIngresosCOP
  );

  // Caja 2 — límite del art. 336: 40% de la renta depurada, tope 1.340 UVT
  const topeRentasExentasCOP = Math.min(
    rentaDepuradaCOP * LIMITE_RENTAS_EXENTAS_PCT,
    LIMITE_RENTAS_EXENTAS_UVT * uvt
  );
  const deduccionesEspecialesAplicadasCOP = Math.min(deduccionesEspecialesCOP, topeRentasExentasCOP);

  // Dependientes: FUERA del límite del 40% / 1.340 UVT
  const deduccionDependientesCOP = dependientes * DEDUCCION_DEPENDIENTE_UVT * uvt;

  const rentaLiquidaGravableCOP = Math.max(
    0,
    rentaDepuradaCOP - deduccionesEspecialesAplicadasCOP - deduccionDependientesCOP
  );

  const liq241 = impuestoRenta241(rentaLiquidaGravableCOP, year);

  // Ganancia ocasional: base y tarifa propias, fuera de la cédula general
  const baseGananciaOcasionalCOP = Math.max(0, gananciaOcasional.cop);
  const impuestoGananciaOcasionalCOP = round0(baseGananciaOcasionalCOP * TARIFA_GANANCIA_OCASIONAL);

  // Descuento art. 254 ET, topado al impuesto colombiano sobre esas mismas rentas
  const descuentoExteriorCOP = Math.min(divTotales.retencionCOP, liq241.impuestoCOP);

  const impuestoTotalCOP = Math.max(
    0,
    liq241.impuestoCOP - descuentoExteriorCOP + impuestoGananciaOcasionalCOP
  );

  const liquidacion = {
    rentaOrdinariaCOP:               rentaOrdinaria.cop,
    gastosDeduciblesCOP:             gastosTotal.cop,
    rentaLiquidaTradingCOP:          round0(rentaLiquidaTradingCOP),
    perdidasDisponiblesCOP:          round0(perdidasDisponiblesCOP),
    compensacionAplicadaCOP:         round0(compensacionAplicadaCOP),
    otrosIngresosCOP,
    rentaDepuradaCOP:                round0(rentaDepuradaCOP),
    topeRentasExentasCOP:            round0(topeRentasExentasCOP),
    deduccionesEspecialesCOP,
    deduccionesEspecialesAplicadasCOP: round0(deduccionesEspecialesAplicadasCOP),
    dependientes,
    deduccionDependientesCOP:        round0(deduccionDependientesCOP),
    rentaLiquidaGravableCOP:         round0(rentaLiquidaGravableCOP),
    baseUVT:                         liq241.baseUVT,
    tarifaMarginal:                  liq241.tarifaMarginal,
    impuestoRentaCOP:                liq241.impuestoCOP,
    baseGananciaOcasionalCOP:        round0(baseGananciaOcasionalCOP),
    tarifaGananciaOcasional:         TARIFA_GANANCIA_OCASIONAL,
    impuestoGananciaOcasionalCOP,
    descuentoExteriorCOP:            round0(descuentoExteriorCOP),
    impuestoTotalCOP:                round0(impuestoTotalCOP),
    tasaEfectiva: rentaDepuradaCOP > 0
      ? round2((impuestoTotalCOP / rentaDepuradaCOP) * 100) : 0,
  };

  if (deduccionesEspecialesCOP > topeRentasExentasCOP) {
    advertencias.push({
      nivel: 'media',
      titulo: 'Deducciones especiales topadas',
      detalle: `Se registraron $${round0(deduccionesEspecialesCOP).toLocaleString('es-CO')} en ` +
               `deducciones especiales pero el límite del art. 336 (40% / 1.340 UVT) solo permite ` +
               `$${round0(topeRentasExentasCOP).toLocaleString('es-CO')}. El exceso se pierde.`,
    });
  }

  // ── 8. Semáforo de obligaciones formales ─────────────────────────
  // Los topes se miden con la UVT del propio año gravable.
  //
  // "Ingresos brutos" acá es un PROXY: la suma de las operaciones ganadoras,
  // cada una a la TRM de su propia fecha de cierre. Convertir un total anual
  // en USD con una sola TRM daría un número bastante distinto — la TRM se
  // movió de ~3.650 a ~3.130 entre febrero y agosto de 2026.
  //
  // Es un proxy y no una cifra declarable: para un derivado no hay consenso
  // sobre qué es el "ingreso bruto" (¿la utilidad de las ganadoras? ¿el
  // valor nocional? ¿la prima recibida?). Sirve para el semáforo del tope
  // de 1.400 UVT, no para llenar una casilla.
  const ingresosBrutosCOP = Math.max(0, rentaOrdinaria.utilidadesCOP)
                          + Math.max(0, gananciaOcasional.utilidadesCOP)
                          + divTotales.brutoCOP
                          + otrosIngresosCOP;
  const patrimonioBrutoCOP = patrimonio.nlvCOP || 0;

  const chk = (valorCOP, topeUVT) => ({
    valorCOP: round0(valorCOP),
    topeUVT,
    topeCOP:  round0(topeUVT * uvt),
    supera:   valorCOP > topeUVT * uvt,
    pct:      topeUVT * uvt > 0 ? round2((valorCOP / (topeUVT * uvt)) * 100) : 0,
  });

  const obligaciones = {
    declararRenta: {
      patrimonioBruto: chk(patrimonioBrutoCOP, TOPES_DECLARAR.patrimonioBruto),
      ingresosBrutos:  chk(ingresosBrutosCOP,  TOPES_DECLARAR.ingresosBrutos),
      // Consumos, compras y consignaciones no los conoce la bitácora: son
      // datos bancarios. Se marcan como no evaluables para no dar un falso OK.
      noEvaluables: ['consumosTarjeta', 'comprasTotales', 'consignaciones'],
    },
    activosExterior: {
      presentarF160: chk(patrimonioBrutoCOP, TOPES_ACTIVOS_EXTERIOR.presentar),
      discriminar:   chk(patrimonioBrutoCOP, TOPES_ACTIVOS_EXTERIOR.discriminar),
    },
  };

  const obligadoDeclarar = obligaciones.declararRenta.patrimonioBruto.supera
                        || obligaciones.declararRenta.ingresosBrutos.supera;

  advertencias.push({
    nivel: 'media',
    titulo: '"Ingresos brutos" es un proxy, no una cifra declarable',
    detalle: `El tope de 1.400 UVT se evalúa acá sumando las operaciones ganadoras ` +
             `(cada una a la TRM de su fecha de cierre) más dividendos y otros ingresos. ` +
             `Para un derivado no hay consenso sobre qué es el "ingreso bruto" — si la utilidad ` +
             `de las ganadoras, el valor nocional o la prima recibida. Sirve para el semáforo, ` +
             `no para llenar una casilla del formulario.`,
  });

  advertencias.push({
    nivel: 'media',
    titulo: 'Topes que la bitácora no puede evaluar',
    detalle: `Consumos con tarjeta, compras totales y consignaciones (1.400 UVT cada uno) son ` +
             `datos bancarios que esta app no ve. El de consignaciones es el que más atrapa a ` +
             `traders: cada envío al broker y cada retiro suma, y no hace falta GANAR $73M — ` +
             `basta con MOVER $73M. Verificar contra extractos bancarios.`,
  });

  if (anioEnCurso) {
    advertencias.push({
      nivel: 'info',
      titulo: `${year} es el año en curso`,
      detalle: `Los totales son parciales y el impuesto es una proyección con lo cerrado hasta ` +
               `hoy. Sirve para provisionar, no para declarar.`,
    });
  }

  // ── 9. Provisión sugerida ────────────────────────────────────────
  // El broker del exterior NO practica retención colombiana: el 100% del
  // impuesto vence de golpe entre agosto y octubre. Encima el art. 807 ET
  // liquida un anticipo del año siguiente (75% a partir del 3er año).
  const anticipoPct = Number(config.anticipoPct) ?? 75;
  const anticipoCOP = round0(liquidacion.impuestoTotalCOP * (anticipoPct / 100));

  const provision = {
    impuestoCOP:      liquidacion.impuestoTotalCOP,
    anticipoPct,
    anticipoCOP,
    totalAPagarCOP:   liquidacion.impuestoTotalCOP + anticipoCOP,
    mensualSugeridoCOP: round0((liquidacion.impuestoTotalCOP + anticipoCOP) / 12),
  };

  if (provision.totalAPagarCOP > 0) {
    advertencias.push({
      nivel: 'alta',
      titulo: 'Anticipo de renta (art. 807 ET)',
      detalle: `Además del impuesto del año se liquida un anticipo del ${anticipoPct}% del año ` +
               `siguiente. El desembolso proyectado es ` +
               `$${provision.totalAPagarCOP.toLocaleString('es-CO')}, no solo ` +
               `$${liquidacion.impuestoTotalCOP.toLocaleString('es-CO')}. ` +
               `Tastytrade no retiene nada durante el año: todo vence junto.`,
    });
  }

  // ── 10. Resultado ────────────────────────────────────────────────
  const ordenNivel = { alta: 0, media: 1, info: 2 };
  advertencias.sort((a, b) => ordenNivel[a.nivel] - ordenNivel[b.nivel]);

  return {
    year,
    uvt,
    generadoEn: new Date().toISOString(),
    anioEnCurso,
    fechaCorte,

    resumen: {
      operaciones:        operaciones.length,
      pnlNetoUSD:         round2(rentaOrdinaria.usd + gananciaOcasional.usd),
      pnlNetoCOP:         round0(rentaOrdinaria.cop + gananciaOcasional.cop),
      rentaOrdinariaUSD:  rentaOrdinaria.usd,
      rentaOrdinariaCOP:  rentaOrdinaria.cop,
      gananciaOcasionalUSD: gananciaOcasional.usd,
      gananciaOcasionalCOP: gananciaOcasional.cop,
      obligadoDeclarar,
    },

    rentaOrdinaria,
    gananciaOcasional,
    operaciones,
    dividendos,
    dividendosTotales: divTotales,
    comisiones,
    patrimonio,
    gastos: { detalle: gastosDelAnio, totales: gastosTotal },
    perdidas,
    liquidacion,
    obligaciones,
    provision,
    advertencias,

    constantes: {
      UVT, TABLA_241, TARIFA_GANANCIA_OCASIONAL, DIAS_GANANCIA_OCASIONAL,
      TOPES_DECLARAR, TOPES_ACTIVOS_EXTERIOR,
      LIMITE_RENTAS_EXENTAS_PCT, LIMITE_RENTAS_EXENTAS_UVT,
      DEDUCCION_DEPENDIENTE_UVT, MAX_DEPENDIENTES, RETENCION_USA_DIVIDENDOS,
    },
  };
}

module.exports = {
  buildImpuestos,
  impuestoRenta241,
  clasificarOperacion,
  extraerDividendos,
  sumarComisiones,
  trmDe,
  UVT,
  TABLA_241,
  TARIFA_GANANCIA_OCASIONAL,
  DIAS_GANANCIA_OCASIONAL,
  TOPES_DECLARAR,
  TOPES_ACTIVOS_EXTERIOR,
};
