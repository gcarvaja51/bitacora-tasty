# CLAUDE.md — Bitácora Tasty

Dashboard de trading personal conectado a TastyTrade. Node.js/Express + vanilla JS (sin framework frontend).

## Deploy

- **Producción**: Railway — `web-production-23473.up.railway.app`
- **Repo**: `gcarvaja51/bitacora-tasty` (main → auto-deploy en Railway)
- **Local**: `npm run dev` (nodemon en puerto 3000)
- **Volumen Railway**: montado en `/data`, variable `RAILWAY_VOLUME_MOUNT_PATH`

## Archivos clave

| Archivo | Rol |
|---|---|
| `server.js` | Servidor Express, todos los endpoints `/api/*`, caché en memoria, lógica de notificaciones |
| `src/wheel.js` | Lógica pura de La Rueda: `buildWheelData(items, positions, underlyings)` |
| `src/tastytrade.js` | Cliente HTTP a la API de TastyTrade (auth, transacciones, posiciones, precios) |
| `src/metrics.js` | Cálculo de P&L, equity curve, calendar |
| `public/index.html` | SPA completa (~5000 líneas). Todo el frontend en un archivo |
| `public/sw.js` | Service worker PWA (network-first, versión actual: `bitacora-v5`) |

**Archivos sueltos sin usar (pendiente de revisar/limpiar):** `index.html` y
`spx_backtester.html` en la raíz del repo, y un `public/server.js` duplicado — no están
documentados en este archivo ni referenciados por `server.js` (el real, en la raíz). Parecen
prototipos previos al `Backtester SPX` actual dentro de `public/index.html`. No se tocaron
esta sesión — confirmar antes de borrar si tienen algo de valor.

## Persistencia de datos

```js
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
```

Archivos que viven en `DATA_DIR` (no en `__dirname`):
- `wheel_config.json` — lista de underlyings de La Rueda
- `nlv_history.json` — snapshots históricos de Net Liq
- `watchlist.json`, `trade_notes.json`, `playbooks.json`, etc.
- `spx_config.json` — pesos del playbook SPX, TP/SL, `tradierAutoExecute` (ver sección
  SPX 0DTE — un push a git **no** actualiza este archivo en Railway, hay que empujar el
  cambio también vía `POST /api/spx/config`)
- `spx_signals.json` — historial de señales SPX (últimas 50)

Estos archivos están en `.gitignore` excepto `wheel_config.json` y `nlv_history.json` (sirven como seed inicial).

## La Rueda (The Wheel)

Estrategia de opciones: CSP → Asignación → Covered Call, ciclando.

**Fases**: `CSP_ACTIVA` → `ACCIONES` → `CC_ACTIVA` → `IDLE`

**Tipos de eventos** (generados por `wheel.js`):
- `STO_PUT` / `BTC_PUT` — Sell/Buy to Close Put
- `STO_CALL` / `BTC_CALL` — Sell/Buy to Close Call
- `ROLL` — BTC + STO mismo día (consolidado automáticamente, puts y calls)
- `STOCK_BUY` / `STOCK_SELL` / `ASSIGNED`
- `DIVIDENDO` (agregado 2026-07-09) — dividendos en efectivo, ver nota abajo

**Underlyings activos**: JBLU, NU, GAP, SOFI (en `wheel_config.json`)

**Feature 2026-07-09 — dividendos ahora aparecen en la Rueda:** antes `buildWheelData`
solo procesaba `transaction-type` `'Trade'`/`'Receive Deliver'` — un dividendo de Tastytrade
(`'Money Movement'`) quedaba completamente afuera del pipeline, invisible en el timeline.
Se agregó `'Money Movement'` al filtro inicial y un branch nuevo que detecta dividendos por
`transaction-sub-type` o `description` conteniendo "dividend" (case-insensitive). **Sin
confirmar contra un caso real todavía** — no hay ningún dividendo acreditado en la cuenta
para validar el nombre exacto del campo que usa Tastytrade; el matcheo tolerante (por
descripción, no un valor exacto) es la mitigación mientras no haya un ejemplo real. Revisar
en cuanto se acredite el primero.
**Ajuste 2026-07-09 (mismo día, a pedido explícito del usuario):** el dividendo **sí reduce
el costo base** — mismo patrón que `STO_CALL`: se suma a `totalPremium` (para que un
`STOCK_BUY` futuro que recalcule desde cero también lo incluya) y se resta directo de
`costBasis` si ya hay acciones en mano en ese momento. Sigue sin sumarse a la tabla de
"Primas/Semana" (que solo cuenta `STO/BTC/ROLL`, no dividendos) — no se pidió ese cambio.

## Tabla Primas/Semana (`semanalHtml` en index.html)

Muestra solo P&L **realizados**. Lógica:
- `ROLL` → siempre incluido (ya es neto)
- `BTC` → busca su `STO` matching por `strike|expiry`, muestra el **neto** en la semana del cierre
- `STO` sin BTC y expirado (`expiry < today`) → muestra prima en la semana del **expiry**
- `STO` aún abierto → **excluido silenciosamente**

## SPX 0DTE — CIARG_V1 + Signal Center

Sistema de señales para SPX 0DTE/1DTE, con ejecución automática en Tradier (sandbox) para
las estrategias direccionales de crédito.

**Flujo completo:**
1. **TradingView** (`CIARG_V1`, chart SPX 2m) corre el indicador base del mentor (Trend Magic
   CCI+ATR, CM SlingShot EMA10/20+retroceso, MACD slope) + una capa nuestra encima: fase
   Weinstein de 15m como marco maestro, y la señal final **solo por Camino B** (confluencia
   recién formada — sin exigir retroceso, gap mínimo de **60 min** entre disparos para no
   repetir en cada barra de una tendencia sostenida). El **Camino A** (retroceso clásico del
   mentor) se desactivó en `sig_bull_B`/`sig_bear_B` tras el backtest del 2026-07-03: 48.8%
   WR y P&L neto negativo en 41 señales sobre 58 días, vs 67.8% WR / +$975 del Camino B —
   `longCondition`/`shortCondition` se siguen calculando y mostrando en la tabla de info,
   solo ya no disparan la alerta. Solo dispara `alert()` para la entrada (BULLISH/BEARISH);
   no manda contexto 15m ni stop técnico — el servidor calcula esas dos cosas por su cuenta.
2. **`POST /api/spx/webhook`** recibe la alerta y **revalida todo de forma independiente**
   (no confía en lo que diga Pine): confluencia Weinstein 2m+15m con su propio cálculo desde
   Yahoo Finance, score del playbook (`calcPlaybookScore`, pesos en `SPX_CONFIG_DEFAULTS.weights`
   de `server.js` — MACD pesa poco a propósito, es una confirmación rezagada, no un gate de
   alto impacto), ventana horaria (`selectStrategy` en `src/spx.js`: 9:45am-3pm ET para 0DTE,
   3:45-3:50pm para 1DTE — ojo, hay un hueco sin ventana operable entre 3pm y 3:45pm),
   Iron Condor solo si son ≥10am y el rango de apertura 9:30-10:00 fue respetado.
3. Si pasa todo, busca strikes reales en la cadena de opciones y arma la señal
   (`buildSignalSummary`, `src/spx.js`) con stop técnico sugerido (Fractal 2m + Muro Gamma,
   el más conservador de los dos — solo informativo, sin monitoreo en vivo) y nota de R:R
   esperado según el tipo de vertical.
4. Si la estrategia es `BULL_PUT_SPREAD` o `BEAR_CALL_SPREAD` y el kill-switch
   `tradierAutoExecute` está activo (`spxConfig.trading`), se ejecuta automáticamente en
   Tradier sandbox (`src/tradier.js`) — **sin confirmación manual**. Antes de mandar la orden,
   `hasOpenPosition('SPXW')` revisa posiciones y órdenes en curso; si ya hay un trade abierto,
   la señal se guarda como sugerencia pero no se ejecuta (evita apilar posiciones).
5. Iron Condor (0DTE y 1DTE) tiene su propio pipeline paralelo, ver sección dedicada
   abajo. Las verticales de débito (Bull Call/Bear Put) siguen llegando al Signal Center
   como sugerencia manual — no están conectadas a Tradier.

**Gotcha importante:** `spx_config.json` (pesos del playbook, TP/SL, `tradierAutoExecute`)
vive en `DATA_DIR`, que en Railway es el **volumen persistente**, no el código desplegado.
Cambiar los defaults en `server.js` y hacer push **no actualiza el archivo real que usa
producción** si ya existe uno guardado ahí — hay que empujar el cambio también vía
`POST /api/spx/config` contra la URL de producción.

**Parámetros de trading actuales en producción** (`spxConfig.trading`, ajustados el
2026-07-03 tras el backtest de 58 días): `targetDelta: 0.30`, `tpPct: 30`, `slMult: 1.5`.
El default de `SPX_CONFIG_DEFAULTS.trading.targetDelta` en `server.js` sigue en `0.40` —
no coincide con el valor real de producción a propósito (ver gotcha de arriba): si alguna
vez se borra `spx_config.json` en el volumen, el sistema caería de vuelta al 0.40 sin avisar.

**Bug corregido (2026-07-04):** `findStrikesByDelta` (`src/spx.js`) recibía `targetDelta`/
`spreadWidth` como argumentos desde `server.js` pero no los declaraba en su firma — los
ignoraba silenciosamente y usaba 0.10-0.14/20pts fijos para toda estrategia. Esto
significaba que los cambios de delta/ancho en `spx_config.json` **nunca se aplicaban de
verdad** a las señales en vivo. Ya está arreglado (parámetros con default = comportamiento
viejo si no se pasan).

**Bug corregido (2026-07-08):** el call site de `calcPlaybookScore` en `server.js`
(`POST /api/spx/webhook`) tenía un bloque "Parche" que intentaba recalcular el score leyendo
`playbookResult.criteria`/`.criterios` — campos que `calcPlaybookScore` nunca devolvió (devuelve
`checks`, un array). Como resultado, cada vez que los checks legacy `precio_ema200`/
`emas_alineadas_diario` daban `true`, el bloque sobreescribía el score real (bueno) con un
score recalculado de máximo 10 puntos — muy por debajo del `minScore` de 75 — y la señal se
descartaba en silencio (`return;`, sin registrar nada). Estuvo matando señales direccionales
válidas quién sabe cuánto tiempo. Se eliminó por completo al reponderar el score (ver abajo).

**Score del Playbook — modelo "Peso de la Evidencia" (2026-07-08):** `calcPlaybookScore`
(`src/spx_indicators.js`) se reescribió para reflejar el Framework de los 3 Mundos del
playbook de Alejandro, en vez de los 7 checks EMA-céntricos anteriores. `minScore` subió de
75 a **80** (`SPX_CONFIG_DEFAULTS.minScore`) — regla de Alejandro: los 3 Mundos alineados
tienen que dar más de 80/100 para disparar el trade. Pesos actuales en
`SPX_CONFIG_DEFAULTS.weights`:
- `fase_weinstein` (40%) — booleano todo-o-nada: fase 2m y 15m coinciden con la dirección
  (2 alcista / 4 bajista). Nota: el gate obligatorio de confluencia ya exige esta misma
  condición antes de llegar al score, así que en la práctica esta variable siempre vale 40
  dentro del score de una señal que llega a evaluarse — es intencional, coherente con el
  modelo (Dirección es necesaria pero no alcanza sola, los otros 60 puntos son los que
  definen si se cruza el umbral).
