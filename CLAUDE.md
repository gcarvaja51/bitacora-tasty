# CLAUDE.md — Bitácora Tasty

Dashboard de trading personal conectado a TastyTrade + robot de estrategias automáticas en
Tradier. Node.js/Express + vanilla JS (sin framework frontend).

> ### 📚 El histórico vive en `docs/historial-bitacora.md`
>
> Este archivo tiene **lo vigente**: reglas, parámetros, gotchas activos y las normas del
> usuario. Las **autopsias completas de cada bug** (con fechas, mediciones y el
> razonamiento de cada decisión) están en `docs/historial-bitacora.md`, con los mismos
> títulos de sección. Cuando una sección de acá dice *"histórico § Tal cosa"*, ahí está.
>
> **Al arreglar un bug: la autopsia va al histórico, la regla que queda viva va acá.**
> Separado el 2026-08-28 porque `CLAUDE.md` había llegado a 203k caracteres y se cargaba
> entero en cada sesión.

## Deploy

- **Producción**: Railway — `web-production-23473.up.railway.app`
- **Repo**: `gcarvaja51/bitacora-tasty` (main → auto-deploy en Railway)
- **Local**: `npm run dev` (nodemon en puerto 3000). `node server.js` si nodemon molesta.
- **Volumen Railway**: montado en `/data`, variable `RAILWAY_VOLUME_MOUNT_PATH`
- `nodemon.json` ignora `*.json` y `public/*` — sin eso el servidor se reinicia en bucle
  cada vez que escribe datos.

## Archivos clave

| Archivo | Rol |
|---|---|
| `server.js` | Servidor Express, todos los endpoints `/api/*`, caché en memoria, los ciclos periódicos de las estrategias, notificaciones |
| `src/tastytrade.js` | Cliente HTTP a la API de TastyTrade (auth, transacciones, posiciones, precios) |
| `src/tradier.js` | Cliente HTTP a Tradier (órdenes, posiciones, cotizaciones, gainloss) |
| `src/metrics.js` | P&L, equity curve, calendar (lado Tasty) |
| `src/metrics_tradier.js` | Mapeo de ejecuciones Tradier a la bitácora |
| `src/pnl_oficial.js` | **La única respuesta a "¿cuánto ganó este trade?"** — ver sección |
| `src/wheel.js` | Lógica pura de La Rueda manual: `buildWheelData(items, positions, underlyings)` |
| `src/wheel_trading.js` + `wheel_tradier_adapter.js` | La Rueda automatizada en Tradier |
| `src/spx.js` | Selección de estrategia, strikes por delta, gates, `getETHour()` |
| `src/spx_indicators.js` | Scores (`calcPlaybookScore`, `calcReversionScore`), SMA/RSI/POC/estructura |
| `src/camino_b.js` | Entrada direccional (`calcPullbackEntry`, fase 15m) |
| `src/impulsos.js` | Conteo de impulsos de 15m → escalera de TP y listón de score |
| `src/frenos.js` | Circuito diario. **Declara cuáles frenos están realmente activos** |
| `src/apagon_broker.js` | Detecta los apagones del sandbox de Tradier y **separa su culpa de la nuestra** |
| `src/impuestos.js` | Hoja fiscal DIAN — **local, no desplegar** |
| `public/index.html` | SPA completa (~8000 líneas). Todo el frontend en un archivo |
| `public/tradier.html` | Dashboard dedicado a Tradier/SPX. **Por defecto tocar este** para ajustes de SPX |
| `public/sw.js` | Service worker PWA (network-first) |
| `gamma_daemon/` | Proceso local de Node que refresca los muros de Gamma. No se despliega |
| `scripts/pruebas.js` | Batería de pruebas + humo |
| `scripts/control_cambios.py` | Genera los libros de control de cambios desde git |

> ### ⚠️ El frontend que se sirve es `public/index.html` — el `index.html` de la raíz NO
>
> `server.js` monta `express.static(path.join(__dirname,'public'))` y el catch-all
> `app.get('*')` responde con `public/index.html`. **Editar el `index.html` de la raíz no
> tiene ningún efecto.** Se mantiene como copia por convención, así que después de tocar el
> bueno hay que hacer `cp public/index.html index.html`.
>
> El 2026-08-06 se perdió media sesión editando el de la raíz: cinco arreglos de la Rueda
> que nunca llegaron a la pantalla y un commit inútil. **Antes de editar frontend,
> comprobar cuál sirve el servidor.**
>
> Y al cambiar el frontend hay que **subir la versión de `public/sw.js`**
> (`CACHE = 'bitacora-vN'`), o los clientes siguen con la copia cacheada y parece que el
> arreglo no funcionó.

**Archivos sueltos sin usar:** `spx_backtester.html` en la raíz y un `public/server.js`
duplicado — prototipos previos, no referenciados. Confirmar antes de borrar.

## Persistencia de datos

```js
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
```

Archivos que viven en `DATA_DIR` (no en `__dirname`): `wheel_config.json`,
`nlv_history.json`, `watchlist.json`, `trade_notes.json`, `playbooks.json`,
`spx_config.json`, `spx_signals.json`, `spx_strategy_log.json`, `tradier_executions.json`,
`wheel_trading_config.json`, `wheel_trading_signals.json`,
`wheel_trading_executions.json`, `impuestos_*.json`, `trm_cache.json`.

Todos en `.gitignore` excepto `wheel_config.json` y `nlv_history.json` (seed inicial).

---

# ⚠️ Gotchas que muerden

Los que ya costaron horas o plata. Cada uno tiene su autopsia en el histórico.

### 1. Un push a git NO actualiza la config de producción
`spx_config.json` (pesos, TP/SL, kill-switches) vive en el **volumen** de Railway. Cambiar
los defaults en `server.js` y hacer push **no toca el archivo real**. Hay que empujar el
cambio también vía `POST /api/spx/config` contra la URL de producción, y verificar con
`GET /api/spx/config`.

Caso real (2026-08-12): `gammaFlipBufferPts` se bajó a 10 en el código el día anterior y
producción seguía en 20 — el cambio nunca existió. Histórico § *Config de producción a la
deriva*.

### 2. `POST /api/spx/config` hace merge SUPERFICIAL
Mandar `{trading:{smaReversion:{minScore:75}}}` **reemplaza el objeto `smaReversion`
entero** y borra pesos, kill-switch y todo lo demás. Hay que **leer la config, modificar el
campo sobre el objeto completo, y mandar ese objeto completo**.

### 3. Unidades: dólares totales vs puntos vs precio-por-acción
**El sistema cometió este error tres veces, en tres archivos distintos.** En el bloque
`signal.trading` del webhook:

| | |
|---|---|
| **DÓLARES TOTALES** (ya con los contratos adentro) | `credit`, `debit`, `maxRisk`, `maxProfit` |
| **PUNTOS** | `spreadWidth`, los strikes, `breakeven` |
| **PRECIO POR ACCIÓN** | `entryFillPrice`, `netCredit`, `quote.bid`, `totalCreditAccumulated` |

Convertir siempre con `precio * 100 * contratos`. Histórico § *El gate de Crédito/Riesgo
rechazaba el 100%…*, § *Auditoría 2026-08-03 (bis)*.

### 4. `buildMetrics` recorta a 200 round-trips
El default trunca. Cualquier consumidor que necesite el año completo tiene que pasar
`{ limit: 0 }` — la hoja de Impuestos y **`/api/transactions`** lo hacen. Sin eso el error es
**silencioso**: la hoja fiscal declara de menos, y el calendario deja los meses viejos
**mudos** — la casilla muestra P&L (`stratByDay` se calcula con todo) pero el detalle del día
sale de `metrics.strategies`, que venía recortado. El 2026-09-05, con 304 round-trips,
**56 de 127 días con actividad salían "Sin trades este día"**: febrero y marzo enteros,
abril al 94%. Histórico § *El calendario mudo y el día de +$6.258*.

### 5. No restar comisiones dos veces
El `net-value` de TastyTrade **ya viene neto** de comisiones y fees. `sumarComisiones()`
existe solo para mostrar el dato ante la DIAN.

### 6. El `/gainloss` de Tradier no es un inventario completo
Hay round-trips reales que **no reporta** (dos de BE, verificados). No asumir que la suma
del gainloss es la verdad. Y `/orders` **ignora `start`/`end`: solo devuelve las de HOY**;
`/history` viene vacío en sandbox.

### 7. Órdenes zombi del sandbox bloquean señales nuevas
Las órdenes de prueba quedan `pending` indefinidamente; mientras existan,
`hasOpenPosition`/`hasLocalOpenSPXWPosition` las cuentan como trade en curso.
`cleanupStalePendingOrders` cancela pending >10 min, **pero Tradier puede responder
`HTTP 400 "order not available to be canceled"`** y ese error se pierde en un
`console.error`. Si el sistema deja de generar señales sin motivo, revisar
`tradier.getOrders()`. **Bug abierto:** que el broker rechace una cancelación debería
avisar, no reintentarse en silencio.

### 8. `.git/hooks/` no se versiona
Las copias buenas están en `scripts/hooks/`. En un clon nuevo:
```bash
cp scripts/hooks/post-commit scripts/hooks/pre-push .git/hooks/ && chmod +x .git/hooks/*
```
Sin esto el control de cambios deja de actualizarse **sin avisar** — así llegó a estar 240
commits atrasado.

### 9. TradingView: al aplicar un cambio de código, resetea todos los inputs
Los muros quedan en 0 hasta el próximo push. Correr `gamma_daemon/push_gdv_now.js` justo
después de editar el Pine. Y el editor puede abrir por default una **versión histórica** sin
avisar más que un banner chico — verificar `Version history…` antes de editar.

### 10. Mobile: nunca usar `padding`/`margin` shorthand en `.panel`/`.content`/`.sidebar`
El shorthand resetea las 4 esquinas y pisa el ajuste de `env(safe-area-inset-top)` del
notch de iOS. Había **3 reglas `.panel` duplicadas** en distintos `@media`.

### 11. El sandbox de Tradier rechaza ~6 de cada 10 órdenes, en apagones por bloques
**No es nuestro payload.** Medido el 2026-09-03 con 62 sondas `preview=true` mandando la
misma vertical cada 2 minutos:

| | muestras | fallos | |
|---|---|---|---|
| Mercado **cerrado** | 33 | 0 | **0%** |
| Mercado **abierto** | 29 | 17 | **59%** |

Y no es una franja horaria fija: son **bloques de 10 a 40 minutos** que aparecen y se van.
Ese día: caído 9:30–9:32, bien 9:34–9:44, **caído 9:46–10:24 (38 min seguidos)**, bien
10:26–10:36. Las órdenes reales de producción dan lo mismo o peor — **89% de rechazo el
1-sep** (31 de 35) y **82% el 2-sep** (18 de 22).

Con el mercado cerrado aceptó 33 de 33 la misma orden, con los mismos strikes, que después
rechazó 17 veces. Es el motor de órdenes de Tradier, no nosotros.

⚠️ **Tradier devuelve fallos de su propio servidor bajo un HTTP 400**, con el cuerpo
diciéndolo (`"error":"Unexpected server error"`). Eso es una mina: `_req` no reintenta los
4xx —con razón— así que un fallo transitorio disfrazado de 400 se abandona en silencio.
`esFalloDelBroker()` (`src/apagon_broker.js`) mira **el cuerpo, no el código**.

**Lo que NO se hace:** reintentar más fuerte. Un bloque de 38 min se come cualquier setup de
0DTE, y un `POST /orders` no es idempotente. El reintento sano sigue siendo el ciclo
siguiente de la estrategia. Lo que sí se hace es **decirlo**: un ntfy por bloque (no por
intento — el 1-sep hubo 20 rechazos en 23 min), los eventos `APAGON_BROKER_INICIO`/`_FIN` en
el strategy log con el costo en setups, y `GET /api/spx/apagon-broker` para la Torre.

Histórico § *Los apagones del sandbox de Tradier*.

---

# Reflejos de diagnóstico

| Síntoma | Primer lugar a mirar |
|---|---|
| `HUERFANO_SIN_POSICION` o `ROLL_REAPERTURA_NO_LLENO` repetido para el mismo símbolo | Si `ex.leg` apunta a un contrato que **no está en la cuenta**. Ese es el síntoma raíz del loop de re-adopción |
| Un ciclo de La Rueda muestra la prima entera como ganancia | Falta `pnl` explícito → preguntarle al `/gainloss` **antes** de dar por bueno el crédito acumulado |
| Un arreglo del frontend "no funciona" | ¿Editaste `public/index.html` o el de la raíz? ¿Subiste `sw.js`? |
| Un cambio de config "no se aplicó" en producción | Gotcha 1: push ≠ volumen |
| Las señales dejaron de generarse | Órdenes zombi (gotcha 7) · el daemon de Gamma caído · un gate que cambió de valor |
| Las señales se generan pero **ninguna entra** | `GET /api/spx/apagon-broker` → `enApagon: true` = el sandbox no acepta órdenes (gotcha 11). Si dice `false`, entonces sí es nuestro |
| Los muros/GEX se congelaron | `GET /api/spx/sigma-levels` → `fresh: false` = daemon caído |
| Una hoja no cuadra con otra | El checkbox de "errores de implementación", o dos lecturas separadas en el tiempo (TTL 60s con P&L en vivo) |
| P&L pegado en `pendiente_verificar` para siempre | Orden fantasma del sandbox: patas `filled`, orden padre `open`, posición nunca existió. Se corrige a mano con `pnl: 0` |
| Un endpoint devuelve 500 | Correr `node scripts/pruebas.js --local`. Causa típica: usar `spxConfig` como si fuera global (es un `const` local en 4 funciones) |

---

# Normas del usuario

Estas no son preferencias técnicas, son reglas de trabajo.

1. **Todo ajuste queda documentado.** *"necesito que sea una norma, siempre que cualquier
   ajuste o cambio se documente"*. No es opcional. Ver § Control de cambios.
2. **Cambios de estrategia solo viernes y sábado**, para arrancar el lunes con la semana
   limpia. De lunes a jueves se acumulan en `SUGERENCIAS.md`. Los **bugs sí se arreglan**
   cualquier día.
3. **Congelar cambios de alto impacto hasta juntar muestra** (~30 trades). Desde
   2026-08-04.
4. **La hoja de Impuestos no se despliega a Railway.** Datos personales, URL pública.
5. **Todo el informe va en hora de NUEVA YORK.** Calendario, Reportes, franjas horarias,
   asignaciones, año gravable: cualquier cosa que feche un **día de mercado** usa
   `todayStrET()` / `fechaET()`, nunca `todayStr()` ni `toISOString()`. A partir de las **8pm
   ET la fecha UTC ya es mañana**. `todayStr()` (UTC) queda **solo para rangos de consulta a
   la API**, donde pasarse un día por arriba no rompe nada. Ver histórico § *Reportes no tenía
   ni un cierre AM*.
