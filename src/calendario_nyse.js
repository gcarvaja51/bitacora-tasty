'use strict';

// ── El calendario de la NYSE — UN SOLO SITIO ────────────────────────────────
//
// Por que existe, con nombre y fecha. El domingo 2026-09-06 el usuario miro el
// estado del daemon y dijo: "veo que el bot trabaja en horarios donde el
// mercado esta cerrado. el lunes por ejemplo no hay mercado". Tenia razon, y el
// hueco era mas grande de lo que parecia: el lunes 2026-09-07 era Labor Day y
// habia SIETE guards de "hay mercado hoy?" repartidos por el repo, de los
// cuales solo UNO —el isMarketHours() de server.js— conocia los feriados. Los
// otros seis preguntaban unicamente "es sabado o domingo?".
//
// Lo que iba a pasar ese lunes: el gamma_daemon ciclando siete horas y
// empujando los muros congelados del viernes SELLADOS CON LA HORA DE AHORA
// (levels.capturadoEn = new Date()), su vigilante exigiendole exitos y matando
// el proceso al tercer fallo, los 60 huecos de history.json rellenos de valores
// muertos (210 ciclos contra un cap de 60), y un snapshot de Net Liq fechado en
// un dia que no existe. El dinero no corria riesgo —los tres pipelines de SPX
// ya pasaban por isMarketHours()— pero el dato quedaba envenenado.
//
// LA REGLA QUE QUEDA: nadie vuelve a escribir su propio guard de dia de
// mercado. Se pregunta aca. Los datos viven en `calendario_nyse.json` —un solo
// archivo que actualizar cada enero— y `scripts/calendario_nyse.ps1` lee ESE
// MISMO archivo para el lado PowerShell, para que las dos mitades del sistema
// no puedan discrepar. Autopsia completa en docs/historial-bitacora.md.
//
// Todas las funciones aceptan un `ahora` opcional (Date o 'YYYY-MM-DD') para
// poder probarlas contra una fecha fija en vez de contra el reloj.

const fs = require('fs');
const path = require('path');

const RUTA_DATOS = path.join(__dirname, 'calendario_nyse.json');

// Se lee al cargar el modulo y se deja reventar si falta: un calendario que no
// carga tiene que tumbar el arranque, no degradarse en silencio a "todos los
// dias son habiles". Lo cubre scripts/pruebas.js, y el arranque del servidor es
// lo primero que corre el hook de pre-push.
const DATOS = JSON.parse(fs.readFileSync(RUTA_DATOS, 'utf8'));

const FERIADOS    = new Set(DATOS.feriados);
const MEDIOS_DIAS = new Set(DATOS.mediosDias);
const HASTA       = DATOS.hasta;

const APERTURA_MIN         = 9 * 60 + 30;  // 9:30 am ET
const CIERRE_MIN           = 16 * 60;      // 4:00 pm ET
const CIERRE_MEDIO_DIA_MIN = 13 * 60;      // 1:00 pm ET

// ── Hora del Este, sin depender del TZ de la maquina ────────────────────────
//
// OJO al patron: NO se hace new Date(x.toLocaleString(...)) para despues leer
// .getDay()/.getHours() sobre ese resultado — eso solo da la hora ET correcta
// si el timezone LOCAL del proceso es UTC (cierto en Railway, falso en el
// Windows del usuario). Se extraen los componentes como texto.

function fechaET(ahora = new Date()) {
  return ahora.toLocaleString('en-CA', { timeZone: 'America/New_York' }).slice(0, 10);
}

function minutosET(ahora = new Date()) {
  const etStr = ahora.toLocaleString('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
  });
  let [hora, min] = etStr.split(':').map(Number);
  if (hora === 24) hora = 0;   // en-US con hour12:false devuelve 24 a medianoche
  return hora * 60 + min;
}

// Acepta indistintamente un Date o un 'YYYY-MM-DD' ya resuelto en ET.
function normalizarFecha(ahora = new Date()) {
  return typeof ahora === 'string' ? ahora : fechaET(ahora);
}

// El dia de la semana se deriva de la FECHA ET ya resuelta, no de una segunda
// consulta a Intl: dos llamadas separadas pueden caer a los dos lados de la
// medianoche y contestar sobre dias distintos.
function esFinDeSemana(ahora = new Date()) {
  const dow = new Date(normalizarFecha(ahora) + 'T12:00:00Z').getUTCDay(); // 0=dom, 6=sab
  return dow === 0 || dow === 6;
}

function esFeriado(ahora = new Date()) {
  return FERIADOS.has(normalizarFecha(ahora));
}

// Medio dia = la campana suena a la 1:00pm ET. NO es un dia cerrado.
function esMedioDia(ahora = new Date()) {
  return MEDIOS_DIAS.has(normalizarFecha(ahora));
}