- `regimen_institucional` (10%) — misma lógica que el viejo `gex_compatible`, renombrado. El
  framework de Alejandro pide GEX *y* DEX, pero DEX no se implementó todavía (los datos de
  delta ya están disponibles en la cadena de opciones sin fetch adicional, pero falta validar
  en qué dirección favorece cada régimen antes de sumarlo al score de un sistema que ejecuta
  órdenes reales — queda como mejora futura).
- `patrones_estructurales` (20%) — nuevo: Higher-Low (alcista) / Lower-High (bajista),
  `calcSwingStructure()` en `src/spx_indicators.js`, usa el historial de los últimos 3
  fractales de Williams 15m (`indicators.fractal15m.lowsHistory`/`.highsHistory`, antes solo
  se guardaba el último fractal, ahora se acumula historial en `buildSPXContext()`).
- `ema_10_20_alineadas` (10%) — fusión de los viejos `emas_alineadas_15m` + `precio_cerca_ema`.
- `volumen_rompimiento` (10%) — igual que el viejo `volumen_spy`, renombrado.
- `macd_cruce_pendiente` (10%, ajustado el 2026-07-08 desde 5% — ver nota abajo) — como el
  viejo `macd_alineado_15m` pero ahora también exige pendiente a favor. **Fix 2026-07-08:**
  la pendiente originalmente comparaba el histograma contra 1 sola vela atrás (`macd.slope`),
  demasiado ruidoso — puede dar negativo en una vela suelta aunque la línea del MACD siga
  claramente en ascenso (confirmado contra un caso real: usuario reportó "el MACD sí es
  alcista" con captura de pantalla, el check daba `false` porque el histograma bajó 0.03 en
  la última vela). Ahora compara la **línea** del MACD (más suave que el histograma) contra
  **3 velas atrás** (`macd.linePrev3`, nuevo campo en `calcMACD` de `server.js`) en vez del
  histograma vela-a-vela. `macd.slope` se mantiene en el objeto por compatibilidad pero ya no
  lo usa este check. **Bug encontrado de paso (el otro, previo a este fix):** el `calcMACD` local de `server.js` (el que
  realmente arma `indicators.daily/m15/m2.macd` en `buildSPXContext()`) devolvía solo
  `{line, signal, hist}` — sin `bullish`/`bearish`/`slope`. El viejo check `macd_alineado_15m`
  leía `macd.bullish`, que siempre fue `undefined`: ese check **nunca pasó una sola vez en
  producción**. Se agregaron `bullish`/`bearish`/`histPrev`/`slope` al `calcMACD` de `server.js`
  para que el check nuevo (y cualquier otro futuro) tenga datos reales.
- `confirmacion_algoritmica` (0%, ajustado el 2026-07-08 desde 5% — ver nota abajo) — puerto
  de "Camino A" (Trend Magic CCI+ATR + SlingShot EMA10/20 + pendiente MACD) a
  `src/camino_a.js` (`calcCaminoA`), calculado en `buildSPXContext()` sobre velas 2m y
  expuesto en `indicators.m2.caminoA`. El propio backtest de 58 días mostró que Camino A
  solo, como gatillo, es perdedor neto (48.8% WR, -$130 en 41 señales) — por eso está
  desactivado como disparador en Pine y ahora también en 0% en el score (el check se sigue
  calculando y mostrando en la señal, solo no suma puntos).

**Ajuste 2026-07-08 (mismo día del rework):** `confirmacion_algoritmica` bajó de 5% a 0% y
`macd_cruce_pendiente` subió de 5% a 10% — decisión del usuario, sin cambiar el resto de la
tabla. Suma sigue dando 100.

**Fix 2026-07-08 — `selectStrategy` no consideraba el régimen de gamma para crédito/débito:**
`selectStrategy` (`src/spx.js`) decidía crédito vs. débito solo por IV Rank/VIX
(`ivRank > 30 || vix > 20`). Si el IV Rank/VIX daba crédito pero el gamma resultaba NEGATIVO,
el sistema igual vendía un crédito direccional (Bull Put/Bear Call) — exactamente la
combinación que el playbook de Alejandro marca como más peligrosa (vender prima en un régimen
"motor" de movimiento explosivo, donde el precio puede volar el SL antes de que el paso del
tiempo compense algo). Ahora **Gamma NEGATIVO fuerza débito** (Bull Call/Bear Put) para
direccionales, sin importar IV Rank/VIX — `gammaForcesDebit` en `selectStrategy`. Gamma
POSITIVO sigue decidiéndose por IV Rank/VIX como antes (ahí sí conviene cobrar prima, el
mercado tiene frenos). No afecta al Iron Condor (que ya exige GEX positivo por su propio gate).

**Feature 2026-07-08 — auto-ejecución de débitos direccionales (Bull Call/Bear Put):**
el fix de arriba (`gammaForcesDebit`) hace que el sistema elija débito en gamma negativo, pero
hasta este mismo día **el sistema solo auto-ejecutaba crédito** — los débitos quedaban siempre
como sugerencia manual en el Signal Center, nunca llegaban a Tradier. Se confirmó con un caso
real: una señal `BULL_CALL_SPREAD` válida (score 80%) quedó en `PENDING` toda la sesión, justo
un día de gamma negativo casi permanente. Ahora las 4 verticales direccionales auto-ejecutan:
- **Bug encontrado de paso en `src/tradier.js`:** `placeSpreadOrder`/`closeSpreadOrder`
  resolvían el tipo de opción con `strategy === 'BULL_PUT_SPREAD' ? 'P' : 'C'` — un ternario
  que solo distinguía esa estrategia; `BEAR_PUT_SPREAD` (que necesita **puts**) caía al
  default `'C'` e intentaba operar calls por error. Corregido a
  `(strategy === 'BULL_PUT_SPREAD' || strategy === 'BEAR_PUT_SPREAD') ? 'P' : 'C'`.
  El resto de la lógica (qué pata se compra/vende) ya era correcta para las 4 — `shortStrike`
  siempre es la pata vendida, `longStrike` la comprada, consistente en las 4 estrategias según
  `findStrikesByDelta` (`src/spx.js`).
- `tradierEligible` (webhook, `server.js`) ahora incluye las 4 estrategias, no solo las 2 de
  crédito.
- El gate de Crédito/Riesgo mínimo 20% (`MIN_CREDITO_RIESGO_PCT`) se exime para débito — es
  conceptualmente un chequeo de crédito, y además tenía un bug latente para débito
  (`credito = signal.credit || signal.maxProfit || 0` caía a `maxProfit`, sin relación real,
  dando un ratio sin sentido).
- `checkDirectionalTPSLImpl` ahora bifurca la fórmula de P&L según `ex.isCredit` (nuevo campo,
  persistido en `tradier_executions.json`; `undefined` en ejecuciones viejas se trata como
  crédito, que es lo único que existía antes de este cambio). Crédito sigue igual (cierra por
  % del crédito recibido). Débito es nuevo: valor actual = `q[longSym] - q[shortSym]` (mismo
  par de cotizaciones que crédito, restado al revés), P&L = valor actual menos lo pagado, TP/SL
  expresados como **% de la prima pagada** (`spxConfig.trading.debit.tpPct/slPct`, default
  50%/50%) — no como un multiplicador como en crédito, porque el riesgo máximo de un débito ya
  es 100% de lo pagado, un multiplicador no tiene el mismo sentido ahí.
- Migración no-destructiva de `spx_config.json` igual que las anteriores (`trading.debit` se
  agrega solo si no existe, sin tocar el resto).

**Bug encontrado en un doble-check posterior (2026-07-08) — 1DTE elegía strikes de la cadena
equivocada:** `findStrikesByDelta` (`src/spx.js`) resolvía la expiración buscando
`e['expiration-date']`, un campo que **no existe** en la cadena tal como la devuelve
`/api/option-chain/:symbol`/`enrichedExps` (ahí el campo se llama `expiry` — `expiration-date`
es el nombre nativo de la API cruda de TastyTrade, no el de la cadena ya remapeada que
realmente recibe esta función). Como la búsqueda siempre fallaba, caía al fallback
(`expirations[0]`, la expiración más próxima). Para 0DTE esto "funcionaba por accidente"
(hoy es justamente `expirations[0]`), pero para **1DTE** (Iron Condor 1DTE y direccional
1DTE, ventana 3:45-3:50pm ET) elegía deltas/strikes mirando la cadena de **hoy** en vez de la
de **mañana** — perfiles de riesgo completamente distintos, aunque el campo `expiry` del
resultado final sí mostraba la fecha correcta (por el mismo `|| targetDate` de respaldo),
ocultando el problema. Corregido a `e.expiry`/`exp.expiry` en las 5 ocurrencias de la función.
Verificado: con esto, 1DTE ahora resuelve la cadena de mañana correctamente; 0DTE sin cambios
de comportamiento (ya usaba la cadena correcta, por casualidad).

`precio_ema200`/`emas_alineadas_diario` (los checks EMA200 diaria que el bug de arriba tocaba)
se retiraron — la fase Weinstein real los reemplaza con una medida mucho más directa. Migración
de `spx_config.json` es automática (`loadSPXConfig()` detecta `weights.fase_weinstein ===
undefined` y reemplaza solo `weights`, preservando `trading` tal cual esté guardado en
producción) pero conviene verificar con `GET /api/spx/config` después de cada deploy, por el
gotcha de arriba (push no actualiza el volumen por sí solo).

## Iron Condor (0DTE + 1DTE) — pipeline independiente

A diferencia de las direccionales, el Iron Condor **no depende de una alerta de Pine** —
CIARG_V1 nunca manda `direction: NEUTRAL`, y el gate obligatorio de confluencia Weinstein
(fase 2/4) es incompatible con la tesis del IC (rango, sin tendencia). En vez de eso:

1. `checkIronCondor()` en `server.js` corre cada 5 min via `setInterval`, evaluando el
   contexto de mercado (`buildSPXContext()`, la misma función que usa
   `GET /api/spx/context`) contra `evaluateIronCondorGate(ctx, dte)` en `src/spx.js` —
   gate propio, playbook profesor Alejandro: GEX positivo + buffer de Gamma Flip
   (compartido 0DTE/1DTE), más para 0DTE: Fase Weinstein 15m 1 o 3, MACD 15m aplanado,
   rango de apertura respetado, ventana 10am-1pm ET; para 1DTE: ventana 3:45-3:50pm ET,
   rechazo total si VIX>24 (el 0DTE solo ajusta el ancho de alas a 10pts si VIX>24, no
   rechaza). El chequeo de calendario económico del 1DTE (eventos macro del próximo día
   de mercado) **se automatizó el 2026-07-09** — ver sección dedicada abajo.