5. **Un ROLL no es un cierre.** *"el resultado del calendario es lo que cerré hoy… no
   importa si hice roll para septiembre o noviembre, eso no tiene nada que ver."*
6. **Nunca se paga por rolar.** Si ningún strike/fecha da crédito neto, no se rola.
7. **Sigma Terminal es la fuente por defecto** de spot y muros: *"yo en sigma terminal estoy
   pagando"*. Los demás son plan B y C.

---

# La Rueda manual (TastyTrade)

Estrategia de opciones: CSP → Asignación → Covered Call, ciclando.
`buildWheelData(items, positions, underlyings)` en `src/wheel.js`.

**Fases**: `CSP_ACTIVA` → `ACCIONES` → `CC_ACTIVA` → `IDLE`
**Underlyings activos**: JBLU, NU, GAP, SOFI (en `wheel_config.json`)

**Tipos de eventos**: `STO_PUT`/`BTC_PUT`, `STO_CALL`/`BTC_CALL`, `BTO_*`/`STC_*` (patas
**largas** — entran todas, son patas de spread, no coberturas ajenas), `ROLL` (BTC+STO mismo
día, **solo patas cortas**), `STOCK_BUY`/`STOCK_SELL`/`ASSIGNED`, `DIVIDENDO`.

**Esquema de eventos — idéntico en las dos bitácoras (Tasty y Tradier):**

| Evento | Campos |
|---|---|
| `STO_PUT` / `STO_CALL` | `date, type, strike, expiry, contracts, amount` |
| `ROLL` | `date, type, fromStrike, fromExpiry, fromType, toStrike, toExpiry, toType, amount` |
| `ASSIGNED` | `date, type, qty, price, fees, costBasis, amount` |
| `STOCK_SELL` | `date, type, qty, price, amount` |
| `DIVIDENDO` | `date, type, amount, bruto, retencion, costBasis` |

`amount` es **siempre dólares totales** en los dos lados. `costBasis` en
`ASSIGNED`/`DIVIDENDO` es el costo base vigente en ese punto del timeline (`basisAhora()` en
el adaptador de Tradier, `syncBasis()` en `wheel.js`).

Los tipos que solo genera Tasty (`BTC_*`, `BTO_*`, `STC_*`, `STOCK_BUY`) no existen del lado
Tradier: la Rueda automatizada no compra patas largas y la asignación no llega como una
compra de equity separada.

### Reglas de contabilidad vigentes

- **`costBasis` se recalcula completo** con `syncBasis()` después de cada movimiento:
  `costBasis = avgCost − totalPremium / shares`. Una sola fórmula, sin ajustes
  incrementales ni casos especiales.
- **`avgCost` sale del `net-value`** de la compra, no de `price × qty` — así incluye los
  `clearing-fees` de la asignación.
- **Las patas largas cuentan.** No hay forma confiable de distinguir "cobertura" de "pata de
  spread" en el feed, y en ambos casos es dinero real del subyacente.
- **Los dividendos usan el signo, no valor absoluto.** TastyTrade parte cada pago en **dos
  asientos** con el mismo `transaction-sub-type: "Dividend"`: el bruto (Credit) y la
  retención de impuesto (Debit, 30% no residentes). Se consolidan **por fecha** en un único
  evento con `amount` neto más `bruto` y `retencion` aparte. El dividendo **reduce el costo
  base**. No suma a la tabla de Primas/Semana (que solo cuenta patas de opciones).
- **Un vertical consolidado sigue siendo un vertical.** Al fusionar las patas de una
  orden, el evento guarda `longStrike`/`longExpiry`, `legs` y `gross` (bruto sin fees)
  además del neto. Sin eso, un spread ya cerrado quedaba indistinguible de una put
  desnuda: `hedge`/`isSpread` se calculan sobre posiciones **abiertas** y no sobreviven al
  cierre. El timeline lo etiqueta *Bull put / Bear call abierto|cerrado* y muestra los dos
  strikes (`$19/$18`).
- **Una operación = una fila** (`timelineEventos`, decisión del usuario 2026-08-31). El
  timeline es un registro de **operaciones**, no de movimientos de caja: la apertura y su
  cierre se funden en una sola fila, fechada el día del cierre, cuyo importe es el
  **resultado neto** del trade. El bull put GAP 19/18 salía en dos filas separadas por
  cuatro días y un roll en medio (+$21.75 el 27-ago, −$2.25 el 31-ago) y la segunda, roja,
  se leía como una pérdida; ahora es una línea verde de **+$19.50**, con la fecha de
  apertura, los días y el bruto (+$22.00) en la descripción.
  - **El invariante de caja no se rompe**: el importe de la fila fundida es la **suma** de
    los dos flujos, así que la columna VALOR sigue sumando el flujo real del subyacente.
    Verificado en los cuatro papeles. Por eso se funde sumando, no con un número aparte.
  - **La fila funde la cadena entera**, no solo el par apertura/cierre: apertura + los
    `ROLL` que haya en medio + cierre. Un roll no abre ni cierra una operación, la
    **mueve** — es la norma 5 del usuario (*"un ROLL no es un cierre"*) leída al derecho:
    la operación sigue viva hasta el BTC. Se encadena hacia atrás por
    `toStrike|toExpiry` → `fromStrike|fromExpiry`, **con el tipo de opción en la clave**
    (por eso el `ROLL` guarda `fromType`/`toType`), hasta dar con la apertura original.
    Cada roll se consume una sola vez y, si la cadena no llega a ninguna apertura, **no
    se consume nada**: el cierre se queda con su flujo crudo, como antes.
    - Lo que arregló: JBLU 2026-08-18 mostraba *"Put cerrada $6 09-18 −$94.12"* en rojo.
      La operación fue STO $5.5 09-04 el 03-ago (+$15.87) → roll a $6 09-18 el 18-ago
      (+$46.75) → cierre el mismo día (−$94.12): perdió **$31.50**, no $94. Tres veces
      peor de lo que fue, con el roll en otra fila del mismo día. Y el 2026-07-31 pasa
      de −$7.12 en rojo a **+$33.50** en verde.
    - La suma de la cadena se guarda con **tres** decimales, la misma precisión con la
      que `src/wheel.js` guarda cada flujo (`+nv.toFixed(3)`). Redondeando a dos se
      perdía medio centavo por cadena y JBLU cerraba en −$444.96 en vez de −$444.97.
    - Un cierre que sigue sin apertura tras encadenar se queda con su flujo crudo en vez
      de inventarle una: queda uno, `STC_PUT $24 06-18` de GAP (la pata larga del bull
      put 27/24, cuyo `BTO` se absorbió en la consolidación por orden). Las posiciones
      **abiertas** siguen mostrando la prima cobrada.
  - `semanalHtml` trabaja sobre los eventos **crudos** con su propia atribución por semana.
    Las dos vistas coinciden porque comparten el emparejamiento (`claveOpt`), no la lista.
- **La fase no puede tapar una pata abierta.** `phase` es UNA etiqueta para un estado que
  puede tener tres patas a la vez, así que el orden decide qué se ve y qué se esconde. Con
  `if (openPut)` primero, NU salía *"CSP Activa"* el 2026-08-31 teniendo 200 acciones, 2
  covered calls $14 11-20 y solo de tercera una put $14 09-18. Ahora manda tener las
  acciones (`openStock || shares > 0` → `CC_ACTIVA` si hay call, si no `ACCIONES`) y la put
  de un ciclo nuevo no cambia la etiqueta. Lo que ninguna etiqueta sola puede resolver se
  resuelve en **POSICIÓN**, que dejó de ser un `? :` encadenado y **lista todas** las patas:
  *"200 acc + $14.00 Call · 11-20 · 2 ctr + $14.00 Put · 09-18"*. `w.phase` es solo de
  presentación — el `phase` de `server.js` es el de la Rueda **automatizada**, otro objeto.
- **La clave que empareja cierre con apertura lleva el tipo de opción**
  (`P|19|2026-09-04`), no `strike|expiry` a secas, y el índice guarda **todas** las
  aperturas de esa clave en orden — un cierre consume la última **anterior** que siga
  libre. Con la clave vieja una Put $12 06-18 y una Covered Call $12 06-18 colisionaban.
  Misma regla en el timeline y en Primas/Semana, así las dos vistas no pueden
  contradecirse.
- **Los íconos de dirección se derivan del signo del monto** (`evIconFor(e)`), no de la
  dirección de la operación — si no, un cierre que costó dinero salía con flecha hacia
  arriba al lado de un monto negativo. `ROLL` y acciones/dividendo mantienen ícono propio.
  `evLabelFor(e)` etiqueta un `DIVIDENDO` negativo suelto como *"Retención dividendo"*.
- **`checkWheelDividends`** (cada 6h, lado Tradier) guarda el **neto por fecha**, no evento
  suelto. Solo mira ciclos en `ASIGNADO`/`CC_ACTIVA`. ⚠️ **El shape de los eventos de
  dividendo no está verificado contra un caso real** — la cuenta es sandbox y
  `getAccountHistory` devuelve vacío. `parseDividendEvent` acepta varias formas posibles en
  vez de asumir una.
- **Compatibilidad con registros viejos**: los ciclos anteriores a los campos nuevos
  (`stockCostBasis`, `shares`, `assignedStrike`, `assignedAt`, `dividends[]`) caen al
  comportamiento anterior (strike nominal × acciones, sin fees, prima de la Call inicial en
  0) en vez de romper o inventar.

Historia completa (tres auditorías, con los números antes/después de cada card):
histórico § *Auditoría 2026-08-03*, § *Auditoría 2026-08-03 (bis)*, § *Esquemas alineados*,
§ *Dividendos: un pago = un evento*, § *El spread cerrado que se leía como pérdida — GAP
19/18 (2026-08-31)*.

---

# Tablas y reportes

### Primas/Semana (`semanalHtml`)
Solo P&L **realizados**:
- `ROLL` → siempre incluido (ya es neto)
- `BTC` → busca su `STO` por `tipo|strike|expiry` —y si no está, **encadenando los rolls**
  (`resolverCadena`, el mismo del timeline)— y muestra el **neto** en la semana del cierre.
  El roll **no se mueve de su semana**: la cadena solo sirve para recuperar la apertura, así
  que sumando por semanas el total coincide con el timeline sin contar el roll dos veces.
  Antes, la put JBLU $5.5 09-04 rolada a $6 09-18 y cerrada el 18-ago se daba por **viva** y
  su prima quedaba excluida en silencio esperando un expiry que ya no iba a llegar: la
  semana del 18-ago decía −$47.37 en vez de −$31.50 y JBLU sumaba **$67.24 en vez de $83.11**
- `STO` sin BTC y expirado → prima en la semana del **expiry**
- `STO` aún abierto → **excluido silenciosamente**
- `STC` → igual que `BTC` pero contra su `BTO` (índice `btoIndex`), para que un spread no
  aparezca como pérdida una semana y ganancia otra
- `BTO` sin `STC` y expirado → la prima pagada se perdió entera, se muestra en el **expiry**

### Desglose Mensual (Reportes)
**La columna P&L es SIEMPRE `strategyByMonth`** (realizado de los round-trips cerrados). El
delta de NLV tiene su propia columna y con filtro de fechas se muestra vacío (`—`) en vez de
mentir: es dato de cuenta, no se puede recortar por rango.

No mezclar nunca las dos: `nlvByMonth` se calcula contra el **NLV en vivo**, así que el mes
en curso se mueve minuto a minuto con las posiciones abiertas. Histórico § *Tabla Desglose
Mensual*.

### Curva de Capital
Desplegable: Acumulado / **Δ Net Liq** / **Realizado**. "Realizado" sale de
`metrics.stratByDay`/`strategyByWeek`/`strategyByMonth` — **la misma fuente que Reportes**,
así los dos lugares no pueden contradecirse.

**El capital de arranque se lee del ledger, no se escribe a mano.** Estuvo fijo en `10644`
hasta el 2026-09-05, cuando lo depositado eran **$10.676,03** (tres depósitos: $1,00 el 9-feb
y $10.666,04 + $8,99 el 12-feb): $32,03 de desfase en el punto de partida y en el pico contra
el que se mide el drawdown. Ahora `/api/curve` suma los `Money Movement` de sub-tipo
`Deposit`/`Withdrawal`: los anteriores al primer día operado forman el `initial`, y un
depósito o retiro posterior mueve la curva **su propio día** (o la curva se despegaría del
Net Liq). Se mantienen **fuera de `byDay`** a propósito: `byMonth`/`byWeek` son P&L, y un
depósito no es un resultado. Hay chequeo de humo.

Snapshots de NLV:
- Todo lo que fecha un día de mercado usa **`todayStrET()`**, no `todayStr()` (UTC).
  `todayStr()` queda solo para rangos de consulta a la API.
- El snapshot diario dispara con **`msUntilET(16, 35)`**, no un offset UTC fijo (en EST un
  `20:35 UTC` clavado disparaba a las 3:35pm ET, con el mercado abierto).
- El snapshot de **arranque** usa `{ overwrite: false }`: rellena huecos, nunca pisa el de
  las 4:35pm.
- Los de fin de semana se descartan **al leer** (`dropWeekendSnapshots`), para limpiar
  también lo ya guardado en el volumen de Railway, donde el archivo no se puede editar a
  mano. ⚠️ `NLV_SEED` se repone encima porque **`2026-02-28` es sábado a propósito** (cierre
  de mes cargado a mano). Hay test.

**Limitación en pie:** si un mes se queda sin snapshot en sus últimos días de mercado, ese
resultado se le acredita al mes siguiente — no se pierde ni se duplica, pero se corre de mes.
No hay forma de repartirlo sin el dato.

### Cierres parciales
`src/metrics.js` — el inventario FIFO lleva **cantidad** (`legQty`): un cierre consume solo
los contratos que cierra, prorratea el valor de apertura y deja el resto en el stack. Si el
feed no trae cantidad fiable (Receive Deliver antiguos, acciones) se consume la entrada
entera, como antes. La cantidad **se acumula al fusionar fills** del mismo símbolo+acción —
sin eso el prorrateo consumiría una fracción equivocada.

Banderas `partialClose` (el cierre dejó contratos vivos) y `positionOpen` (el
subyacente+vencimiento todavía tiene posición, exigiendo vencimiento futuro para que una
opción vieja sin transacción de expiración no quede colgada para siempre). Los `Roll` se
excluyen de `positionOpen`. En la pestaña **Hoy** salen como badge ámbar "Parcial".

`_legs` cuenta **símbolos distintos**, no pares — contar pares convertía un cierre simple en
"Iron Condor" (la regla `_legs === 4`).

Las columnas **Apertura/Cierre** usan el **signo real** (`f$` + `cc`), no valor absoluto con
signo forzado: en una pata larga la apertura es un débito y el cierre un crédito, así que la
fila se leía al revés. Estaba repetido en Hoy, Historial, Reportes, Calendario, el modal del
calendario y el journal.

