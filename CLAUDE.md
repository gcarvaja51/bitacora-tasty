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
   rechaza). El chequeo de calendario económico del 1DTE (eventos macro de la mañana
   siguiente) **no se automatiza** — no hay fuente de datos, queda como nota manual en
   la señal.
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
