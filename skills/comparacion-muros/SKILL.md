---
name: comparacion-muros
description: Recolecta y compara, cada 5 minutos durante 2-3 días de mercado, los muros de Gamma (Put Wall, Call Wall, Gamma Flip, MVS), el régimen de GEX y el régimen/magnitud de DEX calculados internamente por el servidor de producción (bitacora-tasty) contra los que muestra Sigma Terminal — para decidir si el sistema puede dejar de depender de Sigma Terminal y dibujar los muros con su propio cálculo. Se activa con "comparación de muros", "resultado de la comparación de muros", "ya tenemos los 2 días de datos", o similar.
---

# Comparación de muros: cálculo interno vs Sigma Terminal

## Contexto y objetivo

El sistema (`bitacora-tasty`) calcula sus propios niveles de Gamma
(`calcGEX`/`calcGammaFlipSweep`, `src/spx.js`, a partir de la cadena de
opciones real de TastyTrade) — pero a pedido explícito del usuario, hace
unas semanas se decidió que los muros que se **dibujan en TradingView**
(CIARG_V1, vía `run_gamma_refresh.ps1`) usan el dato de **Sigma Terminal**
(Polygon), no el cálculo propio. Ya existe una discrepancia puntual
documentada (memoria `gamma_flip_discrepancy` — 2026-07-16, Gamma Flip 7560
interno vs 7520 Sigma Terminal) que el usuario decidió en su momento dejar
sin investigar más a fondo.

El 2026-07-29 el usuario pidió sistematizar esa comparación: recolectar 2
días seguidos de datos, medir la desviación real entre ambas fuentes, y con
eso decidir si conviene seguir dependiendo de Sigma Terminal o pasar a
dibujar los muros con el cálculo propio (elimina la dependencia externa, el
riesgo de la pestaña de SPY que rompió el pipeline ese mismo día, y el
`fresh`/`ageMs` de un dato de terceros).

## Arquitectura — por qué esto NO usa Claude/TradingView/Chrome

A diferencia de `premercado-spx` y `run_gamma_refresh.ps1`, esta recolección
**no necesita ningún agente de IA en el ciclo** — ambos números que se
comparan ya están expuestos como JSON en producción:
- **Cálculo interno**: `GET https://web-production-23473.up.railway.app/api/spx/context`
  → campo `gex` (`netGex`, `regime`, `callWall`, `putWall`, `gammaFlip`,
  `levels`, `maxPain`). Tarda **~20s en responder** (hace fetches externos
  reales — Yahoo, cadena de opciones de TastyTrade) — confirmado en vivo el
  2026-07-29, usar timeout ≥45s o el ciclo falla por corte prematuro.
- **Sigma Terminal**: `GET https://web-production-23473.up.railway.app/api/spx/sigma-levels`
  → `netGex`, `netDex`, `regime`, `callWall`, `putWall`, `gammaFlip`, `mvs`,
  `spxPrice`, `updatedAt`, `ageMs`, `fresh` (esto ya lo alimenta
  `run_gamma_refresh.ps1` cada 2 min, ver `CLAUDE.md` — así que casi siempre
  hay un dato fresco esperando).

Por eso el recolector es un `.ps1` puro (2 `Invoke-RestMethod`, sin
`claude.cmd` de por medio) — cero costo de API, cero dependencia de que
TradingView/Chrome estén sanos ese día (el incidente de la pestaña de SPY
del 2026-07-29 no afecta a esta recolección en absoluto, es un dato extra a
favor de independizarse de esa cadena).