Invariante de verificación: para un vencimiento donde todo se abrió y cerró, la suma de P&L
tiene que dar igual al flujo de caja crudo de esos contratos. **39 de 39 cuadran.**

Invariante del libro entero, la que caza lo que la anterior no ve: **caja = P&L realizado +
valor de las patas que siguen vivas**. Medido feb–ago 2026 el 2026-09-05: caja −$5.734,51 =
realizado −$1.514,69 + patas vivas −$4.219,81 (residuo $0,01). Antes de arreglar las
expiraciones y los rolls esa cuenta se iba por ~$6.000.

### Bitácora Tradier — coherencia entre hojas
Dashboard, Historial, Reportes, Calendario y Hoy pasan **todas** por
`fetchTxnsTradier()` → `/api/transactions-tradier` → `metrics.strategies`. Dos cosas al
comparar:

- **El checkbox de errores de implementación es lo que separa los números.** Las cinco hojas
  lo traen desmarcado por defecto (excluyen los trades marcados como bug) y por eso
  concuerdan entre sí. Los agregados del server (`metrics.totalPnL`, `strategyByMonth`)
  **no conocen ese filtro** y siempre van a dar otro número. El filtro se aplica **antes**
  de `consolidateStrategies` — consolidar primero mezclaría una pata marcada con una sana en
  la misma fila.
- **Comparar siempre sobre UNA sola lectura.** TTL de 60s y P&L en vivo: dos consultas
  separadas por minutos en día de mercado dan números distintos sin que haya ningún bug.

