/*
 * Que es un INDICE y como se llama en Yahoo. Fuente unica.
 *
 * POR QUE EXISTE, con nombre y fecha: el 2026-09-02 SPX y VIX salian en el
 * donut de sectores como "Sin sector". Yahoo solo devuelve `sector` para
 * quoteType EQUITY, asi que un indice nunca lo va a traer — no es que falte el
 * dato, es que no aplica. La categoria correcta la tenemos que poner nosotros.
 *
 * Antes la lista de indices estaba escrita a mano dentro del endpoint
 * `/api/market-data/:symbol`, y ademas incompleta: VIX no estaba.
 */

const SECTOR_INDICES = 'Índices';

/*
 * Simbolo de Yahoo para cada indice. Los que llevan '^' NO se pueden pedir por
 * su ticker pelado — comprobado en vivo el 2026-09-02:
 *
 *   - `VIX`   devuelve una respuesta SIN precio (regularMarketPrice undefined).
 *     El bueno es `^VIX` -> "CBOE Volatility Index", 15.20. VIX no estaba
 *     mapeado, asi que /api/market-data/VIX venia vacio.
 *   - `NDX` estaba mapeado a `^IXIC`, que es el NASDAQ **Composite** (26.217).
 *     NDX es el NASDAQ-**100**: `^NDX`, 29.143. Eran dos indices distintos con
 *     un 11% de diferencia.
 */
const YAHOO = {
  SPX:  '^GSPC',   // S&P 500 — 7666.6
  SPXW: '^GSPC',   // las semanales del SPX cuelgan del mismo indice
  XSP:  '^XSP',    // S&P 500 Mini (1/10 del SPX) — 766.66
  VIX:  '^VIX',    // CBOE Volatility Index — 15.20
  VIXW: '^VIX',
  NDX:  '^NDX',    // NASDAQ-100 — 29143.33
  RUT:  '^RUT',    // Russell 2000 — 2953.17
  RUTW: '^RUT',
  DJX:  '^DJI',    // Dow Jones Industrial — 53061.95
};

/*
 * ETFs que replican un indice. No son indices tecnicamente —son fondos, y Yahoo
 * si los conoce— pero para el reparto por sector del portafolio interesa verlos
 * junto al indice que siguen, no en el sector de la gestora. Yahoo les da
 * quoteType ETF, no EQUITY, asi que tampoco traen `sector`: sin esto tambien
 * caian en "Sin sector".
 */
const ETFS_DE_INDICE = ['SPY', 'QQQ', 'IWM', 'DIA', 'VOO', 'VTI', 'VXX', 'UVXY'];

function esIndice(simbolo) {
  const s = String(simbolo || '').toUpperCase();
  return Object.prototype.hasOwnProperty.call(YAHOO, s) || ETFS_DE_INDICE.includes(s);
}

// El sector que hay que mostrar, o null si no es un indice y toca preguntarle a
// Yahoo como siempre.
function sectorDe(simbolo) {
  return esIndice(simbolo) ? SECTOR_INDICES : null;
}

// Como pedirselo a Yahoo. Un ticker que no esta en la tabla se pide tal cual:
// es lo que ya hacia el endpoint y vale para acciones y para los ETFs.
function simboloYahoo(simbolo) {
  const s = String(simbolo || '').toUpperCase();
  return YAHOO[s] || s;
}

module.exports = { SECTOR_INDICES, YAHOO, ETFS_DE_INDICE, esIndice, sectorDe, simboloYahoo };