**`mvs` no existe como campo propio en `calcGEX`** (`src/spx.js`) — Sigma
Terminal sí lo expone. Para poder comparar algo, el recolector aproxima un
"MVS interno" como el strike de mayor `|gex|` dentro de `ctx.gex.levels`
(mismo criterio que el tooltip de Sigma Terminal para su "MVS Neto": "strike
con la mayor \|Net GEX\|") — **sin tocar `calcGEX` ni ningún código de
producción**, el cálculo vive solo en el script de este skill. Si al final
se decide adoptar el cálculo propio para dibujar los muros, ahí sí habría
que agregar `mvs` de verdad a `calcGEX`.

**`netDex` — a diferencia de MVS, sí se agregó de verdad a `calcGEX`**
(2026-07-29, `src/spx.js`, desplegado a producción vía commit `9682fed`):
el delta de cada contrato ya venía en la cadena de opciones que arma el
servidor (`enrichedExps`, `server.js` línea ~3594/3601 — se usa para otras
cosas del sistema, como el sizing por delta de la Rueda), así que no hizo
falta ningún fetch nuevo, solo sumar `delta × OI × 100 × spot` por strike
(sin el flip de signo `-1` que sí lleva el put en el cálculo de GEX — el
delta de un put ya es negativo por convención Black-Scholes, a diferencia de
la gamma que siempre es positiva). Es un campo **aditivo** — no cambió
`netGex`/`callWall`/`putWall`/`gammaFlip`/`regime`, que siguen calculándose
exactamente igual que antes del cambio. Validado en vivo contra Sigma
Terminal el mismo día: mismo signo (régimen DEX coincide), magnitud bastante
distinta (~3.4x) — ver "Primer dato real" abajo.

## Recolección — `scripts/collector.ps1`

- Tarea programada de Windows: **`Bitacora_ComparacionMuros`** — dispara
  cada 5 min durante 3 días corridos desde el momento en que se armó
  (2026-07-29, cubre el resto de esa sesión + jueves 30-jul + viernes
  31-jul completos — el guard de horario interno filtra fuera de eso, no
  hace falta borrarla apurado).
- Guard duro de horario (mismo patrón que `run_gamma_refresh.ps1`): 9:30am-
  4:00pm ET, lunes-viernes, calculado con
  `[System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId` (maneja DST solo,
  aunque para una ventana de 3 días no hay riesgo real de cruce de
  temporada). **Ventana de mercado real** (no premarket) a propósito — antes
  de la apertura ambas fuentes reflejan el último cierre/premarket
  congelado (confirmado el mismo 2026-07-29), comparar ahí no aporta nada.
- Si `sigma-levels` no está `fresh` (>5 min de antigüedad), el ciclo se
  salta sin registrar una comparación — comparar contra un dato viejo de
  Sigma Terminal sesgaría la medición en su contra sin que sea un problema
  real de esa fuente.
- Cada lectura válida se agrega como una línea JSON a
  `C:\Users\gcarv\bitacora-tasty\comparacion_muros_log.jsonl` (append-only,
  nunca se reescribe el archivo completo).
- **Gotcha de encoding confirmado**: `Add-Content -Encoding utf8` de
  PowerShell 5.1 escribe un BOM (`EF BB BF`) al inicio del archivo — el
  script de reporte lo maneja abriendo con `encoding="utf-8-sig"` en Python,
  no asumir `utf-8` a secas si se toca este archivo con otra herramienta.

## Generar el reporte y tomar la decisión — `scripts/generar_reporte.py`

Cuando el usuario pida el resultado (después de los 2-3 días, o antes si
quiere un avance parcial): `python
C:\Users\gcarv\.claude\skills\comparacion-muros\scripts\generar_reporte.py`
(usar `python`, no `python3`, mismo criterio que el resto del proyecto).
Lee el `.jsonl` completo y calcula, para Call Wall / Put Wall / Gamma Flip /
MVS: desviación media y mediana absoluta, máximo, % de lecturas que
coinciden exacto, % dentro de 10pts, % dentro de 25pts — más el % de
lecturas donde el **régimen** (signo de GEX) coincide entre ambas fuentes,
con el detalle de los momentos puntuales donde no coincidió (esto es lo más
importante: un desacuerdo de régimen es más grave para el trading real que
una diferencia de unos pocos puntos en un muro).

**Criterio de decisión a discutir con el usuario una vez esté el reporte**
(no una regla automática — el umbral final lo define el usuario mirando los
números reales, esto es solo una guía de lectura):
- Si el régimen (signo de GEX) coincide >90-95% de las veces y las
  desviaciones de Put/Call Wall están mayormente dentro de ~25pts (medio
  strike de SPX en épocas normales), el cálculo propio parece confiable
  para reemplazar a Sigma Terminal.
- Si el régimen discrepa con frecuencia real (no solo 1-2 casos aislados) o
  las desviaciones son grandes y no acotadas, mejor seguir dependiendo de
  Sigma Terminal (o investigar la causa de fondo de la discrepancia antes
  de decidir — la memoria `gamma_flip_discrepancy` ya tiene una hipótesis de
  partida: posible diferencia de fuente/ponderación de OI 0DTE).

**Después de la decisión** (fuera de alcance de este skill, señalado acá
para cuando llegue el momento): si se opta por el cálculo propio, hay que
(a) agregar `mvs` de verdad a `calcGEX` en `src/spx.js`, (b) cambiar
`run_gamma_refresh.ps1` para leer `/api/spx/context` en vez de navegar a
Sigma Terminal, y (c) decidir si Sigma Terminal se sigue usando para algo
más (el usuario la mira a mano igual) o se retira del todo del pipeline
automático.

## RESULTADO FINAL DE LA MEDICIÓN (2026-08-02) — decisión tomada

Recolección completa de 3 días (miércoles 29, jueves 30, viernes 31 de
julio): **105 lecturas válidas** de 216 ciclos (109 se saltaron por
`sigma_stale`, 2 por error de red — coherente con las caídas del pipeline de
TradingView/Chrome ya documentadas esos días).

**Resultados:**

| Nivel | Media abs | Mediana | Coinciden exacto | Dentro de 25pts |
|---|---|---|---|---|
| Call Wall | 26.9 pts | 25.0 | 47% | 51% |
| Put Wall | 31.7 pts | 40.0 | 46% | 49% |
| Gamma Flip | 19.5 pts | 17.0 | 2% | 63% |
| MVS (aprox) | 15.2 pts | 0.0 | 66% | 72% |

- **Régimen GEX (signo): coincide 91%** (96/105) — los 9 desacuerdos son
  TODOS en la misma dirección: interno=NEGATIVO, sigma=POSITIVO. Nunca al
  revés.
- **Régimen DEX (signo): coincide 97%** (101/104), pero magnitud interna
  ~2.4x la de Sigma (mediana 1.8x, máx 16.6x).

**Contra el criterio de decisión de arriba:** el régimen cumple (91%, en el
rango 90-95%), pero los muros NO (Put Wall 49% y Call Wall 51% dentro de
25pts, muy lejos de "mayormente dentro"). **Decisión: seguir dependiendo de
Sigma Terminal como fuente primaria**, con el cálculo interno solo de
respaldo — que es lo que ya hacía el sistema, ahora confirmado con datos.

### Investigación de la causa del sesgo NEGATIVO/POSITIVO (2026-08-02)

Se investigaron dos hipótesis. **La primera se descartó con datos:**

1. **~~Discrepancia de precio spot~~ — DESCARTADA.** La hipótesis inicial era
   que usábamos un spot distinto al de Sigma (el GEX escala con S², así que
   importaría mucho). Los datos la desmienten: la diferencia con signo se
   reparte 39%/61% con media de solo **-2.6 puntos** sobre ~7400 (0.035%) —
   es ruido de temporización, no sesgo de fuente. Confirmado además
   consultando las 3 fuentes en vivo el 2026-08-02: **Tradier, Yahoo y Sigma
   dieron exactamente 7489.72**. No hay bug de precio. (La antigüedad del
   dato de Sigma sí infla la diferencia en la cola: <60s → mediana 7.6pts;
   >180s → mediana 30.9pts, pero eso es esperable y ya lo filtra el guard de
   `fresh`.)

2. **Alcance de vencimientos + selección de strikes — CAUSA REAL.** Nuestro
   Net GEX es sistemáticamente **-3.68B más bajo** que el de Sigma (mediana
   -1.75B). Ese corrimiento es lo que empuja las lecturas al terreno negativo
   cuando el valor real ronda cero — marcamos GEX negativo el **40%** de las
   veces vs **31%** de Sigma. Dos diferencias de diseño lo explican:
   - `calcGEX` usa solo las **primeras 4 expiraciones**
     (`enrichedExps = (chainJson.expirations || []).slice(0, 4)`,
     `server.js` en `buildSPXContext`). Probado con cadena real
     (2026-08-02): el Net GEX sube monótonamente al agregar vencimientos —
     +9.4B con 1 exp, +19.0B con 4, +26.3B con 15.
   - Sigma daba **+5.19B** en ese mismo momento, **por debajo incluso de
     nuestra primera expiración sola** — lo que implica que además
     **filtra strikes** (probablemente una banda alrededor del spot),
     mientras nosotros sumamos todos los strikes de la cadena, incluidos
     los muy alejados con gamma×OI grande.

**Conclusión honesta:** no se puede replicar la fórmula de Sigma Terminal —
es una caja negra sin metodología publicada. Cualquier "calibración" sería
ajustar parámetros hasta que los números se parezcan, sin saber si el
mecanismo es correcto. **No se tocó `calcGEX`** por esa razón.

**Lo accionable que queda de esto:** el cálculo interno de respaldo tiene un
**sesgo negativo conocido y medido** (~-3.7B). Tenerlo presente cuando el
sistema cae a ese respaldo (daemon caído, dato viejo), porque puede activar
frenos por "GEX negativo" en casos límite donde Sigma diría positivo — es
exactamente el escenario que en julio costó 4 días sin señales de Reversión
(ver `CLAUDE.md`, sección de Alejamiento de SMA).

## Primer dato real (2026-07-29, ~10:11am local / 11:11am ET)

Capturado durante la implementación de este skill, sirve de referencia
mientras se acumulan más lecturas: régimen coincidió (ambos NEGATIVO), Put
Wall y MVS exactos (0pts de diferencia), pero **Call Wall con 50pts de
diferencia** (interno 7500 vs Sigma 7450) y **Gamma Flip con 25pts** (interno
7435 vs Sigma 7410) — Net GEX con la misma dirección pero magnitud muy
distinta (-$24.4B interno vs -$7.85B Sigma). Un solo punto no alcanza para
concluir nada — es exactamente el tipo de dato que la recolección de 2-3
días va a promediar.

**Segundo dato real, ya con DEX (mismo día, ~11:02am local / 12:02pm ET,
tomado a mano justo después de agregar `netDex` a producción)**: régimen de
GEX coincidió (ambos NEGATIVO), régimen de DEX también coincidió (ambos
NEGATIVO) — pero magnitud de DEX con diferencia grande: interno -$80.6B vs
Sigma -$23.4B (~3.4x), patrón de magnitud similar al ya visto en GEX
(interno -$30.1B vs Sigma -$11.8B en ese momento, ~2.6x). La lectura
direccional (signo) viene coincidiendo consistentemente en ambos puntos de
datos tomados hasta ahora — la magnitud es lo que más difiere.

**Gotcha operativo encontrado el mismo día, sin relación con el cálculo en
sí**: durante esta sesión, tanto Sigma Terminal (la pestaña del navegador)
como TradingView (la conexión CDP) se desviaron de SPX hacia SPY **varias
veces en la misma mañana** — no es un evento aislado. Esto afecta a
`run_gamma_refresh.ps1` (que alimenta `sigma-levels`, del cual depende este
comparador) mucho más que a este skill en sí mismo, que no toca ninguna de
las dos plataformas directamente — ver la sección de ese script y la nota
sobre pestañas de TradingView en `premercado-spx/SKILL.md`. Si el reporte
final muestra menos lecturas de las esperadas para 2-3 días completos
(~230-280), esta es la causa más probable — no un bug del propio
comparador.