### `buildMetrics` (`src/metrics.js`)
- **Rolls — se encadenan, no se cobran**: "to Close" + "to Open" del mismo tipo (C o P) en la
  misma orden. El leg de cierre consume el inventario viejo y su valor de apertura **se
  arrastra a la pata nueva** (a prorrata de contratos si hay varias), junto con la fecha de
  apertura original. El roll **no emite fila propia**: la operación sigue siendo una sola y su
  P&L completo aflora el día del cierre real. Es la norma 5 del usuario (*"un ROLL no es un
  cierre"*) y el mismo encadenado que hace `src/wheel.js`.
  Única excepción: si no hay nada que arrastrar (la pata vieja se abrió fuera del rango
  pedido) se registra el neto del roll como evento suelto, o se perdería.
  Hasta el 2026-09-05 el roll emitía `pnl = order.netValue`, lo que **inventaba resultado en
  el calendario, tiraba el valor de apertura de la pata vieja y contaba dos veces el crédito
  de la nueva**. 54 rolls, $1.162,55 de P&L que no existía. Histórico § *El calendario mudo y
  el día de +$6.258*.
- **Los `Receive Deliver` a $0 sí cierran patas** — la regla completa, que costó tres bugs:
  | Sub-tipo | ¿Entra? | Por qué |
  |---|---|---|
  | `Expiration` | **Sí** | Es la única transacción que registra que la pata venció |
  | `Assignment`/`Exercise` **con** `Cash Settled` del mismo símbolo+fecha | **No** | Es su acompañante: cerraría la pata dos veces |
  | `Assignment`/`Exercise` **sin** `Cash Settled` | **Sí** | Asignación que entrega **acciones**: es el único evento que cierra la opción |

  El último caso dejaba dos cortas vivas para siempre con su prima sin realizar (GAP $27 06/18
  asignada el 29-may en 100 acciones, +$279,87; NU $13 06/05 el 3-jun en 200, +$144,71 con su
  cadena de rolls).
- **`openByDay` es CAJA, no resultado**: el neto de **toda** orden que abra algo ese día —
  aperturas de crédito, de débito y rolls, cada una con su signo. Un día puede salir en rojo.
  Hasta el 2026-09-05 era `if (o.isOpening && o.netValue > 0)`, que borraba las de débito:
  22 días de 127 inflados, $14.088,50 de exceso, y el 29-may mostraba **+$187 en un día donde
  salieron $2.518** (la asignación de GAP, 100 acciones a $2.705).
- **`movimientos`**: una fila por orden (`Apertura` / `Roll` / `Cierre`) con su neto de caja y
  un resumen de strikes/vencimiento. Es lo que alimenta el detalle del día en el Calendario:
  `strategies` solo conoce round-trips **cerrados**, así que un día con cinco órdenes mostraba
  dos filas — las aperturas de posiciones vivas y los rolls no existían para la pantalla.
  Las filas de `Apertura` y `Roll` van **sin P&L y no suman a la casilla**.

**El resumen del mes** (arriba a la derecha del Calendario, y en la PWA del iPhone) trae tres
números: **Ejecutado** (realizado que cerró en el mes), **Abierto** (`abiertoByDay` — de lo que
se abrió ese mes, lo que **sigue abierto hoy**, valorado a lo que costó con todo lo que se le
sumó rolando) y **Total**. Solo del mes que se mira, sin acumular otros meses.

⚠️ **`abiertoByDay` NO es la suma de la caja diaria.** `openByDay` solo descuenta los cierres
del MISMO día, así que sumado por mes cuenta entera la prima de una posición abierta y cerrada
dentro del mes: febrero daría **+$3.158 de "abierto" sin tener ni una pata viva**. Se toma el
**valor de las patas que quedan en el inventario**, fechado en la apertura original de la
campaña — y no una fracción del neto de la orden, porque en una cadena de rolls la pata viva
carga el arrastre de toda la campaña. Con el valor real, **la suma de todos los meses da
exactamente el costo de lo abierto**, y por tanto `Σ(Ejecutado) + Σ(Abierto) = la caja real`.
Hay test.

El detalle del día va en **dos bloques con su propio subtotal**, porque son dos preguntas
distintas: **CERRADO** (lo que dejó resultado — su subtotal es exactamente la casilla del
calendario) y **CAJA** (rolls y aperturas — lo que entró o salió de la cuenta, que se realiza
el día que esas posiciones cierren). Los dos números van también en la cabecera del panel.
Orden de columnas: **el P&L va antes que la Prima** — lo primero que se mira es lo que se
obtuvo.

⚠️ **Un intradía no deja caja en juego.** El campo `vivo` de cada movimiento descuenta lo que
se cerró el MISMO día, y tanto `openByDay` como el bloque CAJA usan `vivo`, no `net`. Sin eso
un trade que abre y cierra el mismo día salía en los **dos** bloques: su P&L en CERRADO y otra
vez su prima en CAJA. Lo cazó el usuario el 2026-09-05 mirando el bear call de SPX del 4-sep.

**La proporción se mide en CONTRATOS, nunca en dinero.** El valor de apertura de una pata
nacida de un roll viene **arrastrado** de días anteriores, así que restarlo del neto de la
orden mezcla dos cosas distintas: el roll de COIN del 31-jul daba `vivo` **192,12** sobre un
neto de **19,75**. Por eso la pata del inventario guarda `orderDate` (el día en que nació esa
pata) aparte de `date` (la apertura original de la campaña, que es lo que usa la duración):
sin `orderDate`, un roll cuya pata nueva muere el mismo día no se detectaba.
- **P&L neto, no bruto**: usa `net-value` (ya incluye fees regulatorios). TastyTrade muestra
  bruto. Diferencia típica $1-2.50 por leg.
- **La franja horaria (`getAmPm`) va en hora de NUEVA YORK, nunca en UTC.** Cuatro cubos:
  `Pre-market` / `AM (9-12h)` / `PM (12-16h)` / `After-hours` — los que `timeOrder` del
  frontend ya esperaba. Estuvo comparando `getUTCHours() < 13` contra un umbral pensado en
  hora del mercado: como abre 9:30 ET = **13:30 UTC en verano y 14:30 en invierno**, la
  condición **no se cumplía nunca** y Reportes enseñaba el 100% de los cierres como PM. Eran
  164 de 266 (62%) de la mañana. `src/metrics_tradier.js` ya lo hacía bien con `Intl` — el
  arreglo existía a un archivo de distancia y nunca se retropropagó. Hay test para verano e
  invierno.
- **La franja horaria (`getAmPm`) va en hora de NUEVA YORK, nunca en UTC.** Cuatro cubos:
  `Pre-market` / `AM (9-12h)` / `PM (12-16h)` / `After-hours` — los que `timeOrder` del
  frontend ya esperaba. Estuvo comparando `getUTCHours() < 13` contra un umbral pensado en
  hora del mercado: como abre 9:30 ET = **13:30 UTC en verano y 14:30 en invierno**, la
  condición **no se cumplía nunca** y Reportes enseñaba el 100% de los cierres como PM. Eran
  164 de 266 (62%) de la mañana. `src/metrics_tradier.js` ya lo hacía bien con `Intl` — el
  arreglo existía a un archivo de distancia y nunca se retropropagó. Hay test para verano e
  invierno.
- **FIFO**: empareja con la apertura más cercana en fecha. Multi-leg se consolida por
  `closeOrderId + underlying + closeDate`.

---

# SPX — los tres pipelines automáticos

Tres estrategias independientes y en paralelo, todas ejecutando en **Tradier sandbox**.
Root correcto para las semanales/0DTE de SPX en Tradier: **`SPXW`** (no `SPX`, que es solo
mensual) — confirmado contra su sandbox real.

`getETHour()` (`src/spx.js`) usa `America/New_York` real vía `toLocaleString`, no un offset
fijo — se ajusta solo con EDT/EST.

**Las tres tienen guard de `isMarketHours()`** (valida fin de semana **y** feriados NYSE).
Sin él corrían sábados y domingos: un solo fin de semana metía ~1.600 evaluaciones al
`spx_strategy_log.json`, que está topado en 5.000, y desalojaba el diagnóstico de los días
reales.

| | ventana ET | cadencia |
|---|---|---|
| Direccional (TENDENCIA) | 9:45–14:00 | 30s |
| Reversión (REVERSION) | 9:30–13:00 | 60s |
| Iron Condor 0DTE (NEUTRAL) | 10:00–13:00 | 5 min |
| Iron Condor 1DTE | 15:45–15:52 | 5 min |

Verificado que las cuatro caen **enteras** dentro de 9:30–16:00. Si alguna se corre fuera de
ese rango, revisar el guard primero.

Cada estrategia se distingue con **`strategyFamily`** (`'TENDENCIA'` / `'NEUTRAL'` /
`'REVERSION'`) en `spx_signals.json` y `tradier_executions.json`. Reversión y Direccional
comparten los mismos literales de `strategy` (`'BULL_PUT_SPREAD'`/`'BEAR_CALL_SPREAD'`) a
propósito, para heredar gratis `findStrikesByDelta`, `placeSpreadOrder`, la lista blanca de
auto-ejecución y `checkTradierExecutions`.

## 1 · Direccional — CIARG_V1 + Camino B

**Flujo**: `checkDirectionalAutonomous()` calcula Camino B por su cuenta cada 30s con velas
de Tradier — ya no depende del webhook de TradingView (que sigue existiendo y dispara el
mismo chequeo compartido). Después: revalidación independiente (confluencia Weinstein, score
del playbook, ventana horaria), strikes reales de la cadena, y auto-ejecución de las **4
verticales** direccionales (Bull Put, Bear Call, Bull Call, Bear Put).

El indicador de TradingView solo dispara la alerta de entrada (BULLISH/BEARISH); **no manda
contexto 15m ni stop técnico** — el servidor calcula esas dos cosas por su cuenta y **no
confía en lo que diga Pine**. El **Camino A** (retroceso clásico del mentor) está desactivado
como disparador desde el backtest de 58 días: 48.8% WR y P&L negativo en 41 señales, contra
67.8% WR / +$975 del Camino B. Se sigue calculando y mostrando en la tabla de info.

**Gate de posición real, no throttle de tiempo.** El throttle de 10 min se eliminó del todo:
`calcCaminoB` solo calcula alineación y no lleva estado. Antes de evaluar nada,
`checkDirectionalAutonomous` corre `tradier.hasOpenPosition('SPXW')` +
`hasLocalOpenSPXWPosition()` (gana el más conservador; esta última trata `submitted` como
abierto, así que cubre la ventana entre "orden enviada" y "fill confirmado"). Si hay
posición, no se evalúa ese ciclo. Una orden que no llena se libera sola vía
`cleanupStalePendingOrdersImpl`. El chequeo que sigue existiendo **dentro** de
`processDirectionalEntry`, justo antes de mandar la orden, es la última red contra una
condición de carrera.

*Regla del usuario:* **"la única activación para el siguiente trade sería cuando el trade
abierto se cierre"**. Histórico § *Camino B autónomo*.

**La dirección la fija el marco de 15m, y solo él** (`calcPullbackEntry`, `src/camino_b.js`):
```js
const dir = fase15.bull ? 1 : -1;
```
El 2m no aporta dirección, solo el *timing* (cruce o roce de la EMA10), siempre a favor de lo
que diga el 15m. Ver § Decisiones abiertas — este filtro tiene un atraso medido de horas y
está **diagnosticado sin cambiar**.

**Score del playbook — "Peso de la Evidencia"**, `calcPlaybookScore`
(`src/spx_indicators.js`). `minScore` **80** (regla de Alejandro: los 3 Mundos alineados
tienen que dar más de 80/100). Pesos documentados — **la autoridad es `spx_config.json` en el
volumen**, ver gotcha 1:

| check | peso | nota |
|---|---|---|
| `fase_weinstein` | **45** | Fase 2m y 15m coinciden con la dirección (2 alcista / 4 bajista). El gate de confluencia ya lo exige, así que en la práctica siempre vale 45 dentro del score de una señal que llega a evaluarse — intencional |
| `patrones_estructurales` | 20 | Higher-Low / Lower-High (`calcSwingStructure`), sobre los últimos 3 fractales de Williams 15m |
| `macd_cruce_pendiente` | **15** | Compara la **línea** del MACD contra **3 velas atrás** (`macd.linePrev3`), no el histograma vela-a-vela — demasiado ruidoso (podía dar negativo en una vela suelta con la línea claramente en ascenso) |
| `regimen_institucional` | 10 | Signo del GEX. DEX no está implementado — ver § Decisiones abiertas |
| `ema_10_20_alineadas` | 10 | Fusión de los viejos `emas_alineadas_15m` + `precio_cerca_ema` |
| `volumen_rompimiento` | **0** | Nunca pasó ni una vez en 44 señales. Se sigue calculando y mostrando |
| `confirmacion_algoritmica` | **0** | Camino A solo, como gatillo, es perdedor neto. Se sigue calculando |

Los checks `precio_ema200`/`emas_alineadas_diario` se retiraron: la fase Weinstein real es
una medida mucho más directa. `loadSPXConfig()` migra `spx_config.json` de forma
**no-destructiva** (detecta la clave que falta y reemplaza solo `weights`, preservando
`trading`) — pero conviene verificar con `GET /api/spx/config` después de cada deploy.

⚠️ **Los scores de TENDENCIA se apilan arriba**: sobre 361 eventos, mediana **90** y 146
valen exactamente **100**. No hay masa entre 90 y 100, así que **subir el listón de score
casi no muerde** — para cambiar comportamiento hay que mover la salida, no la entrada.

**Crédito vs débito** (`selectStrategy`, `src/spx.js`): **Gamma NEGATIVO fuerza débito**
(`gammaForcesDebit`), sin importar IV Rank/VIX — vender prima en un régimen "motor" de
movimiento explosivo, donde el precio puede volar el SL antes de que el tiempo compense, es
la combinación que el playbook marca como más peligrosa. Gamma positivo decide por
`ivRank > 30 || vix > 20`. No afecta al Iron Condor, que ya exige GEX positivo por su gate.

**Ventanas de `selectStrategy`**: 9:45am–3pm ET para 0DTE, 3:45–3:50pm para 1DTE. ⚠️ Hay un
**hueco sin ventana operable entre 3pm y 3:45pm**.

**Parámetros de trading** (`spxConfig.trading`): `targetDelta: 0.30`, `tpPct: 30`,
`slMult: 1.5`, débito `tpPct/slPct` 30/50 (el TP del débito se unificó con el del crédito a
pedido del usuario — no afecta retroactivamente a posiciones abiertas, `debitTpPct` se
congela en el registro al crearlo). ⚠️ El default de `targetDelta` en `server.js` sigue en
`0.40` — **no coincide a propósito** con producción: si se borra `spx_config.json` del
volumen, el sistema cae al 0.40 sin avisar.

**Gates que se aplican después del score:** Crédito/Riesgo ≥20% (`MIN_CREDITO_RIESGO_PCT`,
**exento para débito** — es conceptualmente un chequeo de crédito y para débito daba un ratio
sin sentido), `minShortDistPts` 25, y el piso de **1.5× ATR15m** para el stop técnico.

⚠️ El fix usa **`signal.maxRisk`**, que `buildSignalSummary` ya calcula bien en dólares y con
los contratos adentro, en vez de re-derivar el riesgo en el call site — que es exactamente
cómo las dos fórmulas se separaron. Ver gotcha 3.

### Stop técnico — POC + Fractal 15m, con piso de 1.5× ATR
`signal.fractalLevel` (el fractal del lado que invalida) y `signal.pocLevel` (perfil de
volumen de la sesión de HOY en velas de 15m, cubetas de $1 sobre `(H+L+C)/3`, `calcPOC`) se
**congelan** en el registro al entrar — no se recalculan en vivo. Sin datos de volumen
`calcPOC` devuelve `null`, no un POC engañoso.

`checkDirectionalTPSLImpl` cierra con `TECHNICAL_STOP` si el precio rompe **cualquiera** de
los dos (no hace falta que rompan ambos), **antes** de evaluar el stop económico. Lectura
literal del material: *"si rompe el POC… debes salir, incluso si no tocaste el stop
económico"*.

**Cada nivel tiene que estar a ≥1.5× ATR15m de la entrada**; si está más cerca, ese nivel
se pone en `null` y no gatilla esa vez. Los dos se evalúan independientemente. Sin ATR
calculable (primeros minutos tras la apertura), el nivel se deja activo — **la falla segura
es hacia NO relajar la protección** cuando falta el dato.

Por qué: un clúster de 5 trades el 2026-07-23 cerró 4 en pérdida por `TECHNICAL_STOP` con el
Fractal a 0.65–1.14× ATR de la entrada, o sea dentro del ruido de una sola vela de 15m (el
ADX estaba en 51-53, o sea que la tendencia sí era fuerte — no era un mercado lateral no
detectado). Simulado con Black-Scholes, **las 5 habrían tocado el TP**. Diferencia:
−$1.960 vs +$732 en un solo clúster.

*No implementado a propósito:* ensanchar el nivel a `entrada ± 1.5×ATR` en vez de anularlo —
se prefirió no inventar un nivel que no viene de un fractal/POC real. Histórico § *Piso de
distancia mínima*.

Las ejecuciones abiertas antes de este mecanismo no tienen `fractalLevel`/`pocLevel` (quedan
en `null`): simplemente no tienen gatillo técnico, siguen protegidas por el stop económico.

### Impulsos de 15m — escalera de TP (`src/impulsos.js`, 2026-08-27)
`contarImpulsos({velas, direction})` sobre las velas de 15m **de la sesión en curso**
(`velas15mSesionOHLC()` en server.js — recortadas al día ET a propósito: el impulso se cuenta
desde el extremo del DÍA, arrastrar las de ayer haría que el origen cayera en otra sesión).
Zigzag **por retroceso**, no pivotes de N barras (un fractal de N barras se come los impulsos
cortos y confirma N barras tarde, justo cuando ya no sirve para decidir). Umbral
`max(4 pts, 1,2 × mediana del rango de las velas del día)` — 5 puntos son mucho en una sesión
comprimida y poco en una de 70 de rango.

| | |
|---|---|
| **Listón de score** | Impulso alcista **3+** exige `minScore` **90**. Con dos motivos para elevarlo (pérdida previa e impulso tardío) manda **el más alto**, no el último evaluado |
| **Escalera de TP** | Impulso 1 → **35%** · impulso 2 → el de config (**30%**) · impulso 3+ → **15%** |

⚠️ **La regla es ALCISTA y no se puede espejar.** En bajista los datos dicen lo contrario y
con más casos: impulso 3+ bajista da **80% de aciertos y +$540 (n=10)**, contra 17% y −$225
del bucket alcista equivalente (n=6). Aplicarla a las dos direcciones porque "suena
razonable" rompería la mitad bajista.

El impulso 2 no se toca porque es el bucket que mejor anda (73%, +$500). **El SL no se
toca** — el pedido fue cobrar antes, no arriesgar menos; mover las dos puntas a la vez
dejaría sin saber cuál hizo el efecto.

El TP efectivo se aplica en **un solo punto** (donde se calcula `tpPct`, antes de construir
`signal.trading`) para que la UI, el `tpTarget` mostrado, el `tpPctDebito` de la sombra del
muro y el umbral que de verdad ejecuta el monitor digan todos lo mismo. Aplicarlo solo al
grabar la ejecución haría que la señal anunciara 30% y el monitor cerrara en 15%.

La lectura se calcula **una vez**, antes del gate de score, y esa misma se cuelga de la señal
(`signal.impulso`), se loguea como stage `IMPULSO` y se congela en la ejecución.
Recalcularla después la haría sobre velas potencialmente distintas y el registro dejaría de
explicar la decisión que de verdad se tomó.

**Falla abierta a propósito:** con menos de 4 velas de sesión no devuelve número
(`aplica:false`, típico en los primeros 45 min) y **no se sube nada** — una entrada tan
temprana es impulso 1 ó 2 por definición, que es justo lo que no hay que encarecer.

Cubierto por `scripts/pruebas.js`, bloque *El conteo de impulsos*, incluida una prueba de que
en bajista **nunca** encarece la entrada y otra que fija el listón en 90 exacto, para que
moverlo obligue a actualizar la prueba. Backtest y robustez: histórico § *Impulsos de 15m*.

### Veto de muro
`evaluarVetoMuroSombra` marca **solo en BEARISH**. En alcista se midió y no predijo nada
(brecha 3,6 pp; los 4 trades abiertos con el precio ya pasado el Call Wall ganaron los 4).
Las dos asimetrías —esta y la de impulsos— son opuestas y cada una está sostenida por su
propio backtest.

### Sizing
`sizeContractsByScore(score)`: **1 contrato en general, 2 si el score fue ≥90%**. Aplica al
Direccional (usa `playbookResult.score`). **Es temporal y reversible**, "mientras afinamos
todo" — para volver al sizing por % de capital, la fórmula anterior era
`Math.max(1, Math.floor(capital*pct/(width*100)))`. Reversión usa su propio método
(`sizeContractsByRisk`, ver abajo); IC y Long Put Condor quedan fijos en 1.

## 2 · Iron Condor (0DTE + 1DTE)

**No depende de una alerta de Pine** — CIARG_V1 nunca manda `direction: NEUTRAL`, y el gate
obligatorio de confluencia Weinstein (fase 2/4) es incompatible con la tesis del IC (rango,
sin tendencia). `checkIronCondor()` corre cada 5 min evaluando `buildSPXContext()` contra
`evaluateIronCondorGate(ctx, dte)` — gate propio, playbook Alejandro.

**0DTE**: GEX positivo + buffer de Gamma Flip + setup por PIN + corte `noAbrirDespuesET`
(14:30) + rango de apertura 9:30-10:00 respetado (y solo desde las 10am).

**`useDebit = ctx.ivRank < ivRankThreshold`** (25) → **Long Put Condor de débito** en vez de
crédito: con IV Rank bajo vender prima es operar sin ventaja (primas comprimidas obligan a
pegar las alas al precio), y el débito tiene Vega positiva, se beneficia si la volatilidad se
expande. Se usan **puts** y no calls porque el skew hace que paguen mejor prima, o sea que
para un débito se paga menos neto.

Construcción (`findStrikesByDelta('DEBIT_PUT_CONDOR', ...)`): 4 patas, todas puts, de mayor a
menor strike — `outerHigh` (comprada, cerca del precio) > `innerHigh` (vendida, por delta) >
`innerLow` (vendida, `innerHigh − bodyWidth`) > `outerLow` (comprada, `innerLow −
spreadWidth`). *Nota:* 0DTE muy cerca del cierre tiene la curva de delta casi vertical y
puede no encontrar strike en el rango objetivo — es esperado, no es bug.

**Gate de crédito/ancho** `minCreditoAnchoPct`: es crédito/**ANCHO** directo, distinto del
gate de crédito/**riesgo** de las direccionales. La "regla del tercio" del playbook pide
~33%, el usuario eligió 25%. **Se mide contra el fill real, no el estimado**: la orden va
como `type: credit` con `price` = el crédito mínimo exacto (`minCreditPrice`) — si el mercado
no lo da, la orden **no llena**, en vez de ejecutar a mercado y tener que cerrarla por no
cumplir el gate, pagando comisión de apertura y cierre por una posición que nunca debió
entrar. Ídem `maxDebitPrice` para el débito. Las que no llenan las limpia
`cleanupStalePendingOrdersImpl`.

**Kill-switch propio** (`ironCondor.tradierAutoExecute`), separado del de las direccionales.
Ambas variantes comparten `strategyFamily: 'NEUTRAL'` y el mismo dedup — no pueden dispararse
las dos el mismo día para el mismo `dte`.

### ⚠️ MODO CAPTURA del 1DTE — la única condición que bloquea es el GEX
> *"entremos sin condiciones… pongamos solo como restricción de entrada estar en gamma
> positivo, solo eso"* · *"nada debe bloquear el IC 1DTE"*

`spxConfig.trading.ironCondor.soloGammaPositivo1DTE: true`.

| | |
|---|---|
| **Bloquea** | GEX POSITIVO, y estar en la ventana **15:45–15:52 ET** |
| Se evalúa pero **no** bloquea | distancia al Gamma Flip, VIX>24, calendario económico |
| **No aplica** al 1DTE | el PIN y el corte `noAbrirDespuesET` (son del 0DTE; el 1DTE retorna antes de llegar a ellos) |
| **No lo bloquea** | la exclusividad de posición: `checkIronCondor` se saltea ese bloque entero cuando `dte === '1DTE'` |

Sigue filtrando después del gate, en `server.js` y **sin distinguir dte**:
`minShortDistPts` (25) y `minCreditoAnchoPct`.

La ventana es de **7 minutos** a propósito: el ciclo corre cada 5 min con fase libre, así que
7 garantizan que caiga un tick adentro. ⚠️ **Consecuencia: hay 1 o 2 intentos por día, no
más.** Si el sandbox responde HTTP 500 en ese rato (pasó el 2026-08-12: 22 órdenes rechazadas
seguidas por *"An error occurred while communicating with the backend"*), **se pierde la
entrada del día** y no hay reintento.

**Salida**: `sinStop1DTE: true` — **no tiene stop**. Sale por TP 30% o por `cierre1DTE_ET`
(10:30 del día siguiente). Riesgo acotado solo por el ancho: 1 contrato × 5 = **$500**.

Validado en vivo el 2026-08-12 contra la cadena real: resuelve correctamente el vencimiento
de **mañana**, y con delta 0.10 las cortas quedan a ~59 pts del spot, muy por encima del piso
de 25 que sí mata al 0DTE en días comprimidos.

**Calendario económico** (`checkHighImpactUSEventsTomorrow`): consulta el **próximo día de
mercado** (salta fin de semana — un IC 1DTE abierto un viernes expira el lunes). Endpoint no
oficial de Investing.com
(`endpoints.investing.com/pd-instruments/v1/calendars/economic/events/occurrences`,
`country_ids=5` = EE.UU.), sin auth; hay que unir `events` con `occurrences` por `event_id` y
filtrar `importance === 'high'` ("3 estrellas", a pedido explícito del usuario — no se filtran
otros países ni impacto medio/bajo). **Puede cambiar sin aviso.**

⚠️ **Desde el modo captura ya NO bloquea**, solo se registra en
`condiciones.calendarioVerificado`/`.eventosManana`. Verificado 2026-08-12: hoy devuelve
**HTTP 403** con las cabeceras exactas del server, así que `calendarioVerificado` viene en
`false` siempre — irrelevante bajo el modo captura. La distinción sigue viva en el código:
`null` = no se pudo verificar, `[]` = verificado y sin eventos.

**Sizing**: IC y Long Put Condor quedan **fijos en 1 contrato** — no tienen un score 0-100
real (son una serie de gates booleanos), así que la regla de "2 si ≥90%" no tiene un número
al que aplicarse. Haría falta construir antes un score agregado a partir de sus checks.

**Fuera de alcance a propósito**: el stop técnico del IC (Fractal/POC) — el usuario lo
**declinó explícitamente, no re-proponerlo** — y la defensa "lotería" (cerrar solo la pata
amenazada y dejar la otra como cobertura).

## 3 · Reversión — Alejamiento de SMA (playbook Luis Silva)

El precio se aleja de la SMA8 ("el imán técnico") pero no puede quedarse lejos, y se opera el
regreso. **Usa SMA simples** (`calcSMA`/`calcSMAArray`), no EMA como el resto del sistema —
indicador explícitamente distinto.

**Regla estructural: "5 minutos DECIDE, 2 minutos AFINA".**

- **El Juez (5m)**: alejamiento, RSI, dirección, compás de medias. `closes5` con su filtro
  original — ninguna decisión de **entrada** puede cambiar sin tocar esto.
- **El Bisturí (2m)**: afina el momento de entrada. *"nunca decide el setup, solo afina"*.
- **El stop se valida en 5m**, no en 2m (desde 2026-08-05): decidir cuándo la tesis quedó
  invalidada **es** una decisión de setup. Un stop en el extremo de la vela de 2m está
  **exactamente en el nivel del ruido** — rango mediano de una vela de 2m **4,58 pts** contra
  excursión adversa mediana durante el hold **4,70 pts**. Eso explicaba el 77% de cierres por
  `PRECIO_INVALIDACION` contra 22% por objetivo: un perfil de tendencia, invertido respecto
  de la tesis. El stop usa un array aparte (`bars5`, con `high`/`low`); sin velas de 5m
  utilizables cae al comportamiento anterior (2m) en vez de quedarse sin stop. Los nombres
  `entryCandleLow`/`entryCandleHigh` se conservan aunque el ancla ya no sea la vela de 2m.
  **`stopTimeframe`** (`'5m'`/`'2m'`) se graba en cada ejecución — es lo que permite separar
  las muestras, porque `algoVersion` saca su huella de la **config** y esto fue un cambio de
  **código**.

  ⚠️ **Lo que NO está demostrado es que mejore la plata.** Un stop 1,66× más ancho produce
  pérdidas más grandes; si la pérdida media creciera en la misma proporción, la mejora del
  win rate se **cancela exacto**. Se espera que crezca menos (el delta neto del spread
  amortigua, no escala lineal con los puntos del índice) pero eso solo se mide con trades
  reales. **La variable a seguir es la pérdida media, hoy en $39.**

**Salida — por precio del SPX, no por % de crédito** (decisión explícita del usuario,
distinto del resto del sistema). `checkAlejamientoSMATPSL()` cada 15-20s (más rápido que los
otros porque el hold es de 2-10 min): **TP** cuando el precio toca/cruza la SMA8, **SL** en
la ruptura del extremo de la vela ancla, **time stop** (`maxCandlesTimeStop`) si no avanzó.
Por eso `checkDirectionalTPSL` la **excluye explícitamente**
(`e.strategyFamily !== 'REVERSION'`) — dos monitores no pueden competir por la misma
posición.

*Simplificación conocida:* `ex.smaTarget` se congela al entrar, no se recalcula en vivo cada
15-20s (evita reconstruir todo `buildSPXContext` en un loop rápido).

**Sizing por riesgo real en dólares** (`sizeContractsByRisk`), la "división sagrada" de Luis
—*"la configuración del trade se hace del riesgo hacia el tamaño, nunca al revés"*—: riesgo
permitido (capital de `tradier.getBalances()` × `riskPctPerTrade`) ÷ pérdida estimada por
contrato (`shortDelta × distancia_en_puntos × 100`). Usa el **delta real** de la pata corta
que ya devuelve `findStrikesByDelta`, más preciso que el 30% fijo del ejemplo mental de Luis;
y la distancia en puntos se conoce *antes* de entrar (la vela ancla ya está cerrada).
Redondeo **hacia abajo**, y **si ni 1 contrato cabe se fuerza 1 de piso** (decisión explícita
del usuario — nunca deja de operar por esto, a diferencia de la lectura literal de Luis).

**Exclusividad de posición asimétrica, a propósito**: NO usa `hasOpenPosition('SPXW')` —
tiene su propio slot (chequea ejecuciones con `strategyFamily === 'REVERSION'`), así que
dispara aunque haya un IC o direccional abierto. **En la dirección contraria sí hay efecto**:
si esta tiene posición abierta, el `hasOpenPosition('SPXW')` de las otras dos SÍ la ve
(Tradier no distingue posiciones por estrategia) y se pausan solas mientras dure (2-10 min).
Inevitable sin tracking por estrategia a nivel del broker; el impacto es chico dado lo corto
del hold.

**El GEX ya no es gate duro.** Lo fue entre el 2026-07-14 y el 2026-07-21, y bloqueó **4 días
completos** (240/240 chequeos en `GEX_NOT_POSITIVE` cada día, sin llegar nunca a calcular el
score) por una discrepancia entre nuestro cálculo interno y Sigma Terminal. Hoy GEX negativo
hace fallar el check `regimen_gex` (resta su 10%) pero **no anula la entrada** — decisión
explícita: *"que le baje puntos pero que no anule la entrada"*.

**Fuera de alcance:** el cierre de gap en apertura y la "regla de los segundos" (entrar en
los últimos 15-30s de formación de la vela) no son implementables con polling — se opera
sobre la vela ya cerrada, igual que el resto del sistema. Tampoco hay tiers "5 estrellas": un
solo umbral pass/fail.

Las ~460 líneas de historia de calibración de este pipeline (bandas graduadas, la meseta
óptima, los repesajes, el caso de estudio del 8 de julio, el gate duro de GEX) están en el
histórico § *Alejamiento de SMA*.

### Parámetros vigentes de Reversión — la fuente declarada

Este bloque existe porque el manual no se podía leer sin adivinar: las secciones históricas
describen el esquema de **puntaje por bandas** que ya no rige, y `scripts/deriva.py` llegó a
pescar un «0.1-0.2» de una frase en prosa sobre la meseta óptima y reportarlo como si el
manual dijera que la banda máxima es 0.2.

**Si se cambia un valor en producción, se cambia también acá y en `ESPERADO_REVERSION` del
canario.** Tres fuentes que dicen lo mismo, o una deriva que alguien tiene que explicar.

```parametros-vigentes-reversion
extBandMinPct: 0.10
extBandMaxPct: 0.30
requiereGammaPositivo: false
alejamientoEsPuerta: true
puertasBinarias: true
minScore: 75
earlyExitPct: 0.6
stopMinPts: 20
maxDailyDrawdownPct: 3.5
```

Los dos que derivaron, para que no se vuelvan a marcar como sospechosos:

| Parámetro | Cambio | Commit |
|---|---|---|
| `extBandMinPct` | 0.13 → 0.10 | `075945c` «la banda de alejamiento baja a 0.10% — estaba cerrada de hecho». Con 0.13 el setup moría por centésimas: 77 de 112 evaluaciones de un día quedaban entre −0.09% y −0.12% |
| `requiereGammaPositivo` | true → false | `6084471` «el gamma vuelve a ponderar en vez de vetar» |

⚠️ **`riskPctPerTrade` y `maxStopsPerDay` siguen guardados en `spx_config.json` con valores
que parecen protecciones (1 y 2) y NO frenan nada** — ver `src/frenos.js`. No están en este
bloque a propósito: declarar como vigente algo que el robot no aplica es justo lo que hace
que se tomen decisiones creyendo que hay protecciones puestas.

---

# El precio del SPX y los muros de Gamma

### `precioSPXFresco()` — orden de fuentes

**Nunca leer el spot crudo de una fuente.** Las dos fuentes mintieron, cada una a su manera:
Yahoo sirvió 7411.02 congelado 2h44min (2026-07-24, y por eso se pasó a Tradier) y el sandbox
de Tradier tiene un atraso medido de **16 minutos** (error mediano 5,1 pts, p90 18,9, máximo
36,1 — con strikes de SPX cada 5 puntos). A las 09:31 ET el sistema decidía con 7709,96
mientras el índice estaba en 7737,15.

Lo que faltaba no era cambiar de fuente sino **mirar el sello de tiempo que las dos ya
mandaban y nadie leía**: `regularMarketTime` en Yahoo, `trade_date` en Tradier. Cualquiera de
los modos de falla se delata solo.

| | plan | atraso medido (07-ago) | error mediano |
|---|---|---|---|
| **Sigma Terminal** | **A** | 1 min | **0,33 pts** |
| Yahoo | B | segundos | referencia |
| Tradier sandbox | C | **16 min** | 5,10 pts |

Sigma primero por decisión del usuario, y con dos ventajas que no son obvias: **no cuesta
ninguna llamada de red** (el dato ya está en el servidor, lo empuja el daemon) y el precio
queda **coherente con los muros** — `callWall`/`putWall`/`gammaFlip` salen de Sigma, así que
tomar el spot de otra fuente hacía que "distancia al muro" mezclara dos mediciones distintas.

⚠️ **Su límite es la cadencia, no la exactitud**: el daemon empuja cada 2 min (mediana 123s,
máximo 317s), así que entre push y push envejece — la edad típica ronda los 60s.
`MAX_EDAD_SIGMA_SPOT_SEG = 180` cubre el ciclo normal y descarta los huecos, donde Yahoo pasa
a ser mejor. **Para el spot más fresco posible la palanca es bajar ese umbral o acortar el
ciclo del daemon**, no cambiar el orden.

- `precioSPXFresco({ rapido: true })` para los monitores: devuelve Yahoo si está fresco y
  **solo entonces** paga la segunda consulta a Tradier — 1 llamada en el caso normal,
  exactamente lo que costaba el fetch suelto de antes.
- **No queda ninguna lectura cruda del spot en el código**: las tres pasan por
  `leerSpotYahoo`.
- `getQuotes` **tiraba el `trade_date`** al remapear a forma fija, así que Tradier ni podía
  entrar en la comparación. Ahora el objeto lleva `tradeDate`.
- El respaldo `5530` se cambió por **`0`**: 5530 parecía un nivel de índice legítimo y se
  colaba entero hasta la selección de strikes; con 0 se dispara el rescate por
  `underlyingPrice` de la cadena y, si tampoco está, no hay strike posible y la señal muere
  sola.
- `spotFuente`/`spotEdadSeg` quedan en el contexto y en el snapshot del strategy log — medir
  este atraso exigió cruzar 267 snapshots contra Yahoo para inferirlo; ahora está registrado.

Qué decidía con el precio viejo: selección de strikes de las tres estrategias,
`openingRangeRespected` (gate del IC), el piso de 1,5×ATR, `entrySpx` congelado en cada
ejecución y el `calcGEX` interno. Los monitores de salida ya usaban Yahoo en vivo — o sea que
**se entraba mirando un precio de hace 16 minutos y se salía mirando el de ahora.**

### ⚠️ Sin precio fiable los monitores NO actúan
Si ninguna fuente está por debajo de `MAX_EDAD_SPOT_SEG` (180s) se saltea el gatillo por
nivel:

- **Direccional** — pierde el `TECHNICAL_STOP`, pero el **stop económico sigue** (sale de las
  cotizaciones de las patas, no del índice).
- **Reversión** — queda **sin ninguna salida automática**: TP, SL y time-stop son *todos* por
  nivel de precio. Una posición puede quedarse abierta hasta el vencimiento.

Es el lado reversible del error —cerrar sobre un precio viejo es lo que se acaba de
arreglar— pero **ciego y callado sería peor que ciego**: a los 4 ciclos consecutivos sin
precio fiable sale un ntfy urgente (`avisarSpotNoFiable`, contador por monitor para que uno
no enmascare al otro) y ahí corresponde cerrar a mano con el botón de pánico.

Nota: en el escenario de Yahoo congelado, Tradier tampoco pasaría el umbral (los ~16 min lo
dejan fuera) — así que ese día los monitores habrían quedado ciegos **y avisando**, en vez de
operar sobre un precio inventado.

### Fuente de GEX y muros
Los tres pipelines usan `effectiveGex`: **Sigma Terminal si tiene menos de 5 minutos**, si no
el cálculo interno (`calcGEX`, que tiene un **sesgo negativo medido** de ~−3.7B). El valor
efectivo se escribe de vuelta en `ctx.gex` para que el log registre el que realmente decidió,
sin tener que cruzar contra `/api/spx/sigma-levels` a mano después. `maxPain` se mantiene del
cálculo interno porque Sigma no lo empuja.

El `gammaFlip` diverge fuerte entre las dos fuentes: un día el interno daba **7600** contra
**7753** de Sigma — 153 puntos, con un buffer de gate de 20.

`POST /api/spx/sigma-levels` recibe `{netGex, regime, callWall, putWall, gammaFlip, mvs,
spxPrice}` del mismo loop de 2 min del daemon que ya empuja a TradingView. `GET` devuelve el
último valor y su antigüedad; `?history=true&date=YYYY-MM-DD` el historial (array, más
reciente primero, cap 10000 ≈ 2 semanas).

*Cosmético sin arreglar:* el snapshot de REVERSION en el log sigue registrando el
`gammaFlip` **interno** — la estrategia no lo usa en su lógica (solo régimen y muros, que sí
vienen de Sigma), el log engaña pero la decisión no.

### IV Rank
Endpoint correcto: **`GET /market-metrics?symbols=SYMBOL`** (coma, no `symbols[]=`), campo
`implied-volatility-index-rank` (decimal 0-1, ×100). El viejo
`/market-data/volatility?symbols[]=` devolvía **404** y el catch mudo caía a un hardcodeado
`ivRank = 30` — **exactamente el umbral de decisión** (`ivRank > 30`), lo peor posible: no
"neutral", sino justo el borde. Durante semanas `useDebit` nunca disparó y la decisión
crédito/débito estuvo gobernada solo por el VIX.

Ante fallo ahora queda en **`null`, no en 30**, y el catch **loguea** — ese silencio es la
razón por la que el bug pasó semanas sin que nadie lo notara. Los dos consumidores tratan
`null` como "sin dato" (`useDebit` exige `!= null`; `null > 30` es falso y cae al VIX).

## gamma_daemon — "Daemon Muros y Gamma"

Nombre para el usuario: **"Daemon Muros y Gamma"**. La carpeta/proceso sigue siendo
`gamma_daemon` (la Tarea Programada de Windows y `start.bat` referencian esa ruta literal).

Proceso de Node de vida larga, **100% determinista, sin LLM en el loop caliente**, loop cada
2 min de 9:00 a 16:05 ET. Reemplazó a un agente invocado desde cero cada 2 min, que generaba
fallas silenciosas de horas (no tenía memoria entre ciclos, no sabía que venía fallando).
Herramienta **local** (máquina Windows del usuario) — tiene su propio `package.json`, y
Railway solo instala el de la raíz, así que nunca se despliega.

- `sigma.js` — Puppeteer con perfil Chromium **dedicado y persistente** (`sigma_profile/`,
  login manual una sola vez, gitignored) contra `web.sigma.trade`, separado del Chrome normal
  del usuario. Selectores CSS **por prefijo** (`[class*="greeks_metricCard__"]`, no el hash
  completo) para sobrevivir a un rebuild de Sigma. Extrae Spot, Net GEX, Net DEX, Net Vanna,
  Gamma Flip, Put Wall, Call Wall, MVS.
- **MVS = Absoluto, no Neto**: el toggle "MVS Neto"/"MVS Abs" de la sección "Net GEX por
  strike" **también controla la tarjeta principal** de arriba — confirmado en vivo alternando
  ambos: Neto 7400, Absoluto 7450, mismo momento exacto. `ensureMvsAbsolute()` fuerza el clic
  en cada lectura si no está activo: no se confía en que quede así solo (puede resetear en un
  reload, o si el usuario lo cambia a mano).
- `tv.js` — CDP crudo (`chrome-remote-interface`) directo contra TradingView Desktop, sin
  pasar por el servidor MCP. **Prueba cada ventana candidata hasta encontrar una con SPX
  cargado de verdad** en vez de conectar a la primera que matchee — esa era la causa raíz del
  bug histórico de deriva SPY/SPX. `pushGammaLevelsToAllWindows()` empuja a **todas** las
  ventanas SPX abiertas: el usuario puede tener 2 (su plan permite 2 pantallas) y **no están
  sincronizadas entre sí** — confirmado en vivo que pueden quedar en versiones distintas del
  mismo indicador tras una edición manual.
- Watchdog: si el push falla, relanza TradingView (`tv.launch()`, vía `Get-AppxPackage` para
  resolver la ruta del `.exe` — instalado por Microsoft Store, la ruta versionada cambia con
  cada actualización) y reintenta una vez. Tras 3 fallos seguidos, ntfy y baja a cada 5 min
  ("modo degradado") hasta recuperarse.
- `status.json`/`history.json` (gitignored) — estado del último ciclo y cap 20 lecturas, para
  calcular "hace ~6 min" (3 ciclos atrás, posicional, no por timestamp real).

### ⚠️ El daemon se muere si se cierra la consola que lo lanzó
El 2026-08-05 estuvo ~50 min muerto en pleno mercado (`LastTaskResult 3221225786` =
`0xC000013A`, `STATUS_CONTROL_C_EXIT`), con los tres pipelines cayendo al cálculo interno sin
que nadie se enterara, y se descubrió de casualidad. Síntoma en un segundo:
`GET /api/spx/sigma-levels` → `fresh: false`.

**Ahora sí avisa**: a los 6 min (3 ciclos) sin dato fresco sale un ntfy, una sola vez por
episodio, y se avisa también cuando vuelve. Solo en horario de mercado (fuera de él el daemon
no corre y no es falla). Con Sigma como fuente por defecto del spot, esto pasó a ser
load-bearing: el sistema sigue operando con Yahoo, pero los muros se congelan al mismo tiempo.

Para relanzarlo sin la Tarea Programada (que solo dispara "al iniciar sesión"):
```powershell
Start-Process cmd.exe -ArgumentList "/c","<repo>\gamma_daemon\start.bat" -WorkingDirectory "<repo>\gamma_daemon" -WindowStyle Hidden
```
Queda colgado de un `cmd.exe` propio, independiente de la sesión que lo lanzó.

**En `start.bat` no usar `timeout`** — sin consola interactiva falla al instante ("Input
redirection is not supported") en vez de esperar, y el bucle de reinicio queda en caliente:
dejó **128 reinicios en un solo segundo** (`daemon_crash_log.txt`). Usar
`ping -n 16 127.0.0.1 >nul`, que no depende de stdin.

**Pendiente, necesita terminal como Administrador:** la Tarea Programada `GammaDaemon` tiene
**un solo trigger** (`TaskLogonTrigger`), sin repetición ni horario — nadie lo relanza si se
cae a mitad del día. Crear/modificar Tareas Programadas y `Set-ScheduledTask` requieren
permisos que ni Claude Code ni la terminal embebida del chat tienen. `ExecutionTimeLimit`
está en `PT0S` (sin ese arreglo, el default de 72h lo mataría a mitad de semana). La tarea
vieja `BitacoraGammaRefresh` quedó **deshabilitada, no borrada** — reversible.

**Editar el Pine de CIARG_V1 sigue siendo manual** — se intentó automatizar por CDP y
resultó frágil: coordenadas de clic dependientes de `devicePixelRatio`, "Update on chart" que
no siempre aplica el cambio a la instancia real aunque el clic se registre, y "Add to chart"
que agrega una instancia **nueva** y choca con el límite de 5 indicadores del plan del
usuario. Ver gotcha 9.

---

# Contabilidad de las ejecuciones

## `src/pnl_oficial.js` — la única puerta

Hasta el 2026-08-21 la misma pregunta —*¿cuánto ganó este trade?*— tenía **cinco
implementaciones distintas** (métricas, `version-stats`, `shadow-trail`, el skill del informe
y `control_cambios.py`), y cada pantalla nueva inventaba la sexta. Ahora devuelve, por
ejecución:

| Campo | Qué es |
|---|---|
| `pnl` / `neto` | El resultado oficial. Bruto (sin comisión) y neto |
| `fuente` | `cadena_real` · `broker` · `broker_dudoso` · `no_operacion` |
| `esCadenaReal` | `true` solo si salió del libro propio (`paperPnl.confiable`) |
| `comparable` | Apto para promediar con otros comparables. **Solo `cadena_real` lo es** |
| `pnlBroker` / `diferencia` | El número del sandbox y lo que cuesta operar con 15 min de atraso |

**Nadie más lee `ex.pnl` directamente salvo para auditar la diferencia.** Así la regla deja
de ser una convención (que se olvida) y pasa a ser una dependencia (que no se puede saltar
sin darse cuenta).

**Cortes que aplica**: `2026-08-03` (antes, el `/gainloss` viejo asignaba mal las patas) y
`2026-08-16` (antes no existe el libro propio, así que no hay medición contra la cadena real
que ponerles). Y excluye siempre lo que **no fue una operación**: la orden fantasma del
sandbox (`pnl=0`, `SANDBOX_GLITCH_SIN_POSICION`) entraba a las estadísticas.

⚠️ **Comparables y legado nunca se suman.** Van en bloques separados en todos los reportes.
Mezclarlos es de donde salían los promedios sin sentido: sobre los trades que tienen las dos
mediciones, **4 de cada 12 cambian de signo**.

Consumidores conectados:
- `/api/spx/version-stats` — la clave es **`familia|huella`**, no solo huella: antes la fila
  `(sin sello)` reportaba 51 trades como TENDENCIA cuando eran 23 TENDENCIA + 26 REVERSION +
  2 NEUTRAL.
- `/api/spx/shadow-trail` — es el instrumento con el que se valida un cambio antes de
  aplicarlo. Comparaba la sombra contra los fills de Tradier: validar contra el número
  equivocado no es medir de menos, es medir otra cosa.
- `/api/tradier/executions` — expone `resultadoOficial` ya calculado, **para que los
  consumidores que no son JavaScript no reimplementen la regla**.
- `scripts/control_cambios.py` y `skills/informe-trade` — el nombre del archivo del informe
  sale del mismo número que el cuerpo (antes podía salir un `..._perdedor100.pdf` cuyo
  informe mostraba ganancia).

**Lo que reveló al conectarlo** (192 ejecuciones, 2026-08-21): solo **13 comparables**, todos
de TENDENCIA; **REVERSION y NEUTRAL tienen cero** trades medidos contra la cadena real. Los
41 trades con "muestra suficiente" que reportaba la tabla vieja eran fills del sandbox sobre
una bolsa mezclada. **La muestra útil arranca el 17-ago.** Y en esos 13 la **pérdida media
(−$217,50) duplica a la ganancia media (+$111)**: el 69% de acierto es lo único que sostiene
el número — ese es el riesgo de cola a vigilar.

## Quién cierra qué

**Los tres monitores activos NO graban el P&L al cerrar.** Colocan la orden de cierre real,
guardan `closeReason`, y dejan el registro en **`status: 'filled'` a propósito**;
`checkTradierExecutions` (cada 5 min) lo detecta como "posición que ya no está" en su
siguiente ciclo y completa el P&L real desde `getClosedPnl`. Costo: hasta 5 min de retraso en
verlo en el dashboard.

Por qué: un IC cerró con **−$1.590** grabado cuando el real era **−$10** — el monitor usaba
la cotización de **antes** de cerrar (necesaria para decidir el disparo) como P&L final, y
capturó un valor transitorio de mercado recién abierto. Y el patrón de "dejarlo pendiente"
tampoco funcionaba: `checkTradierExecutionsImpl` solo procesa `status === 'filled'`, nunca
`'closed'`, así que marcar `closed` al cerrar dejaba el P&L en `null` **para siempre**.
Histórico § *Bug real en los 3 monitores*.

| Monitor | Cadencia | Cierra por |
|---|---|---|
| `checkDirectionalTPSL` | 30s | `TECHNICAL_STOP` (Fractal/POC) → stop económico → TP |
| `checkIronCondorTPSL` | 90s | TP `tpPct` / SL `−slMult` del crédito. Débito: % de la prima pagada |
| `checkAlejamientoSMATPSL` | 15-20s | Nivel de precio (SMA8 / vela ancla / time stop) |
| `checkTradierExecutions` | 5 min | **Pasivo** — no cierra nada, reconcilia |

`checkIronCondorTPSL` es el **primer cierre activo del sistema**: confirma el fill (crédito
neto real desde `avg_fill_price`), trae cotizaciones en vivo de las 4 patas contra el propio
sandbox de Tradier (no TastyTrade — la posición vive ahí), calcula cuánto costaría cerrar
ahora, y cierra.

El monitor direccional bajó de 90s a **30s** a pedido del usuario: un caso real mostró la
posición cruzando el 30% de TP bastante antes de que el monitor llegara, y el usuario la cerró
a mano primero. 30s reduce, no elimina, esa carrera.

`calcLivePnl(ex, quotesMap)` (solo lectura, mismas fórmulas que los monitores) alimenta
`ex.livePnl` para las posiciones abiertas — separado de `ex.pnl`, que sigue en `null` hasta el
cierre real. Se muestra con `~` adelante (`~$115`) para que no se confunda con realizado.

### Protección de precio al cerrar
`closeSpreadOrder` acepta `worstNetPrice` (convención: positivo = crédito mínimo aceptado,
negativo = −1 × débito máximo aceptado) y va como `type: 'credit'`/`'debit'` en vez de
`market`. Sin el parámetro se comporta como antes. Los call sites calculan el neto observado
(`q[longSym] − q[shortSym]`, misma convención que ya usaban para decidir TP/SL) y le restan
`spxConfig.trading.closeSlippageBufferPts` (**1.0** punto = hasta $100/contrato peor que lo
observado).

Por qué: un Bear Put Spread de $860 de débito cerró en **−$1.640** — por encima del débito
pagado, que en teoría no debería poder pasar en un spread. El número era correcto: el límite
de "la pérdida máxima de un débito es lo pagado" solo aplica al valor intrínseco en un precio
neto limpio, y una orden a mercado en un movimiento rápido de 0DTE cruza el bid/ask de cada
pata por separado (vender la larga cerca del bid, recomprar la corta cerca del ask). El IC ya
tenía esta protección desde el 2026-07-09, pero solo en la **apertura**.

⚠️ **Trade-off sin resolver**: un colchón muy angosto puede hacer que el cierre de un stop no
llene en un movimiento realmente rápido. 1.0 punto es un punto de partida, **no un valor
validado en producción**. Revisar si empiezan a verse cierres que no llenan a tiempo.

Si la cotización de las patas falla, `checkAlejamientoSMATPSL` cierra **a mercado sin
protección** en vez de demorar la salida — cierra por invalidación de nivel, no conviene
quedarse abierto esperando una cotización que no llega.

### Watchdog del monitor direccional
`checkDirectionalMonitorHealth()` (cada 60s): si `checkDirectionalTPSLImpl` lleva >3 min sin
correr **y** hay posición direccional abierta en ese momento, ntfy urgente una sola vez por
caída (se resetea cuando el monitor vuelve). No reemplaza la protección, evita descubrir tarde
que el servidor se cayó con una posición desprotegida.

*Investigado y descartado:* bracket/OTOCO nativo de Tradier — soporta OTOCO, pero su
restricción documentada exige que la segunda y tercera pata del OCO compartan el mismo
`option_symbol`, o sea que está pensado para una sola opción, no para una vertical. Dos OTOCO
independientes (uno por pata) introducen riesgo real de piernas descubiertas si se disparan en
momentos distintos — peor que depender del monitor.

### Endpoints de mantenimiento
- `POST /api/tradier/executions/:id/patch` — merge superficial sobre un registro por `id`.
  Para casos donde el `gain_loss` no estaba asentado en el momento exacto de la
  reconciliación (queda en `pnlSource: 'pendiente_verificar'` hasta corregirlo).
- `POST /api/wheel-trading/executions/:id/patch` — el equivalente para La Rueda. `phase:
  'ANULADO'` saca un ciclo de la bitácora sin borrarlo (`mapWheelExecution` solo mapea
  `CERRADO`).

La reconciliación pasiva marca `closeReason: 'MANUAL'` — la etiqueta más honesta, porque no
puede distinguir cierre manual de vencimiento natural, solo sabe que se cerró fuera de sus
monitores activos.

⚠️ **`reintentarPnlPendientes` reintenta por 2 días** asumiendo que Tradier va a asentar el
`gain_loss`. Si la posición **nunca fue real** para Tradier (orden fantasma), ese dato jamás
aparece y el registro se queda en "⚠️ Verificar manual" indefinidamente. Se corrige a mano con
`pnl: 0`, `pnlSource: 'sandbox_orden_fantasma'`. Los `closeReason` que no están en
`CIERRE_LABELS` de `index.html` caen al fallback de texto crudo, no al genérico "❓ Sin dato".

⚠️ **Heurística por conteo en la reconciliación pasiva.** En scalping 0DTE dos entradas
distintas usan el mismo par de strikes el mismo día, y Tradier **no expone un ID que ate cada
fila de `gain_loss` a una orden**. El filtro viejo sumaba todas las filas que matchearan el
símbolo: un caso real le dio $340 al segundo trade en vez de ~$100 (se comió el primero).
Ahora se cuenta cuántas **otras** ejecuciones ya cerradas comparten el mismo conjunto exacto
de `legSymbols` y se saltan esas tantas entradas (llegan más-reciente-primero, confirmado
empíricamente). Si no hay suficientes entradas disponibles, cae a `pendiente_verificar` **en
vez de inventar un número**.

---

# Rueda Automatizada (Tradier)

Cuarto pipeline, independiente de los tres de SPX. Automatiza el ciclo completo
CSP → asignación → Covered Call → reinicio, ejecutando en **Tradier** (no TastyTrade, donde
vive la Rueda manual de JBLU/NU/GAP/SOFI).

Registro en `wheel_trading_executions.json` — **distinto** de `tradier_executions.json`
porque el ciclo tiene **fases que cambian en el tiempo sobre el mismo registro**, a diferencia
de un trade SPX que abre y cierra una vez. Config en `wheel_trading_config.json`, señales en
`wheel_trading_signals.json` (nombres deliberadamente distintos de `wheel_config.json`, que es
de la Rueda manual). Mutex propio `withWheelExecutionsLock` — hay 3 escritores periódicos.

**El único checkpoint manual es aprobar la señal inicial**
(`POST /api/wheel-trading/signals/:id/approve` → 404 si no existe, 400 si no está `PENDING`).
Todo lo demás corre solo. No hay precedente en SPX: el único endpoint manual de SPX
(`POST /api/spx/signals/:id/action`) solo cambia `status`/`notes`, nunca coloca una orden.

**Gate `IS_PRODUCTION` en todo**: en local responde `{ok:false, reason:'local'}` o deja una
nota `[DRY-RUN]` informativa (no silencio — hace falta poder verificar la decisión sin ver la
consola), nunca coloca una orden. Mismo sandbox que producción, mismo riesgo de doble
ejecución si local y Railway corrieran a la vez.

| Fase | Qué hace |
|---|---|
| **1 · Screener** | `checkWheelCandidates()` 1×/día (horizonte de semanas, no minutos) + `POST /api/wheel-trading/scan` para disparar a mano. Universo: screener Finviz "🔄 La Rueda" (`SCREENERS.rueda`, vía `GET /api/screener/:id`) ∪ lista manual (`cfg.screener.tickers`); si las dos quedan vacías cae al `watchlist.json`. Liquidez: IV Rank 30-60, delta 0.15-0.30, DTE 30-45, bid/ask <5%, OI >500. Gate técnico "3 Mundos" (`calcWheelEntryScore`, `minScore` 70): confluencia **diaria + semanal** — no 2m+15m como SPX, porque el horizonte es de semanas. Pesos: Fase Weinstein 40, rebote EMA10/20 o fractal diario 25, MACD diario con pendiente 20, GEX del subyacente 15 |
| **2 · Aprobar → CSP** | Cotiza el Put en vivo, coloca **limit al bid**, fija `entryPrice` y `costBasisTarget`. `checkWheelExecutionFills()` cada 30s confirma el fill vía `getOrder` + `verificarFillPorPata` |
| **3 · Gestión del Put** | `checkWheelPutManagementImpl()` cada 5 min. 4 triggers: extrínseco ≤5% del crédito original (**sin** el piso absoluto de $5 de Alejandro — se opera con acciones de precios muy distintos), delta ≥0.35 hasta 0.50, DTE≤21, ganancia ≥50-70% |
| **4 · Covered Call** | `findCoveredCallStrike` filtra **SIEMPRE `strike > costBasis`** (regla sagrada, sin excepción). Fase Weinstein **diaria** decide (no exige confluencia semanal — reacciona más rápido): Fase 4 → semanales 5-10 DTE, delta 0.25-0.35 (prima agresiva); Fase 1/2/3 → 30-45 DTE, delta ~0.15 (deja correr la revalorización) |

**Si el trigger dispara en Fase 3**, en orden: (a) si el costo base real ≤ fair value →
`readyForAssignment=true`, deja de defender; (b) si el Fractal de soporte está roto y el
precio lejos de la EMA20 (>4%) → roll defensivo al **mismo** strike sin exigir el piso de
prima; (c) si no, camina el strike hacia el fair value mientras siga superando el piso; (d)
si ningún strike/fecha da crédito neto, **no rola** (ntfy de atención manual, nunca fuerza un
débito — el Jade Lizard subsidiado quedó diferido).

**Reinicio del ciclo**: `checkWheelExpiryImpl` (cada 30 min) transiciona `CC_ACTIVA` vencida →
`CERRADO` (acciones ya no están = ejercida) o `ASIGNADO` de nuevo (acciones siguen = expiró
sin valor, vender otra Call). **Esa transición ES el reinicio** — no hace falta código aparte
porque `checkWheelCandidates` ya vuelve a considerar cualquier ticker sin filtrar por
historial.

**Fair Value (DCF)** como ancla de asignación, en vez del 20% fijo: proxy FMP
(`.../proxy/fmp/discounted-cash-flow?symbol=X`, sin auth nueva). Filtro de sanidad:
**descarta si el DCF es negativo o se desvía más del 65% del spot** (NU daba $64 = 4,7× el
spot; JBLU negativo). Sin fair value válido cae a `findBestCSPStrike` por delta.
`findAnchoredCSPStrike` elige el strike más alto entre spot y fair value que supere el piso.

**Piso de prima**: 2% mensual sobre el **nocional completo** (strike×100), no sobre el margin
real — decisión explícita del usuario.

**Al rolar, el crédito/día se compara contra TODOS los vencimientos** (`findBestRollDate`,
generalizado con `optType` para servir Puts y Calls) — la ventana 30-45 DTE es solo para la
entrada. ⚠️ Pero **nunca hacia un vencimiento más cercano**, y el gate mira el **crédito
neto**, no la prima de la pata nueva: `if (!rollDate || rollDate.premium <= 0)` dejaba pasar
un roll a débito, y más abajo `netCreditMin = Math.max(0, premium − costoCerrar)` lo aplanaba
a 0 y la orden salía igual. La orden hace lo correcto y no llena, pero **`ex.leg` ya quedó
sobreescrito apuntando a un contrato inexistente** — que es el síntoma raíz del loop de
re-adopción. Ambas reglas se aplican en las **tres** ramas (por norma, defensiva, respaldo).

**Diferencia clave Put vs Call**: ser asignado en una Call **siempre** es favorable (nunca se
vende por debajo del costo base), así que su roll no tiene lógica de "defender" — busca un
strike **más alto** con crédito neto; si lo encuentra rola, si no no hace nada (sin nota, sin
ntfy: no es un problema, es el resultado esperado). ⚠️ **La rama de gestión de la Call nunca
corrió en producción** (nunca hubo un ciclo en `CC_ACTIVA`) — no está validada contra un caso
real.

### Guards que existen porque ya falló
Un loop de re-adopción mandó **21 órdenes reales a Tradier por UNA posición** (2026-08-05),
una cada 5 min durante casi 2 horas, generando $2.712 de ganancia fantasma de una posición de
$127. El bucle era: `adoptar → rolar → la reapertura se rechaza → cerrar en falso →
re-adoptar → …`. Los frenos que quedaron:

1. **`adoptedSymbol`** — inmutable, escrito al adoptar. Ningún symbol ya adoptado se vuelve a
   adoptar, **sin importar en qué fase quedó su registro**. `leg` no sirve para recordarlo
   porque el roll lo sobreescribe. El guard recorre **todos** los registros, no solo los
   vivos.
2. **La pata vieja se reconstruye desde el último evento `ROLL`** (`fromStrike`/`fromExpiry`
   vía `buildOccSymbol`, probando `P` y `C` porque el evento no guarda el tipo). Si sigue en
   la cuenta, el registro **vuelve a esa pata y queda vivo** en vez de declararse flat. Antes
   se preguntaba solo por la pata **nueva**: un roll son dos órdenes, y si la reapertura se
   rechaza eso da "no está en la cuenta" y se concluía flat **sin preguntar nunca si la vieja
   sigue abierta**.
3. **30 min de enfriamiento entre intentos de roll, y se abandona tras 3 fallos
   consecutivos** con un ntfy una sola vez (un roll que falló 3 veces no se arregla
   reintentando). Un fill real reinicia el contador. El roll atómico protege la *posición*
   cuando se rechaza — no protege a la *cuenta* de que se lo pidan 21 veces.
4. **Dos cortes independientes en `detectarPutsHuerfanas`**: por **root** (SPX/SPXW nunca son
   de La Rueda, que opera acciones — no depende de leer ningún archivo) y por **registro**
   (cualquier symbol en `tradier_executions.json`). Antes aceptaba **cualquier** put corta:
   adoptó una pata 0DTE del direccional, la registró como ciclo de La Rueda y la cerró al
   instante inventando $700. Lo contable es lo de menos — el riesgo real es que
   `checkWheelPutManagementImpl` intente **rolar una posición que `checkDirectionalTPSL` está
   gestionando en paralelo**.
5. **`totalCreditAccumulated` se descuenta al revertir un roll fallido**, y el evento queda
   marcado `fallido: true` (no se borra: el intento existió y sirve para auditar). Se
   incrementa al **mandar** la orden, así que si no llena inflaba el costo base y el P&L del
   ciclo para siempre.
6. **`totalCreditAccumulated` solo se inicializa si es `null`** — antes se sobreescribía con
   `ex.creditReceived` en **cada** fill confirmado, borrando lo que los rolls ya habían
   acumulado. Los rolls y la venta inicial de la Call ahora suman su propia prima
   explícitamente.
7. **`trackedLegKeys` emite también las claves derivadas de los eventos de ROLL** — al tapar
   solo `ex.leg.optionSymbol` (que el roll sobreescribe), las patas anteriores del ciclo
   afloraban otra vez como "operación del broker" con plata ya contada. Las filas
   broker-only de La Rueda pasaron de 5 a **0** sin perder ninguna operación real.
8. **`reconcileClosedPnl` deduplica por pertenencia, no por conteo**: si el symbol/día ya
   tiene cierre registrado, ninguna fila extra entra (el sandbox **sí duplica filas**: el
   04-ago devolvió 3 del mismo call con costos distintos). Y la clave de La Rueda va **sin
   fecha** (`optionSymbol|*`): el broker cierra en otra fecha que nuestro registro — un symbol
   OCC ya identifica raíz + vencimiento + tipo + strike.

⚠️ **Limitación aceptada**: si alguna vez se cierra dos veces el mismo contrato el mismo día y
solo una queda registrada, la otra deja de aflorar. Es el precio de que Tradier no devuelva
`order-id` en `gainloss`. Se prefiere no mostrar un trade real no trackeado antes que inventar
uno que no existió.

### ⚠️ Sin `pnl` explícito, un ciclo sale como `pnlPending: true`
Antes `mapWheelExecution` anotaba `totalCreditAccumulated` entero — o sea "me quedé la prima",
que solo es cierto si el put expiró sin valor. **El error iba siempre a favor**, que es la
dirección peligrosa: PDD figuraba +$68 cuando el broker decía **−$88**, MARA +$49 contra
−$85, NU +$17 contra −$58, y encima en otro mes. La nota de esos registros decía "P&L no
verificable desde acá" y **era falso**: `getClosedPnl` lo tenía, con match exacto de symbol.

Ahora el ciclo sale visible en Historial como pendiente y **fuera de totales, curva,
calendario y win rate**. Excepción: `ENTRADA_NO_LLENO`, donde no hubo posición y el $0 sí es un
dato.

### Fecha de cierre — un ROLL no es un cierre
Orden de resolución, de más a menos confiable: **`ex.closedAt`** →
`reconciliado_manual_YYYY-MM-DD` → último evento (proxy, puede ser un roll) → vencimiento
**solo si ya pasó** → apertura. Más un guard final: **ningún proxy puede dejar la fecha en el
futuro**.

Es la segunda vez que esta función falló por la fecha. Los invariantes a sostener:
**`closeDate` nunca en el futuro**, **un roll no es un cierre**, y **un vencimiento nominal no
es un cierre cuando existe una marca real**.

**El cierre manual** guarda `closeOrderId` y `checkWheelExecutionFills` resuelve el P&L cuando
la orden llena (`pnlSource: 'cierre_manual_orden_real'`) — el cierre va a mercado y casi nunca
está lleno cuando el botón responde. Sin `closedAt` el ciclo se archivaba en su fecha de
**apertura** (ANET cerrado el 05-ago aparecía bajo el 03-ago: "no se veía" porque estaba dos
días atrás).

**Entrada forzada**: `POST /api/wheel-trading/force-entry` — igual al flujo de aprobación pero
**sin exigir el gate técnico/IV Rank/fair value**, a pedido del usuario para operar la lista
de su mentor. Marca `forced: true`. Tiene un **tercer nivel** de selección de strike (sin
bid/ask%/OI/ventana de delta ideal, solo 30-45 DTE y prima positiva — nunca se fuerza un
strike a débito).

**Fuera de alcance**: Jade Lizard / débito subsidiado, estimador real de requisito de margin
(**contratos fijos en 1**), switch de UI Tasty/Tradier.

**`GET /api/option-chain/:symbol` acepta `?limit=N`** (tope 15, para no disparar demasiadas
llamadas de `/market-data`). El límite fijo de 6 expiraciones nunca llegaba a 30-45 DTE en
tickers con vencimientos casi diarios (IBIT pasó de "sin strike válido" a encontrar uno
razonable). `force-entry` usa `limit=12`. **Al rolar hay que pedir la cadena sin filtro de
`expiry`** — filtrada a la expiración actual, `findBestRollDate` comparaba el roll contra sí
mismo.

---

# Otras funcionalidades

### Impuestos — hoja fiscal (`src/impuestos.js`)
Pestaña **LEGAL → Impuestos**. Convierte el P&L realizado en la información que exige la DIAN
para renta de persona natural residente. El marco normativo completo (8 documentos +
plantillas) vive **fuera del repo**, en `01_Sigma/reporte impuestos financiero legal/`.

> ### ⚠️ Decisión del usuario: **NO desplegar a Railway**
> Se queda en **local**. Los datos que guarda —otros ingresos, dependientes, deducciones,
> gastos, pérdidas compensables— son personales y la URL de producción es pública.
> **No pushear esta funcionalidad sin volver a preguntar.**

Endpoints: `/api/impuestos?year=`, `/api/impuestos/years`, y CRUD de `/gastos`, `/perdidas`,
`/config`. Archivos en `DATA_DIR`, todos gitignored: `impuestos_gastos.json`,
`impuestos_config.json`, `impuestos_perdidas.json`, `trm_cache.json`.

Reglas fiscales, **todas en `src/impuestos.js`, ninguna en el frontend** (si viven en dos
lados terminan divergiendo):
- **Art. 300** — tenencia ≥730 días → ganancia ocasional 15%; menos → renta ordinaria. Para
  opciones sobre índices esto **nunca** se cumple: todo va a la tabla del 241.
- **Art. 241** — tabla marginal 0%–39%. La norma trae los acumulados redondeados a UVT
  enteras, así que hay una **discontinuidad real de 0,1 UVT** en los quiebres. El código
  replica el texto legal, no la fórmula "limpia".
- **Art. 336** — el límite 40% / 1.340 UVT aplica **solo** a rentas exentas y deducciones
  especiales. Los **costos y gastos del art. 107 no tienen tope** — es la distinción que más
  plata mueve y la que más se confunde.
- **Arts. 147 y 330** — pérdidas compensables 12 años, solo contra la misma cédula.
- **Art. 254** — descuento por retención en el exterior, topado al impuesto colombiano.

**TRM**: serie diaria de `datos.gov.co/resource/32sa-8pi3` (Superfinanciera), cacheada por año
en disco. Cada operación se convierte con la TRM de **su propia fecha de cierre**, no con un
promedio: se movió de ~3.650 a ~3.130 entre febrero y agosto de 2026, así que una sola tasa
deforma el total de forma notoria.

Ver gotchas 4 y 5 — los dos aplican acá.

### BP Dashboard (`/api/bp-dashboard`)
Seguimiento de Buying Power con metas 50/25/25 (Rueda/Especulación/Libre). Agrupa opciones por
`(underlying, expiry, optType)`:
- Short + Long → **spread**: `ancho × 100 × qty` (GAP $19.5/$20 = $150)
- solo Short → **naked**: `strike × 100 × qty` (JBLU CSP $5 = $500)
- Short call con underlying en stock → **CC cubierta = $0**
- Stocks → `avgPrice × qty` (pool de equity separado, mostrado aparte en el header)

Base del pie chart = `ruedaOptBP + specOptBP + derivAvail` (los tres segmentos = 100%). **No
coincide con ningún valor único de TastyTrade** (es usado + disponible).
`derivative-buying-power` = solo el disponible (Libre en el pie); `equity-buying-power` = el
pool de acciones.

**TastyTrade API**: `quantity-direction: "Short"/"Long"` determina la dirección.
**`cost-effect` está invertido** (Short put = "Debit", Long put = "Credit") → **no usarlo para
dirección**. `/accounts/{account}/margin-requirements` → **404, no existe**.

### Notificaciones
**ntfy.sh**, topic configurado en `.env`. Alerta de extrínseco cuando el valor extrínseco de
una posición cae ≤5% del crédito original. **Guard importante**: saltar grupos donde
`uPrice = 0` o `mark-price = 0` (evita falsas alertas).

### Caché del servidor
TTL de 120s en memoria para las llamadas a TastyTrade. Se invalida con `POST /api/refresh`.
`/api/transactions-tradier` tiene TTL propio de 60s.

### Service Worker
Bumpar `CACHE = 'bitacora-vN'` en `public/sw.js` con cada cambio de frontend. El fetch handler
solo intercepta esquemas `http`/`https` (`chrome-extension://` rompía `cache.put()`). Para
forzar la actualización en un cliente con caché viejo, desde la consola del browser:
```js
navigator.serviceWorker.getRegistrations().then(r=>Promise.all(r.map(x=>x.unregister()))).then(()=>caches.keys()).then(k=>Promise.all(k.map(x=>caches.delete(x)))).then(()=>location.reload())
```

### iOS PWA — notch / status bar
`apple-mobile-web-app-status-bar-style: black-translucent` hace que el contenido corra por
debajo de la barra de estado de iOS en vez de dejarle espacio — en modo standalone eso tapaba
la parte de arriba de `.mobile-navbar` en iPhones con notch. Fix: `viewport-fit=cover` en el
meta viewport (necesario para que `env(safe-area-inset-top)` resuelva a un valor real) +
`padding-top: env(safe-area-inset-top)` en `.mobile-navbar` (altura `calc(48px + env(...))`) y
en el padding-top de `.content`/`.panel`/`.header`. Sin notch, `env(...)` es `0px`.
**Ver gotcha 10.**

### Variables de entorno (`.env`)
```
TASTYTRADE_USERNAME=
TASTYTRADE_PASSWORD=
TASTYTRADE_ACCOUNT=
NTFY_TOPIC=
RAILWAY_VOLUME_MOUNT_PATH=   # solo en Railway

TRADIER_ACCESS_TOKEN=
TRADIER_ACCOUNT_NUMBER=
TRADIER_BASE_URL=https://sandbox.tradier.com/v1
```
**No están en el volumen** — hay que agregarlas también en Railway → Settings → Variables, o
el auto-deploy no las tiene.

---

# Pruebas y control de cambios

## Batería de pruebas (`scripts/pruebas.js`)

```bash
node scripts/pruebas.js            # unidad — rápido, sin red
node scripts/pruebas.js --local    # + levanta el servidor y le pide TODAS las rutas
node scripts/pruebas.js --humo     # + las mismas rutas contra producción
```

**Por qué existe**: el 2026-08-22 se desplegó un cambio que tumbaba
`/api/spx/reversion-sombra` con un **500 en cada request** — usaba `spxConfig`, que no es
global sino un `const` local en otras cuatro funciones. Ni `node -c` ni el optional chaining
lo habrían visto (`a?.b` sigue fallando si `a` no está declarada). Estuvo caído ~20 min y se
descubrió de casualidad, corriendo el Auditor: **ningún chequeo tocaba ese endpoint.** La
prueba de humo lo caza en dos segundos.

| Bloque | Qué prueba |
|---|---|
| **El dinero** | `resultadoOficial` en sus ramas (libro propio, libro no confiable, broker, `gainloss` dudoso, orden fantasma, posición abierta), y que `agregar` **nunca** sume comparable con legado |
| **Los frenos** | El circuito diario en sus bordes, incluido el límite **exacto** (caza el día que alguien cambie `<=` por `<`), y que solo uno de los tres frenos declarados esté activo |
| **Los impulsos** | La escalera de TP, que en bajista **nunca** encarece la entrada, y el listón en 90 exacto |
| **Humo** | Las 52 rutas GET sin parámetros. Un 4xx se acepta; un **5xx nunca**: significa que el endpoint se cayó solo |

**`MODO_PRUEBAS=1`** levanta el servidor **sin programar ni un ciclo periódico**. Las rutas
responden igual, que es lo único que el humo necesita. No es una protección contra operar
(esa ya existía: la auto-ejecución está deshabilitada fuera de Railway) sino contra el ruido:
sin los 19 ciclos el arranque es rápido y determinista, no consulta al broker cada 30s y no
dispara notificaciones.

**El hook `pre-push`** (`scripts/hooks/pre-push`) corre `--local` y **aborta el push** si algo
queda en rojo. A diferencia de `post-commit`, este sí puede abortar, y es deliberado: un commit
roto se arregla con otro commit; un despliegue roto deja el robot operando mal, o sin operar.
Para saltarlo: `SKIP_PRUEBAS=1 git push`. **Ver gotcha 8.**

**`CONOCIDOS`**, dentro del script, lista lo que ya estaba roto **con fecha y diagnóstico**.
No hace fallar la corrida —el trabajo de la batería es cazar lo nuevo— pero se imprime fuerte
en cada pasada. Si una entrada lleva semanas ahí, el problema ya no es el endpoint: es que
nadie decidió qué hacer con él.

**Hoy la lista está vacía, y ese es el estado correcto.** La única entrada que hubo duró un
día: `/api/margin-raw` devolvía 500 porque TastyTrade responde 404 a
`/accounts/<acct>/margin-requirements`, no lo llamaba nadie, y `getMarginRequirements()` solo
existía para servirlo. Si algo entra, tiene que salir pronto — por arreglo o por borrado. Una
lista de roturas toleradas que crece deja de ser deuda y pasa a ser costumbre.

## Control de cambios — NORMA

> **Regla del usuario:** *"necesito que sea una norma, siempre que cualquier ajuste o cambio
> se documente"*. No es opcional ni depende de acordarse.

`scripts/control_cambios.py` genera **seis** libros de Excel (uno por familia) desde el
historial de git, en `mentoria alejandro/`. Lo dispara solo el hook **`post-commit`** después
de cada commit, en segundo plano (consulta producción para atribuir trades y no debe demorar
el commit). Log en `.git/control_cambios.log`; para saltarlo, `SKIP_CONTROL_CAMBIOS=1`.
**Ver gotcha 8** — así fue como los libros llegaron a estar 240 commits desactualizados.

**Declarar impacto y familia en el commit.** La heurística solo mira el *asunto*, así que un
commit que hace dos cosas se clasifica por la que quedó en el título (caso real: `89941f9`
también arreglaba el gate del roll —una decisión de trading— y quedó como BAJO). El trailer
manda sobre la heurística:
```
Impacto: ALTO
Estrategia: RUEDA, DIRECCIONAL
```

Las columnas de seguimiento se llenan solas. Reglas, tomadas de la propia hoja *Seguimiento*:

| | |
|---|---|
| Un período | Cada cambio **ALTO** abre uno; lo cierra el ALTO siguiente de esa familia |
| Atribución | Por fecha de commit. La huella de `algoVersion` va aparte, en su propia tabla: **no se mueve con un cambio de código**, solo de config |
| Muestra mínima | **30 trades cerrados**. Con menos: `insuficiente (n/30)` |
| Corte de fiabilidad | Nada anterior al **2026-08-03** es comparable — 39 de 62 direccionales tienen el P&L mal calculado por el `/gainloss` viejo |

Los trades salen de **producción** (`/api/tradier/executions`), no de los JSON locales, que
están viejos. Sin red cae a los locales y **lo dice en la hoja** (`Fuente de los trades`), en
vez de reportar en silencio sobre datos rancios.

Los libros traen **Pérdida media** y **Legado (Tradier)** como columnas propias, y el
veredicto distingue *"sin trades aún"* de *"no comparable (N trades medidos con Tradier)"*.

---

# Decisiones abiertas / congeladas

Cosas diagnosticadas o pendientes que **no hay que cambiar sin que el usuario lo pida**.

### El filtro de dirección de 15m va horas atrasado — DIAGNOSTICADO, sin cambiar
En `entryMode: 'pullback'` (el modo activo en producción) la dirección la fija **una sola
línea**: `fase15.bull ? 1 : -1`. La condición es
`precio > EMA20 && EMA10 > EMA20 && EMA20 subiendo`, y **la EMA20 de 15m arrastra 5 horas de
memoria** (20 barras × 15 min) — incluye el rally de los días previos. Mientras esa EMA siga
subiendo por inercia, las tres condiciones se cumplen aunque el precio caiga.

Reconstruido barra por barra con datos reales del 2026-08-05: la sesión abrió en 7789 y cayó
sin pausa; el filtro sostuvo **BULL** hasta las 11:00 y marcó BEAR recién a las **13:21,
después de 52 puntos de caída**. Las 27 señales de ese día se generaron entre 9:55 y 11:10 —
exactamente la ventana en que decía BULL; en cuanto pasó a "ninguna" a las 11:15 dejaron de
aparecer. El MACD de 15m estaba bajista (hist −3,44) al mismo tiempo, y aun así el score llegó
a ≥80 porque `fase_weinstein` pesa 45 y `macd_cruce_pendiente` solo 15.

⚠️ Con el gate de Crédito/Riesgo ya corregido, **8 se habrían ejecutado, las 8 en contra** — o
sea que ese día el bug de unidades fue lo único que evitó una tanda de trades malos. El gate
roto estaba **tapando** este problema, y arreglarlo lo dejó expuesto.

Las tres opciones sobre la mesa, **ninguna implementada**:
- (a) que el **MACD 15m pueda vetar** cuando contradice a la fase — el cambio más chico, usa
  datos ya calculados, y ese día habría bloqueado las 27;
- (b) exigir que la **sesión acompañe** (precio contra la apertura del día o VWAP), que ataca
  la causa directa: la memoria de 5h arrastrada del día anterior;
- (c) acortar el período de la EMA20 — lo más simple, pero mete ruido y hay que recalibrar.

Decisión del usuario: **solo diagnosticar**, coherente con la norma de congelar cambios.

### El efecto del TP de impulso 1 está sin medir
Subir de 30 a 35% va a bajar algo el % de aciertos a cambio de que los aciertos sean más
grandes. Con 9 casos en ese bucket no hay forma de saber si suma o resta. `tpPctExigido` viaja
congelado en cada ejecución justamente para que el Auditor lo dictamine con muestra.

### Stop dinámico según win rate real (Luis Silva)
`stop_máximo = objetivo / (1/WR − 1)` — con 70% WR el múltiplo de equilibrio es ~2,3× el
objetivo; con 80% sube a 4×; con 90% a 9×. Requiere un win rate **medido** sobre trades reales
y todavía no hay historial suficiente para calibrarlo sin adivinar. El stop sigue siendo por
precio (ruptura de la vela ancla).

### Confirmación de 5m en `fase_weinstein` de Reversión
La "regla de oro" de Luis exige que 15m+5m+2m cuenten la misma historia; hoy solo se valida
15m (+2m indirectamente, vía la dirección ya determinada por precio vs SMA8). **Pendiente de
decidir.**

⚠️ Al tocar esto: la dirección del check (exigir que la fase 15m **coincida** con la reversión
—Fase 2 para alcista, Fase 4 para bajista— no que se **oponga**) es correcta según el material
de Luis. **No cambiarlo a un esquema de oposición sin releer ese contexto primero.** Y se
verificó que el bloqueo por Fase Weinstein **no es arreglable bajando de temporalidad**: en el
caso del 8 de julio, 2m confirmó a las 11:04, 5m a las 11:25, 10m a las 12:20 y 15m a las
13:30 — ninguna llega a tiempo para una entrada de las 10:26. El cuello de botella no es la
fórmula de la fase, es que cualquier promedio de 15 min reacciona demasiado lento para un
rebote en V.

### `earlyExitPct` en 0.6
El usuario lo había subido a 0.9 y apareció en 0.6 tras una corrupción de config (junto con
`smaReversion.minScore` en 0, que sí se restauró a 75 — con `minScore: 0` la Reversión
ejecutaba **cualquier** señal). **La causa raíz de la corrupción no se identificó**: ningún
código escribe un 0 ahí, salió de un `POST /api/spx/config` contra el volumen. **Pendiente de
decidir.**

### DEX en el score
`regimen_institucional` pesa 10 y solo mira el signo del GEX. El framework de Alejandro pide
GEX *y* DEX; los datos de delta ya están en la cadena sin fetch adicional, pero **falta
validar en qué dirección favorece cada régimen** antes de sumarlo al score de un sistema que
ejecuta órdenes reales.

### Detección automática de la orden fantasma del sandbox
Se decidió **no** automatizarla (ej. "si la orden padre lleva horas en `open` con legs
`filled` y sin posición, autopatchear a `pnl: 0`") — caso raro, visto una vez, y el patch
manual alcanzó. Si se repite con frecuencia, ahí sí conviene.

### El spot podía llegar congelado en la apertura — RESUELTO, pero la nota vieja engaña
La observación de 2026-08-05 ("de 9:31 a 9:41 ET Tradier devolvió 7736.52 en 12 llamadas") se
interpretó como un congelamiento de apertura. **No lo era**: era el atraso de ~16 min, que a
las 9:31 muestra premercado, que por definición no se mueve. Resuelto con `precioSPXFresco()`.

### Backtester SPX
`public/index.html`, tab "Backtester SPX", `runBT()`. Corre la lógica de entrada contra 58
días de Yahoo (límite de velas de 2m), con P&L simulado vía Black-Scholes (IV fija 17.5% — no
existen datos históricos de cadena de opciones reales en ningún proveedor).

`BT_WEIGHTS`/`evalDir` es un **proxy legacy simplificado** y **no se mantiene sincronizado**
clave por clave con `SPX_CONFIG_DEFAULTS.weights` desde el rework a "Peso de la Evidencia"
(hardcodea `volumen_spy`/`gex_compatible` porque no tiene esos datos client-side, y no calcula
patrones HL/LH ni Camino A real). Solo importan el `minScore` y que la suma de pesos dé 100,
no la paridad check-por-check con producción.

---

# Desarrollo local

- `npm run dev` — nodemon (recomendado).
- `node server.js` — alternativa sin nodemon si hay problemas.
- `MODO_PRUEBAS=1 node server.js` — sin ciclos periódicos, para probar rutas.
