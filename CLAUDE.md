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
| `public/sw.js` | Service worker PWA (network-first, versión actual: `bitacora-v3`) |

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

**Underlyings activos**: JBLU, NU, GAP, SOFI (en `wheel_config.json`)

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
5. Iron Condor y verticales de débito (Bull Call/Bear Put) llegan al Signal Center como
   sugerencia manual — todavía no están conectadas a Tradier.

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

**Backtester SPX** (`public/index.html`, tab "Backtester SPX", función `runBT()`): corre la
misma lógica de entrada de CIARG_V1 (Trend Magic + SlingShot + MACD + gate Weinstein 2m+15m
+ Camino B únicamente) contra 58 días reales de Yahoo Finance (límite de velas de 2m), con
P&L simulado vía Black-Scholes (IV fija 17.5%, sin datos históricos de cadena de opciones
reales — no existen en ningún proveedor). Pesos del playbook (`BT_WEIGHTS`) deben mantenerse
sincronizados a mano con `SPX_CONFIG_DEFAULTS.weights` de `server.js` si se vuelven a tocar.

**Símbolos de opciones:** el root correcto para las semanales/0DTE de SPX en Tradier es
`SPXW` (no `SPX`, que es solo mensual) — confirmado contra su sandbox real.

**Variables de entorno Tradier** (`.env`, prefijo `TRADIER_*` igual que `TT_*` para
TastyTrade): `TRADIER_ACCESS_TOKEN`, `TRADIER_ACCOUNT_NUMBER`, `TRADIER_BASE_URL`
(sandbox por defecto). No están en el volumen — hay que agregarlas también en las
Variables del servicio en Railway (Settings → Variables), o el auto-deploy no las tiene.

**Zona horaria:** `getETHour()` (`src/spx.js`) usa `America/New_York` real (vía
`toLocaleString`), no un offset fijo — se ajusta solo con el horario de verano (EDT/EST).
Antes tenía un bug de offset fijo UTC-5 que atrasaba 1 hora las ventanas en época de EDT.

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

Cache actual: `bitacora-v3`. Para forzar actualización en todos los clientes, bumpar la versión en `public/sw.js`. El fetch handler solo intercepta esquemas `http`/`https` (esquemas como `chrome-extension://` rompían `cache.put()`). Si un cliente tiene cache viejo, ejecutar en consola del browser:
```js
navigator.serviceWorker.getRegistrations().then(r=>Promise.all(r.map(x=>x.unregister()))).then(()=>caches.keys()).then(k=>Promise.all(k.map(x=>caches.delete(x)))).then(()=>location.reload())
```

## Desarrollo local

- `npm run dev` — nodemon (recomendado). Configurado en `nodemon.json` para ignorar `*.json` y `public/*`, evitando bucle de reinicios cuando el servidor escribe datos.
- `node server.js` — alternativa sin nodemon si hay problemas.