2. Si pasa, arma la señal (4 patas: put corta/larga + call corta/larga, delta configurable
   vía `spxConfig.trading.ironCondor`) y, si `ironCondor.tradierAutoExecute !== false`
   (kill-switch **propio**, separado del de las direccionales), la ejecuta en Tradier vía
   `tradier.placeIronCondorOrder()` (orden multi-leg de 4 patas).
3. `checkIronCondorTPSL()` (cada 90s en horario de mercado) es el **primer cierre activo
   de posiciones de todo el sistema** — todo lo demás (`checkTradierExecutions`, cada
   5 min) es pasivo: solo detecta que una posición desapareció y registra el P&L después
   del hecho, nunca coloca una orden de cierre. Este monitor sí lo hace: confirma el
   fill (crédito neto real desde `avg_fill_price`), trae cotizaciones en vivo de las 4
   patas (`tradier.getQuotes()`, contra el propio sandbox de Tradier — no TastyTrade,
   la posición vive ahí), calcula cuánto costaría cerrar ahora, y cierra
   (`tradier.closeIronCondorOrder()`) cuando el P&L cruza `tpPct` o `-slMult` del
   crédito recibido.
4. **Fuera de alcance a propósito:** el stop técnico (Fractal/Muro Gamma) sigue siendo
   solo informativo, igual que en las direccionales; la defensa "lotería" (cerrar solo
   la pata amenazada y dejar la otra como cobertura) no está automatizada.

**Gotcha de limpieza:** las órdenes de prueba en el sandbox de Tradier a veces quedan en
estado `pending` indefinidamente (no auto-fillean) — mientras existan, `hasOpenPosition`
las cuenta como "trade en curso" y bloquea que se genere una señal real nueva. Si el
sistema deja de generar señales sin motivo aparente, revisar `tradier.getOrders()` por
huérfanas de pruebas anteriores.

**Backtester SPX** (`public/index.html`, tab "Backtester SPX", función `runBT()`): corre la
misma lógica de entrada de CIARG_V1 (Trend Magic + SlingShot + MACD + gate Weinstein 2m+15m
+ Camino B únicamente) contra 58 días reales de Yahoo Finance (límite de velas de 2m), con
P&L simulado vía Black-Scholes (IV fija 17.5%, sin datos históricos de cadena de opciones
reales — no existen en ningún proveedor). `BT_WEIGHTS`/`evalDir` (pesos del playbook dentro del
backtester) es un **proxy legacy simplificado** — desde el rework a "Peso de la Evidencia"
(2026-07-08) ya no se mantiene sincronizado clave por clave con `SPX_CONFIG_DEFAULTS.weights`
de `server.js` (hardcodea `volumen_spy: true`/`gex_compatible: true` porque no tiene esos datos
históricos client-side, y no calcula patrones HL/LH ni Camino A real como score). Solo importan
el `minScore` y que la suma de pesos dé 100, no la paridad check-por-check con producción.

**Símbolos de opciones:** el root correcto para las semanales/0DTE de SPX en Tradier es
`SPXW` (no `SPX`, que es solo mensual) — confirmado contra su sandbox real.

**Variables de entorno Tradier** (`.env`, prefijo `TRADIER_*` igual que `TT_*` para
TastyTrade): `TRADIER_ACCESS_TOKEN`, `TRADIER_ACCOUNT_NUMBER`, `TRADIER_BASE_URL`
(sandbox por defecto). No están en el volumen — hay que agregarlas también en las
Variables del servicio en Railway (Settings → Variables), o el auto-deploy no las tiene.

**Zona horaria:** `getETHour()` (`src/spx.js`) usa `America/New_York` real (vía
`toLocaleString`), no un offset fijo — se ajusta solo con el horario de verano (EDT/EST).
Antes tenía un bug de offset fijo UTC-5 que atrasaba 1 hora las ventanas en época de EDT.

**Calendario económico automatizado para el 1DTE (2026-07-09):** a pedido del usuario —
antes esto era una nota manual ("revisar antes de confirmar"), sin chequeo real. Ahora
`checkHighImpactUSEventsTomorrow()` (server.js) consulta el **próximo día de mercado** (salta
fin de semana — un IC 1DTE abierto un viernes expira el lunes, no el sábado) y bloquea la
entrada 1DTE si hay algún evento de **alto impacto en EE.UU.** ("3 estrellas", a pedido
explícito del usuario — no se filtran otros países ni impacto medio/bajo).
- **Fuente**: no hay API oficial de Investing.com — se encontró inspeccionando las llamadas
  de red de su propio calendario web: `endpoints.investing.com/pd-instruments/v1/calendars/
  economic/events/occurrences?domain_id=1&start_date=...&end_date=...&country_ids=5`. Sin
  auth, responde JSON limpio. `country_ids=5` = Estados Unidos (confirmado con datos reales).
  Es un endpoint no documentado/no oficial — **puede cambiar sin aviso**, revisar si empieza
  a fallar.
- Respuesta trae dos arrays a unir por `event_id`: `events` (metadata: `importance`
  `low`/`medium`/`high`, `event_translated`/`short_name`) y `occurrences` (`occurrence_time`
  en UTC, valores actual/forecast/previous). Se filtra a `importance === 'high'`.
- **Gate conservador ante fallos**: si la consulta falla (red, endpoint caído/cambiado), el
  1DTE se **bloquea** (no se asume "sin eventos" solo porque no se pudo verificar) — mismo
  criterio que el resto del sistema ante datos faltantes.
- Solo se consulta cuando `dte === '1DTE'` dentro de `checkIronCondor()` — no en cada
  chequeo de 0DTE, que no lo necesita.
- **Validado con fechas de prueba reales** (no solo con la lógica): "CB Consumer Confidence"
  salió correctamente marcado `high` para una fecha con evento real conocido, confirmando que
  el filtro de importancia funciona — no solo que la llamada no tira error.

## Alejamiento de SMA — reversión a la media (2026-07-08)

Tercer pipeline automático, **independiente y en paralelo** al direccional y al Iron Condor —
playbook de Luis Silva (Sigma Trade): el precio se aleja de la SMA8 ("el imán técnico") pero
no puede quedarse lejos, se opera el regreso. A diferencia del resto del sistema (todo EMA),
este setup usa **SMA simples** (`calcSMA`/`calcSMAArray`, `src/spx_indicators.js`) — indicador
explícitamente distinto, no reutiliza `calcEMA`.

**Flujo:**
1. `checkAlejamientoSMA()` (`server.js`, cada 60s) — gate horario propio
   (`evaluateReversionGate`, `src/spx.js`: 9:45am-2pm ET, todo o nada, **standalone y sin
   tocar `classifyWindow`** porque ese rango cruza varios buckets que ya usan el Iron
   Condor/direccional). Circuito diario: si hoy ya hubo 2 cierres por SL o agotamiento
   (`maxStopsPerDay`), no genera más señales el resto de la sesión.
2. Usa `indicators.m2.bars` — velas 2m crudas `{high,low,close}` que `buildSPXContext()`
   ya arma para `calcCaminoA` (variable local `bars2m`, ahora también expuesta en el
   contexto devuelto). Calcula SMA8/SMA20, RSI (`calcRSI`, ya existía como función local
   en `server.js` para el screener de acciones — reusada, no reescrita), y el patrón de
   confirmación (`evaluateReversionPattern`, `src/sma_reversion.js`).
3. **Score** (`calcReversionScore`, `src/spx_indicators.js`, umbral `minScore: 70` — el piso
   de "Trade Válido" del propio material de Luis, no el 80 del direccional):
   `alejamiento_sma8` 35%, `patron_confirmacion` 25%, `rsi` 15%, `fase_weinstein` 15%
   (Fase 15m a favor de la reversión — 2 para compras, 4 para ventas), `regimen_gex` 10%
   (GEX Positivo).
4. Patrón de confirmación — basta con que UNO de los tres confirme (`src/sma_reversion.js`):
   **Vela García** (SMA8 aplanándose y "enganchando" hacia un cruce con SMA20), **Vela
   Tiburón** (rango > 1.8x ATR reciente, con rechazo a favor de la reversión), **Vela 9
   Secuencial** (versión simplificada del conteo TD Sequential — 9 cierres consecutivos de
   agotamiento contra el cierre 4 barras atrás).
5. Ejecuta como credit spread — **mismo `strategy` literal que el direccional**
   (`'BULL_PUT_SPREAD'`/`'BEAR_CALL_SPREAD'`, no un valor nuevo) para heredar gratis
   `findStrikesByDelta`, `placeSpreadOrder`, la lista blanca de auto-ejecución, y
   `checkTradierExecutions` (reconciliación pasiva) sin tocarlos. El origen se distingue
   con un campo nuevo, `strategyFamily` (`'TENDENCIA'` / `'NEUTRAL'` / `'REVERSION'`),
   agregado a las **tres** estrategias en `spx_signals.json`/`tradier_executions.json`.

**Salida — por precio del SPX, no por % de crédito (decisión explícita del usuario, distinto
del resto del sistema):**
- `checkAlejamientoSMATPSL()` (cada 15-20s, más rápido que los 90s de las otras dos porque el
  hold es de 2-10 min) cierra por **TP** cuando el precio toca/cruza la SMA8, por **SL** cuando
  rompe la base/techo de la vela de entrada (`entryCandleLow`/`entryCandleHigh`, guardados al
  entrar), o por **stop de tiempo** (`maxCandlesTimeStop`, tope 5 velas de 2m) si no avanzó.
- **Simplificación conocida:** el objetivo de SMA8 (`ex.smaTarget`) se congela al momento de
  entrar, no se recalcula en vivo cada 15-20s (evita reconstruir todo `buildSPXContext` en un
  loop rápido) — con un hold de minutos la SMA8 no debería moverse mucho, pero si el curso con
  Luis Silva aclara que hace falta más precisión, esto es lo primero a revisar.
- Como esta estrategia cierra distinto a las otras dos, `checkDirectionalTPSL` la **excluye
  explícitamente** (`e.strategyFamily !== 'REVERSION'`) para que no compitan dos monitores por
  la misma posición.

**Exclusividad de posición — a propósito distinta del resto:** NO usa
`tradier.hasOpenPosition('SPXW')` (el chequeo compartido que sí usan Iron Condor y
direccional) — tiene su propio slot, chequeando directamente si ya hay una ejecución con
`strategyFamily === 'REVERSION'` abierta. Así puede dispararse aunque ya haya un Iron
Condor o direccional abierto. **Limitación aceptada:** en la dirección contraria sí hay
efecto — si esta estrategia tiene una posición abierta, el `hasOpenPosition('SPXW')` de las
otras dos SÍ la va a ver (Tradier no distingue posiciones por estrategia) y se van a pausar
solas mientras dure (2-10 min). Inevitable sin tracking de posición por estrategia a nivel
del broker; el impacto es chico dado lo corto del hold.