let _avisoCalendario = false;
// Pasada la fecha `hasta`, este modulo deja de reconocer feriados y el sistema
// volveria a operar un 1 de enero sin avisar — que es exactamente el modo de
// falla silencioso que se quiso eliminar. El aviso lo hace ruidoso.
function avisarSiCalendarioVencido(fecha) {
  if (fecha > HASTA && !_avisoCalendario) {
    _avisoCalendario = true;
    console.warn('[MERCADO] El calendario NYSE llega hasta ' + HASTA + ' y hoy es ' + fecha +
      ': de aqui en adelante NO se detectan feriados. Hay que extender src/calendario_nyse.json.');
  }
}

// `null` = hay mercado. Si no, dice POR QUE — para poder loguear el motivo real
// en vez de un "fuera_de_horario" que no distingue un domingo de Labor Day.
function motivoCierre(ahora = new Date()) {
  const fecha = normalizarFecha(ahora);
  avisarSiCalendarioVencido(fecha);
  if (esFinDeSemana(fecha)) return 'fin_de_semana';
  if (FERIADOS.has(fecha))  return 'feriado';
  return null;
}

// Abre hoy la NYSE? (dia habil y no feriado — no dice nada de la hora)
function esDiaDeMercado(ahora = new Date()) {
  return motivoCierre(ahora) === null;
}

function horaCierreMin(ahora = new Date()) {
  return esMedioDia(ahora) ? CIERRE_MEDIO_DIA_MIN : CIERRE_MIN;
}

// La campana: 9:30 ET hasta el cierre (4:00pm, o 1:00pm en medio dia).
function enHorarioDeMercado(ahora = new Date()) {
  const fecha = normalizarFecha(ahora);
  if (!esDiaDeMercado(fecha)) return false;
  const m = minutosET(ahora);
  return m >= APERTURA_MIN && m < horaCierreMin(fecha);
}

// Ventana propia en minutos desde la medianoche ET, para los procesos que no
// van de campana a campana (el daemon arranca a las 9:00 y estira hasta 16:05).
// Exige dia de mercado igual: tener ventana propia no es excusa para correr un
// feriado. En medio dia el final se recorta las mismas 3 horas que se adelanta
// el cierre, salvo que quien llama diga lo contrario.
function enVentanaET(desdeMin, hastaMin, opciones) {
  const o = opciones || {};
  const finInclusivo    = o.finInclusivo    !== undefined ? o.finInclusivo    : true;
  const recortarMedioDia = o.recortarMedioDia !== undefined ? o.recortarMedioDia : true;
  const ahora = o.ahora || new Date();

  const fecha = normalizarFecha(ahora);
  if (!esDiaDeMercado(fecha)) return false;

  let fin = hastaMin;
  if (recortarMedioDia && esMedioDia(fecha)) fin = hastaMin - (CIERRE_MIN - CIERRE_MEDIO_DIA_MIN);

  const m = minutosET(ahora);
  return m >= desdeMin && (finInclusivo ? m <= fin : m < fin);
}

function sumarDias(fecha, n) {
  const d = new Date(fecha + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// El proximo dia en que la NYSE abre, ESTRICTAMENTE posterior a `desde`. Es lo
// que necesitan el 1DTE (que un viernes apunta al lunes, y si el lunes es
// feriado al martes) y el calendario economico. 14 iteraciones cubren cualquier
// racimo de feriados; si no encuentra ninguno el calendario esta roto y conviene
// que reviente, no que devuelva un sabado.
function siguienteDiaDeMercado(desde = new Date()) {
  let fecha = normalizarFecha(desde);
  for (let i = 0; i < 14; i++) {
    fecha = sumarDias(fecha, 1);
    if (esDiaDeMercado(fecha)) return fecha;
  }
  throw new Error('[MERCADO] No se encontro dia de mercado en los 14 dias siguientes a ' + normalizarFecha(desde));
}

// Para health checks y para la Torre: en que estado esta el calendario.
function estado(ahora = new Date()) {
  const fecha = normalizarFecha(ahora);
  const hayMercado = esDiaDeMercado(fecha);
  return {
    fecha,
    hoyHayMercado: hayMercado,
    motivoCierre: motivoCierre(fecha),
    esMedioDia: esMedioDia(fecha),
    enHorarioDeMercado: typeof ahora === 'string' ? null : enHorarioDeMercado(ahora),
    proximoDiaDeMercado: hayMercado ? fecha : siguienteDiaDeMercado(fecha),
    calendarioHasta: HASTA,
    calendarioVencido: fecha > HASTA,
    feriados: FERIADOS.size,
    mediosDias: MEDIOS_DIAS.size,
  };
}

module.exports = {
  // consultas
  esDiaDeMercado, enHorarioDeMercado, enVentanaET, motivoCierre,
  esFinDeSemana, esFeriado, esMedioDia, siguienteDiaDeMercado, estado,
  // utilidades de hora ET
  fechaET, minutosET, horaCierreMin,
  // datos crudos (para pruebas y para quien necesite recorrerlos)
  FERIADOS, MEDIOS_DIAS, HASTA, RUTA_DATOS,
  APERTURA_MIN, CIERRE_MIN, CIERRE_MEDIO_DIA_MIN,
};
