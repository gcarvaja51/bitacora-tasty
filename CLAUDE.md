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
| `public/sw.js` | Service worker PWA (network-first, versión actual: `bitacora-v2`) |

## Persistencia de datos

```js
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
```

Archivos que viven en `DATA_DIR` (no en `__dirname`):
- `wheel_config.json` — lista de underlyings de La Rueda
- `nlv_history.json` — snapshots históricos de Net Liq
- `watchlist.json`, `trade_notes.json`, `playbooks.json`, etc.

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

Cache actual: `bitacora-v2`. Para forzar actualización en todos los clientes, bumpar la versión en `public/sw.js`. Si un cliente tiene cache viejo, ejecutar en consola del browser:
```js
navigator.serviceWorker.getRegistrations().then(r=>Promise.all(r.map(x=>x.unregister()))).then(()=>caches.keys()).then(k=>Promise.all(k.map(x=>caches.delete(x)))).then(()=>location.reload())
```

## Desarrollo local

- `npm run dev` — nodemon (recomendado). Configurado en `nodemon.json` para ignorar `*.json` y `public/*`, evitando bucle de reinicios cuando el servidor escribe datos.
- `node server.js` — alternativa sin nodemon si hay problemas.