**Fuera de alcance a propósito:** el cierre de gap en apertura y la "regla de los segundos"
(entrar en los últimos 15-30s de formación de la vela) del playbook original de Luis Silva
**no son implementables** con la fuente de datos actual (polling de Yahoo Finance, no un feed
en vivo) — se opera sobre la vela de 2m ya cerrada, igual que el resto del sistema. Tampoco se
implementó un sistema de tiers "5 estrellas" (85-100/70-84/<70) — un solo umbral pass/fail,
igual que las otras dos estrategias.

**Nota de estabilidad:** el usuario va a tomar un curso con Luis Silva sobre este setup
específico (semana del 2026-07-08, miércoles a viernes) — es esperable que los pesos, umbrales,
o incluso la lógica de los patrones cambien poco después de este rework. Todo vive en
`spxConfig.trading.smaReversion` (config, no hardcodeado) para poder iterar rápido.

**Ajuste 2026-07-08 (mismo día, tras transcribir y revisar 2h de clase conceptual de Luis
Silva) — 5 cambios concretos:**
1. **Ventana horaria recortada** (`evaluateReversionGate`, `src/spx.js`): de 9:45am-2pm a
   9:45am-**12pm** ET. El tramo 12pm-3pm es "la siesta institucional" (sin compás claro) según
   el propio Luis — antes el gate lo incluía por completo.
2. **Bandas graduadas de alejamiento** (`calcReversionScore`, check `alejamiento_sma8`): el
   corte único (`MIN_EXT≈0.15%`) se reemplazó por 4 bandas con puntaje parcial — <0.10% ruido
   (0%), 0.10-0.20% interés (60%), 0.20-0.35% tensión alta (85%), >0.35% extremo (100%).
3. **Confluencia con Muro de Gamma** (check `regimen_gex`, ahora también lee `callWall`/
   `putWall`/`spxPrice` desde `ctx.gex`): el "setup dorado" de Luis es estiramiento extremo +
   GEX positivo + precio cerca del muro que frena el movimiento contrario (put wall para
   reversión alcista, call wall para bajista) — antes el check solo miraba el signo del GEX.
   Umbral de "cerca" configurable en `wallProximityPts` (default 15pts).
4. **GEX positivo ahora es gate duro**, no solo el 10% del score (`checkAlejamientoSMA`,
   server.js) — antes una señal podía llegar a 70/100 con GEX negativo compensando con el
   resto de los checks; Luis es explícito en que fuera de gamma positivo la reversión "pierde
   su hábitat" (los dealers amplifican en vez de estabilizar), no es un factor más a ponderar.
5. **Circuito diario reescrito**: antes contaba stops totales del día
   (`maxStopsPerDay`); ahora cuenta **pérdidas consecutivas** (una ganadora en el medio
   resetea el contador) y agrega un tope de **drawdown diario** (`maxDailyDrawdownPct`,
   default 3.5%, regla de Luis: 3-4% o 2 consecutivas, lo que llegue primero). Migración
   no-destructiva de `spx_config.json` igual que las anteriores.

**Ajuste 2026-07-08/09 — repesaje y minScore subido a 80:** a pedido explícito del usuario
("el alejamiento debe ser un 50% de la estrategia, es lo más importante"), los pesos de
`calcReversionScore` se repesaron: `alejamiento_sma8` 35→**50**, `patron_confirmacion` 25→**20**,
`rsi` 15→**10**, `fase_weinstein` 15→**10**, `regimen_gex` 10→10 (sin cambio). Suma sigue en 100.
`minScore` también subió de 70 a **80**, alineado al mínimo del direccional. Análisis
combinatorio (64 combinaciones de checks) confirmó que con 80% el patrón de confirmación
(García/Tiburón/Vela 9) se vuelve obligatorio en la práctica — sin él el máximo posible es 75,
nunca alcanza el mínimo — y que con alejamiento en banda "ruido" (<0.10%) nunca se dispara.
**Pendiente de decidir, no implementado todavía:** agregar confirmación de 5m (marco medio,
"estructura" en el lenguaje de Luis) al check `fase_weinstein`, que hoy solo valida 15m —
la "regla de oro" de Luis exige que 15m+5m+2m cuenten la misma historia, hoy solo se valida
15m+2m (2m indirectamente, vía la dirección ya determinada por precio vs SMA8).

**Ajuste 2026-07-09 — función de `alejamiento_sma8` pasó de banda creciente a escalón con
meseta óptima, y `minScore` bajó de 80 a 75:** validando contra un caso real (8 de julio,
rebote fuerte en V en SPX ~10:26am hora Colombia) se encontró que el estiramiento óptimo no es
"cuanto más, mejor" — un estiramiento demasiado grande puede ser un día de tendencia feroz, no
una reversión. Nueva función (`calcReversionScore`, `alejamiento_sma8`): <0.10% ruido (0%),
0.10-0.12% (40%), 0.12-0.15% (80%), **0.15-0.20% meseta óptima (100%)**, 0.20-0.25% (80%),
0.25-0.35% (40%), >0.35% extremo (0%) — simétrica hacia ambos lados de la meseta, a diferencia
de la banda anterior que solo crecía con el estiramiento.

**Caso de estudio real (8 de julio, ~10:26am hora Colombia / 11:26am ET):** rebote en V fuerte
en SPX que un usuario identificó visualmente como "la entrada buena" — se reconstruyó con datos
reales de Yahoo Finance (2m/5m/10m/15m) y se corrió `calcReversionScore` tal cual queda hoy.
Resultado: alejamiento -0.13% (banda 0.12-0.15%, 40 de 50 pts), patrón Vela 9 confirmado (20/20),
RSI 29.8 sobreventa (10/10), régimen GEX positivo sin muro cerca (5/10, supuesto — no se puede
reconstruir el GEX histórico real, depende de la cadena de opciones en vivo de ese momento),
**Fase Weinstein 15m en Fase 4 — no coincidía con la reversión alcista (0/10)**. Score final
75%, justo el nuevo mínimo — con el mínimo anterior de 80% NO hubiera disparado.

**Se investigó si el bloqueo por Fase Weinstein era arreglable por temporalidad — no lo es:**
se escaneó cuándo cada temporalidad (2m, 5m, 10m resampleado, 15m) mostraba por primera vez
Fase 2 ese mismo día: 2m a las 11:04, 5m a las 11:25, 10m a las 12:20, 15m a las 13:30 (todo
hora Colombia) — ninguna alcanza a confirmar a tiempo para la ventana de la entrada real
(~10:26). Incluso relajando la condición de Fase 2/4 (quitando la exigencia de que el EMA20
esté con pendiente a favor, dejando solo posición de precio) el resultado en 15m no cambió
(sigue sin confirmar hasta las 13:30) — el cuello de botella no es la fórmula de la fase, es que
cualquier promedio de 15 minutos reacciona demasiado lento para un rebote en V. Se decidió NO
tocar `calcWeinstein` ni bajar más el peso de `fase_weinstein` — es el costo esperado y aceptado
de la "regla de oro" de Luis (si los marcos se contradicen, no hay trade); en cambio se ajustó
`alejamiento_sma8` (arriba) y `minScore` para que casos como este, con el resto de los checks
fuertes, puedan compensar la falta de esa única confluencia.

**Nota de verificación 2026-07-08:** se revisó y confirmó que la dirección del check
`fase_weinstein` (exigir que la fase 15m *coincida* con la dirección de la reversión — Fase 2
para reversión alcista, Fase 4 para bajista — no que se *oponga*) es correcta según el material
de Luis Silva ("comprar el descanso... dentro del compás alcista", "sin tensión direccional [a
favor] el estiramiento pierde ventaja estadística") — no cambiar esto a un esquema de oposición
sin releer ese contexto primero.

**Pendiente, a propósito diferido:** el stop dinámico según tasa de acierto real que enseña
Luis (`stop_máximo = objetivo / (1/WR - 1)` — con 70% WR el múltiplo de equilibrio es ~2.3x el
objetivo, con 80% sube a 4x, con 90% a 9x) no se implementó — requiere un win rate *medido*
sobre trades reales en vivo, y todavía no hay historial de demo suficiente para calibrarlo sin
adivinar. El stop actual sigue siendo por precio (ruptura de la vela de entrada). Revisar esto
una vez haya suficientes trades de Alejamiento de SMA en demo para medir el win rate real.

**Ajuste 2026-07-09 — `alejamiento_sma8` pasó de función escalonada nueva (`calcReversionScore`,
`src/spx_indicators.js`): meseta de máximo puntaje (100% del peso) entre 0.15%-0.20%, no un
solo pico ni una banda creciente sin techo — 0.10-0.12%→40%, 0.12-0.15%→80%, 0.15-0.20%→100%,
0.20-0.25%→80%, 0.25-0.35%→40%, fuera de 0.10%-0.35%→0%. `minScore` de la reversión bajó de 80
a **75** (validado contra el caso real del 8 de julio, ver abajo).

**Debito unificado con credito en Take Profit (2026-07-09):** `trading.debit.tpPct` bajó de 50
a **30**, a pedido del usuario — mismo % que credito (`trading.tpPct`), sin importar si la
posición es débito o crédito. Nota: este cambio no afecta retroactivamente posiciones ya
abiertas — `debitTpPct` se congela en el registro de la ejecución al momento de crearla.

**Fix 2026-07-09 — reconciliación pasiva (`checkTradierExecutionsImpl`) nunca marcaba
`closeReason`:** cuando detecta que una posición "filled" ya no existe en Tradier (cerrada a
mano o por vencimiento), marcaba `status: 'closed'` y el P&L, pero dejaba `closeReason` en
`null` para siempre — un registro viejo (Iron Condor, 7 de julio) tenía `closeReason: 'MANUAL'`
pero ese valor no lo pone ningún código actual, quedó de una edición manual. Corregido:
ahora sí marca `closeReason: 'MANUAL'` (la etiqueta más honesta — el monitor pasivo no puede
distinguir cierre manual de vencimiento natural, solo sabe que se cerró fuera de sus propios
monitores activos). **Nuevo endpoint de mantenimiento:** `POST /api/tradier/executions/:id/patch`
— mezcla superficialmente los campos dados en un registro existente por `id`, para corregir
casos donde el `gain_loss` de Tradier no estaba asentado todavía en el momento exacto de la
reconciliación (P&L queda en `pnlSource: 'pendiente_verificar'` hasta corregirlo a mano con
este endpoint una vez la data esté disponible).

**Feature 2026-07-09 — invalidación técnica activa (POC + Fractal 15m) para el direccional:**
a pedido del usuario, con base en la metodología de Alejandro compartida ese día (stop
económico 1.5x + invalidación técnica por POC/Fractal, "el resultado depende más de la salida
que de la entrada"). Antes, `technicalStop`/`technicalStopSource` (Fractal 15m + Muro Gamma)
solo se guardaban informativamente en la señal — nadie cerraba la posición si el precio los
rompía. Ahora:
- **POC (Point of Control) nuevo** (`calcPOC`, `src/spx_indicators.js`): perfil de volumen de
  la sesión de HOY en velas de 15m, cubetas de $1 sobre el precio típico `(H+L+C)/3` de cada
  vela, se queda con la cubeta de mayor volumen acumulado. Yahoo sí devuelve volumen para
  `^GSPC` (agregado, no es volumen de futuros/opciones reales, pero es real y variable —
  confirmado con fetch en vivo antes de construirlo). Sin datos de volumen devuelve `null`, no
  un POC engañoso.
- `signal.fractalLevel` (Fractal 15m del lado que invalida — `.low` si la reversión es alcista,
  `.high` si es bajista) y `signal.pocLevel` (el POC de arriba) se calculan en el webhook y se
  **congelan** en el registro de `tradier_executions.json` al momento de entrar — igual que
  `entryCandleLow/High` en Alejamiento de SMA. No se recalculan en vivo cada ciclo.
- `checkDirectionalTPSLImpl` (server.js) ahora trae el precio actual del SPX cada ciclo (mismo
  fetch liviano que usa el monitor de reversión) y cierra con `closeReason: 'TECHNICAL_STOP'`
  si el precio rompe el Fractal Low **o** el POC en contra de la dirección — **antes** de
  evaluar el stop económico (%/multiplicador de crédito), no después. Cualquiera de los dos
  niveles solo (no hace falta que rompan ambos) es suficiente para salir, siguiendo la lectura
  literal del material ("si rompe el POC... debes salir, incluso si no tocaste el stop
  económico"; confirmado también para Fractal solo en la conversación con el usuario).
- Ejecuciones abiertas ANTES de este cambio no tienen `fractalLevel`/`pocLevel` (quedan en
  `null`) — simplemente no tienen gatillo técnico disponible, siguen protegidas solo por el
  stop económico existente, sin romper nada.

**Bug encontrado y arreglado el mismo día (2026-07-09) al construir el POC:** el bloque nuevo
usaba `highs15`/`lows15`, declaradas con `const` dentro del `{ }` propio del cálculo de Fractal
15m — fuera de alcance en el bloque del POC, que es un `{ }` hermano, no anidado. La excepción
resultante la absorbía el `catch` que envuelve toda la sección de indicadores de
`buildSPXContext()`, salteando en silencio TODO lo que viene después en ese mismo bloque:
`indicators.m2` (fase 2m), el rango de apertura (gate del Iron Condor), y el volumen de SPY —
no solo el POC. Modo de falla seguro (el sistema se negó a operar con datos incompletos, no
generó nada con datos corruptos), pero estuvo ~5-8 min degradado hasta el fix. Corregido leyendo
`q15.high`/`q15.low` directo en vez de reusar las locales del otro bloque.

**Monitor direccional bajado de 90s a 30s (2026-07-09):** a pedido del usuario, por ser
operaciones de scalping 0DTE — un caso real mostró la posición cruzando el 30% de TP bastante
antes de que el monitor llegara a cerrarla, y el usuario terminó cerrándola a mano primero.
30s reduce (no elimina) esa carrera. Mismo ritmo que ya usa el monitor de Alejamiento de SMA
(15s, todavía más rápido por ser holds de minutos).

**Investigado y descartado — bracket/OTOCO nativo en Tradier para el spread completo:** Tradier
sí soporta órdenes OTOCO (bracket: entrada → OCO de TP/SL), pero su restricción documentada
exige que la segunda y tercera pata del OCO comparten el mismo `option_symbol` — está pensado
para una sola opción, no para una vertical de 2 patas con símbolos distintos. Armar dos OTOCO
independientes (uno por pata) introduce riesgo real de piernas descubiertas si se disparan en
momentos distintos — peor que depender del monitor. Se descartó esa vía.

**Watchdog del monitor direccional (2026-07-09), como mitigación en su lugar:** dado que la
protección real sigue dependiendo de que el proceso esté vivo, `checkDirectionalMonitorHealth()`
(cada 60s) revisa si `checkDirectionalTPSLImpl` lleva más de 3 minutos sin correr (debería
correr cada 30s) **y** hay una posición direccional abierta en ese momento — si ambas cosas son
ciertas, manda una alerta ntfy urgente una sola vez por caída (se resetea sola cuando el monitor
vuelve a correr). No reemplaza la protección, solo evita descubrir tarde que el servidor se cayó
con una posición desprotegida.

**Bug real encontrado y arreglado (2026-07-09) — reconciliación pasiva mezclaba el P&L de
trades distintos que reusaron los mismos strikes el mismo día:** en scalping 0DTE es normal
que dos entradas distintas usen el mismo par de strikes (el precio vuelve a una zona). El
filtro viejo de `checkTradierExecutionsImpl` (`legSymbols.includes(p.symbol)`) suma TODAS las
entradas de `getClosedPnl` que matchean el símbolo, sin distinguir a cuál ejecución pertenece
cada una — si el símbolo se repitió por dos trades, el segundo en reconciliarse se llevaba
también el P&L del primero. Caso real: dos `BULL_CALL_SPREAD` con strikes 7530/7540 el mismo
día — el primero cerró vía `checkDirectionalTPSLImpl` (cotizaciones en vivo, `pnlSource:
'tp_sl_auto'`, correcto: $115) y el segundo cerró manual, reconciliado por este monitor pasivo,
que le sumó $340 en vez de los ~$100 reales (se comió también las 2 patas del primer trade).
Tradier no expone un ID que ate cada fila de `gain_loss` a una orden específica, así que el fix
es una heurística por conteo, no una corrección exacta: las entradas de un símbolo llegan
más-reciente-primero (confirmado empíricamente); se cuenta cuántas OTRAS ejecuciones ya
**cerradas** (cualquier `pnlSource`, no solo `gainloss` — las entradas de Tradier existen igual
aunque esa ejecución haya calculado su P&L por otro camino) comparten el mismo conjunto exacto
de `legSymbols`, y se saltan esas tantas entradas (las más nuevas, ya "ocupadas") antes de tomar
la que le corresponde a esta. Si no hay suficientes entradas distintas disponibles, cae a
`pnlSource: 'pendiente_verificar'` en vez de inventar un número. El registro real del 2026-07-09
ya corregido a mano vía `POST /api/tradier/executions/:id/patch` (de $340 a $100).

**Feature 2026-07-09 — Long Put Condor (débito) como alternativa al Iron Condor con IV Rank
bajo:** a pedido del usuario, basado en el playbook (vender prima con IV Rank bajo "es operar
sin ventaja" — primas comprimidas obligan a pegar las alas al precio; la alternativa de
débito tiene Vega positiva, se beneficia si la volatilidad se expande en vez de perder valor).
- **Decisión (`checkIronCondor`, server.js)**: `useDebit = ctx.ivRank < icCfg.ivRankThreshold`
  (default **25**, elegido por el usuario — coincide con el piso "25-30" que cita el playbook).
  IV Rank ≥ 25 sigue siendo Iron Condor de crédito de siempre.
- **Por qué Puts y no Calls** (decisión del usuario): el skew hace que los puts paguen mejor
  prima — para un débito eso significa pagar menos neto por las alas.
- **Construcción** (`findStrikesByDelta('DEBIT_PUT_CONDOR', ...)`, `src/spx.js`): 4 patas,
  todas puts, de mayor a menor strike: `outerHighStrike` (comprada, cerca del precio) >
  `innerHighStrike` (vendida, por delta) > `innerLowStrike` (vendida, `innerHigh - bodyWidth`)
  > `outerLowStrike` (comprada, `innerLow - spreadWidth`). Débito neto = alas compradas menos
  cuerpo vendido — **validado con datos reales** (SPX 1DTE, débito +$0.30, orden de strikes
  correcto) antes de conectarlo. Nota: 0DTE muy cerca del cierre tiene la curva de delta casi
  vertical y puede no encontrar ningún strike en el rango objetivo — es esperado, no es bug.
- **Órdenes nuevas en `tradier.js`**: `placeDebitCondorOrder`/`closeDebitCondorOrder` — compra
  las 2 alas externas, vende las 2 internas (y al revés para cerrar).
- **TP/SL** (`checkIronCondorTPSLImpl`, ahora bifurca por `ex.strategy === 'DEBIT_PUT_CONDOR'`):
  igual patrón que los débitos direccionales — % de la prima pagada (`debitCondor.tpPct/slPct`,
  default 50/50), no un multiplicador (el riesgo máximo ya es el 100% del débito).
- **Gate de crédito/ancho para el Iron Condor de crédito** (`minCreditoAnchoPct`, default
  **25**, elegido por el usuario): distinto del gate de crédito/**riesgo** de las direccionales
  — este es crédito/**ANCHO** directo, la "regla del tercio" del playbook pide ~33%, el usuario
  eligió 25% como su propio piso. Si el crédito real no alcanza ese %, la señal se descarta
  antes de armar la orden (no llega a Tradier).
- Ambas variantes comparten `strategyFamily: 'NEUTRAL'` y el mismo dedup/exclusividad de
  posición — no pueden dispararse las dos el mismo día para el mismo `dte`.

**Fix 2026-07-09 (mismo día) — el gate de 25% se calculaba contra el crédito *estimado*, no
contra el fill real:** un IC 1DTE real del mismo día lo probó: estimado 28.5% crédito/ancho
(pasaba el gate), pero el fill real llegó a solo 16% (no hubiera pasado si se midiera contra
eso). A pedido del usuario, la orden ya no se manda `type: market` — ahora usa **`type: credit`
con `price` = el crédito mínimo exacto** (`placeIronCondorOrder`, `src/tradier.js`, parámetro
`minCreditPrice`); si el mercado no da ese crédito, la orden simplemente **no llena**, en vez
de ejecutar a mercado y después tener que cerrarla por no cumplir el gate — evita pagar
comisión de apertura y cierre por una posición que nunca debió entrar. Mismo criterio para el
Long Put Condor de débito (`placeDebitCondorOrder`, parámetro `maxDebitPrice` = el débito
estimado al armar la señal, como techo). Las órdenes límite que no lleguen a llenarse ya se
manejan solas — `cleanupStalePendingOrdersImpl` (existente, sin cambios) cancela cualquier
orden pending de más de 10 min y marca el registro como `canceled`, sin necesitar lógica nueva.

**Feature 2026-07-09 — P&L no realizado en vivo en el historial de ejecuciones:** antes,
una posición abierta (no cerrada) mostraba "—" en la columna P&L hasta que cerraba. Nueva
función compartida `calcLivePnl(ex, quotesMap)` (server.js, reusa las mismas fórmulas que ya
usan `checkDirectionalTPSLImpl`/`checkIronCondorTPSLImpl`, de solo lectura) — `GET
/api/tradier/executions` ahora trae cotizaciones reales para las posiciones abiertas y agrega
`ex.livePnl` (separado de `ex.pnl`, que sigue en `null` hasta el cierre real, para no mezclar
realizado con no realizado). El frontend lo muestra con un `~` adelante (`~$115`) para dejar
claro que es no realizado, se actualiza cada vez que se recarga el dashboard.

**Ajuste 2026-07-09 — tamaño de posición por score, no por % de capital, "mientras
afinamos todo" (decisión temporal explícita del usuario):** el sizing por 2%/1% del
capital real (que dio el caso real de 2 contratos analizado ese mismo día) se reemplaza por
`sizeContractsByScore(score)` (server.js): **1 contrato en general, 2 si el score de la señal
fue ≥90%** (muy alineada). Aplica a las dos estrategias que sí tienen un score 0-100 real:
- **Direccional**: se sobreescribe `sel.contracts` justo después de `selectStrategy()`, usando
  `playbookResult.score` (ya calculado antes en el webhook).
- **Alejamiento de SMA**: usa `scoreResult.score` de `calcReversionScore()`.

**Iron Condor y Long Put Condor de débito quedan fijos en 1 contrato** — no tienen un score
0-100 real (son una serie de gates booleanos: GEX, Fase 1/3, MACD aplanado, VIX, calendario
económico, etc.), así que la regla de "2 si ≥90%" no tiene un número al que aplicarse todavía.
Si se quiere una regla equivalente para el IC/débito, haría falta construir antes algún tipo de
score agregado a partir de sus checks — no implementado, señalado explícitamente al usuario.
Esto es temporal y reversible — para volver al sizing por % de capital, revertir estos 4
puntos a la fórmula `Math.max(1, Math.floor(capital*pct/(width*100)))` que usaban antes.

## Rueda Automatizada (Tradier) — Fase 1: Screener + Señales (2026-07-10)

Cuarto pipeline automático, **independiente** de los tres de SPX — proyecto multi-semana para
automatizar el ciclo completo de La Rueda (CSP → asignación → Covered Call → reinicio)
ejecutando en **Tradier** (no TastyTrade, donde vive la Rueda real de JBLU/NU/GAP/SOFI). El
modelo completo (16 puntos: delta 0.15-0.30, DTE 30-45, cuenta margin, tope 2% por activo y 50%
del buying power total, roll del Put al mismo strike hasta un costo base objetivo del 20% de
descuento, selección de fecha por crédito/día, Covered Call condicional a la fase, etc.) se
consolidó en varias sesiones de diseño con el usuario antes de escribir código. Esta es solo la
**Fase 1**: el motor de sugerencias (screener), sin colocar ninguna orden real todavía — mismo
patrón que el Signal Center de SPX existió antes de conectarse a Tradier.

**Arquitectura:**
- `src/wheel_trading.js` (nuevo, funciones puras, sin I/O): `calcWeinstein`/`calcFractals`
  (extraídas del inline de `buildSPXContext` para reuso genérico), `calcEMA`/`calcMACD`
  (estilo array-based de `spx_indicators.js`), `calcWheelEntryScore` (mismo contrato
  `{score, passed, minScore, checks}` que `calcPlaybookScore`/`calcReversionScore`),
  `findBestCSPStrike` (selección de strike+fecha por crédito/día, con liquidez ya filtrada).
- `wheel_trading_config.json`/`wheel_trading_signals.json` en `DATA_DIR` — nombres deliberadamente
  distintos de `wheel_config.json` (que ya existe para La Rueda pasiva/manual en TastyTrade,
  ver sección arriba) para no colisionar.
- **Universo de candidatos**: unión de dos fuentes (2026-07-10) — `cfg.screener.finvizScreenerId`
  (default `'rueda'`, el screener de Finviz "🔄 La Rueda" ya existente en `SCREENERS`,
  `server.js` ~1412 — mismo checklist que el usuario ya usaba a mano: cap_midover, div>1%,
  P/E<28, beta<1.3, sobre SMA200; se resuelve vía self-fetch a `GET /api/screener/:id`, ya
  genérico) **más** `cfg.screener.tickers` (lista manual, arrancó con `['SOFI','NU','JBLU']` a
  pedido del usuario — necesario porque el watchlist general no incluye NU/JBLU, que solo viven
  en `wheel_config.json` de la Rueda pasiva). Ambas se unen y deduplican; si las dos quedan
  vacías, cae al `watchlist.json` general. Editable desde la UI (dos campos de texto en el
  panel de configuración) o `POST /api/wheel-trading/config`. Migración no-destructiva en
  `loadWheelTradingConfig()` (mismo patrón que `loadSPXConfig`) para ambas claves.
- **Gate técnico "3 Mundos"** (`calcWheelEntryScore`), a diferencia de SPX que exige confluencia
  2m+15m (scalping intradía), acá exige confluencia **diaria + semanal** (horizonte de semanas):
  Fase Weinstein (40%, ambos timeframes en Fase 1 o 2), GEX positivo del subyacente (15%),
  rebote en EMA10/20 diaria o fractal de soporte diario (25%), MACD diario con pendiente (20%).
  `minScore` default 70.
- **Screener de liquidez/volatilidad** (antes del gate técnico, en `checkWheelCandidates()`):
  IV Rank real 30-60, delta del Put 0.15-0.30, DTE 30-45, bid/ask <5%, open interest >500.
- `checkWheelCandidates()` corre **una vez al día** (horizonte de semanas, no minutos) vía
  `setInterval`, más `POST /api/wheel-trading/scan` para disparar manualmente sin esperar
  (usado para probar). Notifica por ntfy cuando aparece una señal nueva.
- Cadena de opciones: reutiliza el endpoint genérico `GET /api/option-chain/:symbol` (ya
  funciona para cualquier ticker, no solo SPX) vía self-fetch a `localhost` — mismo patrón que
  ya usa `buildSPXContext()` para la cadena de SPX.
- UI: nueva pestaña "🎯 Rueda Automatizada" en `public/index.html`, calcada del patrón de
  config/tabla de SPX Signal Center (`renderSPXConfig`/`toggleSPXConfig` → `renderWheelTradingConfig`/
  `toggleWheelTradingConfig`).

**Bug real encontrado durante la validación (2026-07-10) — el endpoint de IV Rank de TastyTrade
que ya usaba el sistema SPX estaba mal y nunca funcionó:** `buildSPXContext()` (y el patrón
copiado inicialmente para este screener) llamaba `tt._req('/market-data/volatility?symbols[]=' +
sym)` — ese endpoint **devuelve 404** (confirmado en vivo). El `try/catch` que lo envuelve caía
siempre al fallback hardcodeado (`ivRank = 30` para SPX) sin loguear el error de forma
distinguible, así que nadie lo notó: `GET /api/spx/context` lleva devolviendo exactamente
`ivRank: 30` todo este tiempo, nunca un valor real. Esto afecta lógica real de producción del
sistema SPX que depende de IV Rank:
- `useDebit = ctx.ivRank < icCfg.ivRankThreshold` (Iron Condor, default `ivRankThreshold: 25`) —
  con `ivRank` fijo en 30, `30 < 25` es SIEMPRE falso → el Long Put Condor de débito **nunca se
  ha disparado por esta vía** en la práctica.
- `isCredit = !gammaForcesDebit && (ivRank > 30 || vix > 20)` (direccionales) — con `ivRank`
  fijo en 30, `ivRank > 30` es SIEMPRE falso → la decisión crédito/débito ha estado gobernada
  **solo por VIX** todo este tiempo, nunca por el IV Rank real del SPX.
- **Endpoint correcto confirmado**: `GET /market-metrics?symbols=SYMBOL` (coma, no
  `symbols[]=`), campo `implied-volatility-index-rank` (decimal 0-1, multiplicar por 100). Ya
  corregido en el código nuevo de este screener (`checkWheelCandidates`). **Pendiente, señalado
  al usuario, no corregido todavía a propósito** (fuera del alcance de esta Fase 1): aplicar el
  mismo fix a `buildSPXContext()` en `server.js` — cambiaría el comportamiento real de un
  sistema que ejecuta órdenes reales en producción, así que se dejó para que el usuario decida
  cuándo desplegar ese cambio específico, en vez de mezclarlo silenciosamente con este trabajo.

**Validado 2026-07-10** contra datos reales de mercado (29 tickers del watchlist): el pipeline
completo corre sin errores end-to-end; en la corrida de validación ningún ticker pasó los 4
checks a la vez (ej. SOFI pasó el filtro de IV Rank pero falló el gate técnico por falta de
confluencia Fase Weinstein diaria/semanal) — resultado esperado de un gate selectivo, no un bug.

**Fuera de alcance de la Fase 1 (resuelto parcialmente en la Fase 2 de abajo):** colocación real
de órdenes en Tradier, el state machine de ciclo completo (fases CSP_ACTIVA→ASIGNADO→CC_ACTIVA→
CERRADO, análogo a `tradier_executions.json` pero con transiciones de fase en vez de un solo
trade), los monitores de roll/asignación/gestión de Covered Call, el switch de UI Tasty/Tradier,
y el estimador de requisito de margin por posición. Contexto completo del diseño de las 16
piezas del modelo en la memoria del proyecto (`wheel_automation_project.md`).

## Rueda Automatizada — Fase 2: aprobar señal → colocar el CSP en Tradier (2026-07-10)

El único checkpoint manual del ciclo completo (ver modelo de 16 puntos): aprobar una señal
`PENDING` coloca la orden real de venta del Put en Tradier y la deja trackeada como un ciclo
abierto. **No existe un precedente idéntico en SPX** — se revisó el único endpoint manual de
SPX (`POST /api/spx/signals/:id/action`, server.js) esperando encontrar el patrón "aprobar →
ejecutar de verdad", pero ese endpoint solo cambia `status`/`notes` de la señal, nunca coloca
una orden (todo el auto-trading de SPX es 100% automático, sin aprobación manual). Se construyó
combinando piezas sí existentes (colocación de órdenes, gate `IS_PRODUCTION`, confirmación de
fill, registro de ejecución).

**Arquitectura:**
- `tradier.placeSingleLegOrder({underlyingRoot, optionSymbol, side, quantity, limitPrice})`
  (nuevo, `src/tradier.js`) — contraparte de `closeSingleLeg` (que solo cierra); abre una pata
  suelta (`sell_to_open`/`buy_to_open`). `limitPrice` opcional manda `type:limit,price:X` en vez
  de `market` — mismo criterio de cautela que `minCreditPrice` del Iron Condor.
- `wheel_trading_executions.json` (DATA_DIR) — **distinto** de `tradier_executions.json` (SPX)
  porque el ciclo de la Rueda tiene fases que cambian en el tiempo sobre el MISMO registro
  (`phase: CSP_ACTIVA` por ahora; `ASIGNADO`/`CC_ACTIVA`/`CERRADO` en Fase 3+), a diferencia de
  un trade SPX que abre y cierra una vez. Registro: `{id, signalId, symbol, phase, entryPrice,
  costBasisTarget, leg:{optionSymbol,strike,expiry,side,contracts}, orderId, status, entryFillPrice,
  creditReceived, filledAt}`.
- `POST /api/wheel-trading/signals/:id/approve` — 404 si no existe la señal, 400 si no está
  `PENDING`. **Gate `IS_PRODUCTION`** (igual que los 3 pipelines de SPX): en local responde
  `{ok:false, reason:'local'}` y no coloca nada — mismo sandbox de Tradier que producción, mismo
  riesgo de doble-ejecución si local y Railway corrieran a la vez. Si es producción: cotiza el
  Put en vivo (`tradier.getQuotes`), coloca la orden como limit al bid actual, fija
  `entryPrice`/`costBasisTarget` (= `entryPrice × 0.80`, la regla del 20% de descuento ya
  decidida) con el spot actual de Yahoo, crea el registro, marca la señal `APPROVED`.
- `checkWheelExecutionFills()` (cada 30s en horario de mercado) — confirma el fill vía
  `tradier.getOrder`+`verificarFillPorPata` (reutilizada sin cambios de SPX, ya soporta órdenes
  de una sola pata en su rama `!legs.length`) → `status:'filled'`, `entryFillPrice`,
  `creditReceived`.
- `GET /api/wheel-trading/executions` + sección "Ciclos Activos" en la UI. Botón "✅ Aprobar e
  iniciar ciclo" por señal `PENDING`, con `confirm()` nativo antes de llamar al endpoint (acción
  real de dinero, aunque sea sandbox).
- **Contratos fijos en 1** — mismo patrón ya usado para Iron Condor/Long Put Condor de débito en
  SPX (sin estimador de requisito de margin todavía, un sizing real sería adivinar un número).

**Validado 2026-07-10 (solo el gate local — la colocación real en Tradier solo se puede probar
desplegando a Railway):** con una señal de prueba insertada a mano, `POST .../approve` respondió
`{ok:false, reason:'local'}` sin crear ningún registro ni tocar `tradier.*`; 404/400 confirmados
para señal inexistente / ya `APPROVED`. UI confirmada visualmente (botón "Aprobar", sección
"Ciclos Activos" con estado vacío).

**Fuera de alcance de la Fase 2 (Fase 3+):** roll del Put (mismo strike, por crédito/día, hasta
el `costBasisTarget`), detección de asignación, fase Covered Call (condicional a la fase
Weinstein), reinicio del ciclo, estimador real de requisito de margin, switch de UI
Tasty/Tradier.

## Rueda Automatizada — Fase 3: Fair Value + gestión activa del Put (2026-07-10)

Traduce a código el modelo de "etapa de posicionamiento" diseñado con el usuario en varias
sesiones (fair value real como ancla de asignación en vez del 20% fijo, caminar el strike hacia
abajo, triggers de roll, excepción defensiva, siempre por crédito neto).

- **Fair Value (DCF)**: `fetchFairValue(symbol, spotPrice)` (`server.js`) — mismo proxy FMP ya
  usado en `/api/watchlist/:symbol/fundamentals`
  (`https://jrcdslfwrasitrvjboho.supabase.co/functions/v1/proxy/fmp/discounted-cash-flow?symbol=X`
  → `{dcf, "Stock Price"}`, sin auth nueva). Filtro de sanidad: descarta si el DCF es negativo o
  se desvía más del **65%** del spot (confirmado con datos reales: SOFI válido $17.81 vs spot
  $18.62; NU rechazado, DCF $64 = 4.7x el spot; JBLU rechazado, DCF negativo).
- **Selección de strike anclada**: `wheelTrading.findAnchoredCSPStrike(expirations, spotPrice,
  fairValue, screenerCfg)` (`src/wheel_trading.js`) — el strike más alto entre spot y fair value
  que supere el piso de prima mínima (`minPremiumFor`, 2% mensual sobre el **nocional completo**
  strike×100, no sobre el margin real — decisión explícita del usuario). Si el fair value no es
  válido, cae a `findBestCSPStrike` (delta 0.15-0.30, Fase 1) sin romper el comportamiento
  anterior — confirmado con CALM real (DCF rechazado por 72% de desviación, cayó correctamente
  al método por delta).
- **Selección de fecha al rolar**: `wheelTrading.findBestRollDate(expirations, targetStrike)` —
  crédito/día **sin restringir a 30-45 DTE** (esa ventana es solo para la entrada; al rolar se
  compara contra TODOS los vencimientos disponibles, decisión explícita del usuario con su
  ejemplo de 1 semana vs 2 semanas vs 1 mes).
- **`checkWheelPutManagementImpl()`** (cada 5 min, `isMarketHours()`) — para cada
  `phase:'CSP_ACTIVA'`: evalúa 4 triggers (extrínseco ≤5% del crédito original — el usuario
  rechazó explícitamente el piso absoluto de $5 de Alejandro porque se opera con acciones de
  precios muy distintos; delta ≥0.35 hasta 0.50; DTE≤21; ganancia≥50-70%). Si dispara: (a) si
  costo base real ≤ fair value → `readyForAssignment=true`, deja de defender; (b) si Fractal de
  soporte roto y precio lejos de EMA20 (>4%) → roll defensivo al MISMO strike sin exigir el piso
  de prima; (c) si no, camina el strike hacia el fair value mientras siga superando el piso;
  (d) si ningún strike/fecha da crédito neto, no rola (ntfy de atención manual, nunca fuerza un
  débito — el Jade Lizard subsidiado queda diferido a una fase futura, decisión del usuario).
- **Bug real encontrado durante la implementación**: el fetch de la cadena de opciones para el
  roll estaba filtrado a `?expiry=${ex.leg.expiry}` — solo la expiración actual — por lo que
  `findBestRollDate` terminaba comparando el roll contra sí mismo (sin otras fechas
  disponibles). Corregido quitando el filtro (la entrada sí necesita 30-45 DTE, pero el roll
  necesita ver TODAS las expiraciones); confirmado con CALM real (4 vencimientos reales, el
  monitor eligió correctamente entre ellos tras el fix).
- **Ejecución del roll**: `tradier.closeSingleLeg` (pata vieja) → confirma fill →
  `tradier.placeSingleLegOrder` (pata nueva, nuevo método, contraparte de `closeSingleLeg` que
  solo cerraba) — gateado por `IS_PRODUCTION` igual que el resto del sistema; en local deja una
  nota `[DRY-RUN]` informativa en vez de no hacer nada silenciosamente (necesario para poder
  verificar la decisión sin ver la consola del proceso).
- Mutex propio `withWheelExecutionsLock` (mismo patrón que SPX) — ahora hay 3 escritores
  periódicos de `wheel_trading_executions.json` (fills, gestión, vencimiento pasivo
  `checkWheelExpiryImpl`, cada 30 min).
- **Universo de candidatos ampliado**: se conectó el screener de Finviz "🔄 La Rueda" ya
  existente (`SCREENERS.rueda`, `server.js`) vía `GET /api/screener/:id`, unido con la lista
  manual (`SOFI, NU, JBLU`) — validado con datos reales: 60+ tickers de Finviz produjeron una
  señal real (CALM, score 75%, cayó a delta porque su DCF se desvía 72% del spot).
- **Validado 2026-07-10**: filtro de sanidad del DCF, `findAnchoredCSPStrike` con fallback, y el
  monitor de gestión completo con una ejecución sintética (CALM strike 85, delta real 0.44 —
  disparó el trigger, evaluó la caminata sobre los 4 vencimientos reales, no encontró un strike
  más bajo que superara el piso, cayó al strike actual — todo en modo dry-run, sin tocar
  Tradier).
- **Fuera de alcance (Fase 4+)**: detección real de asignación más allá del check pasivo mínimo
  ya incluido (`checkWheelExpiryImpl`: revisa posiciones en Tradier el día de expiración, marca
  `ASIGNADO`/`CERRADO`), venta de la Covered Call, reinicio del ciclo, estimador de margin
  (contratos fijos en 1), switch de UI Tasty/Tradier.

## Rueda Automatizada — Fase 4: Covered Call, gestión y reinicio del ciclo (2026-07-10)

Cierra el ciclo completo: una vez asignadas las acciones de verdad, vende la Covered Call
(segundo acto de la Rueda, playbook Alejandro), la gestiona mientras está abierta, y reinicia
el ciclo automáticamente — sin ningún checkpoint manual nuevo (el único sigue siendo la
aprobación inicial de la Fase 2).

**Diferencia clave frente al Put**: ser asignado en una Call SIEMPRE es un resultado favorable
(regla del break-even — nunca se vende por debajo del costo base), a diferencia del Put, donde
la asignación es algo que se defiende hasta que conviene. Por eso el roll de la Call no tiene
lógica de "defender" — si se puede rolar hacia arriba/adelante por crédito neto, se hace (para
capturar más ganancia); si no, simplemente se deja expirar (asignación o vencimiento sin valor,
ambos aceptables) — mismo "nunca pagar por rolar" del resto del sistema, sin excepción.

- **`wheelTrading.findCoveredCallStrike(expirations, spotPrice, costBasis, weinsteinPhase,
  screenerCfg)`** — filtra SIEMPRE `strike > costBasis` (regla sagrada, sin excepción). Fase
  Weinstein **diaria** (decisión primaria, no exige confluencia semanal como el gate de entrada
  — reacciona más rápido). Si Fase 4 (bajista): vencimientos semanales (5-10 DTE), delta
  0.25-0.35 (prima agresiva, cerca del precio). Si no (1/2/3): vencimientos 30-45 DTE, delta
  ~0.15 (bien OTM, deja correr la revalorización).
- **`wheelTrading.findBestRollDate`** generalizado con un parámetro `optType` (antes
  hardcodeado a Put) — mismo crédito/día sin restricción de ventana, ahora reutilizable para
  Calls.
- **Bug real encontrado al construir el fallback "relajado" de `findCoveredCallStrike`**: el
  filtro de bid/ask (5%, mismo que usa la entrada del Put) rechaza casi cualquier call barata
  y OTM (un spread de $0.70/$1.00 = 35%, normal en un contrato de menos de $1, no un problema
  de liquidez real). El fallback original elegía "el strike más bajo disponible en CUALQUIER
  vencimiento" sin exigir la ventana de DTE — con datos reales de CALM (spot $88, costBasis
  $75) esto elegía un strike de **$80 a 7 DTE, delta 0.91** (¡profundamente ITM!) en vez de
  algo razonable. Corregido: el fallback se queda en la MISMA ventana de DTE (según la fase) y
  elige el strike más cercano al delta objetivo, solo relajando el filtro de bid/ask — con los
  mismos datos reales ahora elige correctamente **$100 a 42 DTE, delta 0.16** (bien OTM, como
  se esperaba).
- **`checkWheelExpiryImpl`** (Fase 3) extendido con dos ramas nuevas: (B) `CC_ACTIVA` vencida →
  `CERRADO` (acciones ya no están = ejercida, ciclo completo con ganancia) o `ASIGNADO` de
  nuevo (acciones siguen = expiró sin valor, vender otra Call — **esta transición ES el
  reinicio del ciclo**, no hace falta código aparte porque `checkWheelCandidates` ya vuelve a
  considerar cualquier ticker sin filtrar por historial); (C) `ASIGNADO` sin Call activa →
  calcula costo base real, trae Fase Weinstein, llama `findCoveredCallStrike`, vende la Call
  (`placeSingleLegOrder`, mismo patrón de Fase 2-3) y transiciona a `CC_ACTIVA`.
- **`checkWheelCallManagementImpl()`** (nuevo, cada 5 min) — mismos 4 triggers que el Put
  (extrínseco ≤5%, delta ≥0.35 hasta 0.50, DTE≤21, ganancia≥50-70%), pero la decisión es
  distinta: busca un strike MÁS ALTO que dé crédito neto ≥0 (nunca hacia abajo — violaría el
  break-even más fácilmente); si lo encuentra, rola (mismo patrón de dos pasos —
  `closeSingleLeg`+`placeSingleLegOrder` — que el Put); si no, no hace nada (sin nota, sin
  ntfy — no es un problema, es el resultado esperado cuando ningún roll es económicamente
  sensato).
- **Segundo bug real, en el manejo del acumulado de primas** (`checkWheelExecutionFillsImpl`,
  compartido por todas las fases): sobreescribía `ex.totalCreditAccumulated =
  ex.creditReceived` en CADA fill confirmado — no solo en la entrada inicial — borrando el
  acumulado que los rolls (Put y ahora Call) ya habían incrementado ellos mismos al decidir el
  roll. Esto ya afectaba silenciosamente a la Fase 3 (los rolls de Put nunca acumulaban de
  verdad más de un ciclo). Corregido: solo se inicializa si `totalCreditAccumulated` es `null`
  (la primera vez); los rolls y la venta inicial de la Call ahora suman su propia prima
  explícitamente (`ex.totalCreditAccumulated = (ex.totalCreditAccumulated||0) + premium`) antes
  de volver a `status:'submitted'`.
- **Validado 2026-07-10** con ejecuciones sintéticas en modo dry-run (sin tocar Tradier,
  `IS_PRODUCTION` falso en local): transición `ASIGNADO`→`CC_ACTIVA` con datos reales de CALM
  (encontró correctamente el strike $100 bien OTM); gestión de una Call profundamente ITM
  (trigger de delta disparó, 8 strikes candidatos evaluados, ninguno dio crédito neto — se
  dejó correctamente sin acción, comportamiento esperado).
- **Fuera de alcance (Fase 5+)**: Jade Lizard/débito subsidiado (ya diferido), estimador de
  margin (contratos fijos en 1), switch de UI Tasty/Tradier, afinar la regla de "rolls de 1
  semana" en su forma específica para la gestión semanal de la Call en Fase 4 bajista.

## Bug real en los 3 monitores de TP/SL de SPX — P&L grabado con la cotización equivocada (2026-07-10)

**Caso real que lo destapó**: un Iron Condor 1DTE cerró por SL con **-$1590** grabado en el
sistema. Al reconstruir la operación con las órdenes reales de Tradier (fills de entrada, fills
de cierre, y `tradier.getClosedPnl`, las 3 fuentes coincidiendo), el resultado real fue
**-$10** — casi break-even. El usuario confirmó que Tradier mismo mostró brevemente un número
similar al grabado (~$1490) que luego se corrigió solo, señal de que fue un valor transitorio
(mercado recién abierto, poca liquidez) que nuestro sistema capturó y dejó grabado para
siempre.

**Causa raíz**: `checkIronCondorTPSLImpl` y `checkDirectionalTPSLImpl` calculan `pnlActual` con
las cotizaciones vivas de **antes** de cerrar (necesario para decidir si el TP/SL debe
disparar), pero luego usaban ese mismo número estimado como el P&L final grabado —
`ex.pnl = pnlActual*100*contracts` — en vez de confirmar el precio de cierre real.

**Segundo bug relacionado, en los 3 monitores**: al intentar arreglarlo copiando el patrón que
ya usa `checkAlejamientoSMATPSLImpl` ("dejar el P&L pendiente para la reconciliación pasiva"),
se descubrió que ese patrón **tampoco funcionaba**: `checkTradierExecutionsImpl` (la
reconciliación pasiva que trae el P&L real vía `getClosedPnl`) solo procesa registros con
`status==='filled'` — nunca `'closed'`. Los 3 monitores activos marcaban `status='closed'`
inmediatamente al cerrar, así que ninguno de los tres quedaba disponible para que la
reconciliación pasiva los completara — para Alejamiento de SMA esto significaba que el P&L de
sus cierres automáticos (`pnlSource: 'precio_spx_auto'`) se quedaba en `null` **para siempre**,
sin que nadie lo notara.

**Fix aplicado a los 3 monitores** (`checkIronCondorTPSLImpl`, `checkDirectionalTPSLImpl`,
`checkAlejamientoSMATPSLImpl`): al cerrar por TP/SL, ya NO se marca `status='closed'` ni se
graba ningún `pnl` en el momento — se coloca la orden de cierre real, se guarda `closeReason`, y
se deja el registro en `status='filled'` a propósito. `checkTradierExecutions` (corre cada 5
min en horario de mercado) lo detecta como "posición que ya no está" en su siguiente ciclo y
completa el P&L real desde `tradier.getClosedPnl` — mismo mecanismo ya usado y ya arreglado
(fix de doble-conteo del 2026-07-09) para cierres manuales, reutilizado en vez de inventar una
confirmación de fill propia con una convención de signos incierta de Tradier. Costo: hasta 5 min
de retraso en ver el P&L final en el dashboard (antes aparecía al instante, pero podía estar
gravemente mal).

**Registro corregido a mano**: el Iron Condor de -$1590 se corrigió a -$10 vía
`POST /api/tradier/executions/:id/patch` (mismo endpoint usado para el caso anterior de
doble-conteo, $340→$100).

## Notificaciones

- Servicio: **ntfy.sh**, topic configurado en `.env`
- Alerta de extrínseco: se dispara cuando el valor extrínseco de una posición cae ≤ 5% del crédito original
- Guard importante: saltar grupos donde `uPrice = 0` o `mark-price = 0` (evita falsas alertas)

## Variables de entorno (.env)

```
TASTYTRADE_USERNAME=
TASTYTRADE_PASSWORD=
TASTYTRADE_ACCOUNT=
NTFY_TOPIC=
RAILWAY_VOLUME_MOUNT_PATH=   # solo en Railway

# Tradier (sandbox) — ver sección SPX 0DTE
TRADIER_ACCESS_TOKEN=
TRADIER_ACCOUNT_NUMBER=
TRADIER_BASE_URL=https://sandbox.tradier.com/v1
```

## buildMetrics (`src/metrics.js`)

- **Rolls**: órdenes con "to Close" + "to Open" del mismo tipo (C o P) se detectan como ROLL (`detectRoll`). El leg de cierre consume el inventario viejo pero NO crea par negativo — se registra como evento único con `stratType: 'Roll'`, `pnl = order.netValue` (crédito neto del roll) y duración "Intradía". Sin esto, el FIFO emparejaba el cierre contra la apertura original (de semanas atrás) mostrando una pérdida falsa.
- **P&L neto vs bruto**: usa `net-value` de la API de TastyTrade que ya incluye fees regulatorios. TastyTrade muestra P&L bruto (sin fees), la bitácora muestra neto real. Diferencia típica: $1-2.50 por leg.
- **FIFO**: empareja cierres con la apertura más cercana en fecha. Multi-leg se consolida por `closeOrderId + underlying + closeDate`.

## BP Dashboard (`/api/bp-dashboard`)

Panel dedicado al seguimiento de Buying Power con metas 50/25/25 (Rueda/Especulación/Libre).

**Lógica de cálculo:**
- Agrupa opciones por `(underlying, expiry, optType)` para detectar spreads
- Si el grupo tiene Short + Long → **spread**: `ancho × 100 × qty` (GAP $19.5/$20 = $150)
- Si el grupo tiene solo Short → **naked**: `strike × 100 × qty` (JBLU CSP $5 = $500)
- Short calls con underlying en stock → **CC cubierta = $0**
- Stocks → `avgPrice × qty` (equity BP pool separado, mostrado aparte)

**Base del pie chart** = `ruedaOptBP + specOptBP + derivAvail` (suma los tres segmentos = 100%)
- No coincide con ningún valor único de TastyTrade (es usado + disponible)
- `derivative-buying-power` de TastyTrade = solo el disponible (Libre en el pie)
- `equity-buying-power` de TastyTrade = BP para acciones (pool separado, mostrado en header)

**TastyTrade API:**
- `quantity-direction: "Short"/"Long"` determina si es posición corta o larga
- `cost-effect` está **invertido**: Short put = "Debit", Long put = "Credit" → no usar para dirección
- `/accounts/{account}/margin-requirements` → 404, no existe

## Caché del servidor

El servidor mantiene caché en memoria con TTL de 120 segundos para llamadas a TastyTrade. Se invalida con `POST /api/refresh`.

## Service Worker

Cache actual: `bitacora-v5`. Para forzar actualización en todos los clientes, bumpar la versión en `public/sw.js`. El fetch handler solo intercepta esquemas `http`/`https` (esquemas como `chrome-extension://` rompían `cache.put()`). Si un cliente tiene cache viejo, ejecutar en consola del browser:
```js
navigator.serviceWorker.getRegistrations().then(r=>Promise.all(r.map(x=>x.unregister()))).then(()=>caches.keys()).then(k=>Promise.all(k.map(x=>caches.delete(x)))).then(()=>location.reload())
```

## iOS PWA — notch/status bar (safe-area-inset)

`apple-mobile-web-app-status-bar-style: black-translucent` (en el `<head>`) hace que el
contenido de la app corra por debajo de la barra de estado de iOS (reloj/batería) en vez
de dejarle espacio — en modo standalone (agregado a pantalla de inicio) esto tapaba la
parte de arriba de `.mobile-navbar` en iPhones con notch. Fix: `viewport-fit=cover` en el
meta viewport (necesario para que `env(safe-area-inset-top)` resuelva a un valor real) +
`padding-top: env(safe-area-inset-top)` en `.mobile-navbar` (altura `calc(48px + env(...))`)
y en el padding-top de `.content`/`.panel`/`.header` (compensando la altura extra del
navbar). En dispositivos sin notch, `env(safe-area-inset-top)` es `0px` — no hay efecto.

**Gotcha encontrado después:** el fix de arriba no se veía reflejado (incluso en Safari
normal, sin standalone) porque había **3 reglas `.panel { padding-top: ... }` duplicadas**
en distintos bloques `@media (max-width: 1024px)` — las últimas dos no tenían el ajuste
de safe-area, y una de ellas usaba `padding: 12px 10px` (shorthand, resetea las 4
esquinas) que pisaba el padding-top a 12px, muy por debajo de la altura real del
`.mobile-navbar` (48px + safe-area). Esto tapaba cualquier contenido al tope de cada
panel (ej. la fila de filtros Desde/Hasta/Filtrar en Historial) detrás del navbar fijo.
Al tocar `.panel`/`.content`/`.sidebar` en mobile, evitar `padding`/`margin` shorthand —
usar propiedades explícitas (`padding-top`, etc.) para no resetear el ajuste de safe-area.

## Desarrollo local

- `npm run dev` — nodemon (recomendado). Configurado en `nodemon.json` para ignorar `*.json` y `public/*`, evitando bucle de reinicios cuando el servidor escribe datos.
- `node server.js` — alternativa sin nodemon si hay problemas.
