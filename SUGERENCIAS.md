# Sugerencias de cambio — backlog

**Cadencia (regla del usuario, 2026-08-05):** los cambios de estrategia se aplican
**solamente viernes y sábado**, para que empiecen a operar el lunes siguiente. De lunes a
jueves las ideas se anotan acá, no se implementan.

**Los bugs se arreglan de inmediato** (regla explícita del usuario). No esperan al viernes
ni entran a este backlog, sin importar el tamaño del daño.

Lo único que hay que distinguir bien es **corrección vs. ajuste**:

- Si el comportamiento actual es **incorrecto** — un cálculo mal, una orden que no debía
  mandarse, un campo que no se escribe — es **bug**: se arregla ya.
- Si el comportamiento es correcto y lo que se quiere es que sea **distinto o mejor** —
  mover un umbral, agregar un veto, cambiar una ventana — es **ajuste**: se anota acá.

Ante la duda, preguntar en vez de asumir: el costo de esperar un ajuste es bajo, el de
dejar un bug corriendo no.

**Al aplicar:** no mover dos cosas de impacto ALTO a la vez sobre la misma estrategia — si
se mueven juntas, no se puede saber cuál funcionó. Regenerar el control de cambios después
(`python scripts/control_cambios.py`).

---

## Pendientes

### 1. El filtro de dirección de 15m va horas atrasado — DIRECCIONAL, impacto ALTO

**Anotado:** 2026-08-05 · **Evidencia:** sección dedicada en CLAUDE.md

En `entryMode: 'pullback'` la dirección la fija una sola línea (`calcFase15mSimple` en
`src/camino_b.js`): el marco de 15m decide y el de 2m solo aporta timing. La condición
`precio > EMA20 && EMA10 > EMA20 && EMA20 subiendo` arrastra **5 horas de memoria**, así
que sostiene "alcista" mucho después de que el mercado giró.

Medido el 2026-08-05: la sesión abrió en 7789 y cayó sin pausa; el filtro dijo BULL hasta
las 11:00 ET y marcó BEAR recién a las 13:21, **tras 52 puntos de caída**. Las 27 señales
de ese día se generaron entre 9:55 y 11:10 — exactamente la ventana en que decía BULL, o
sea 27 entradas alcistas contra un mercado que caía.

Opciones sobre la mesa, de menor a mayor cambio:

- **(a) Que el MACD 15m pueda vetar.** Si la fase 15m contradice al MACD 15m, no se opera.
  Es el cambio más chico, usa datos que el sistema ya calcula, y ese día habría bloqueado
  las 27 (el MACD estaba bajista, hist −3.44, mientras la fase decía alcista).
- **(b) Exigir que la sesión acompañe.** Sumar precio contra la apertura del día o VWAP.
  Ataca la causa directa: la memoria de 5h arrastrada del día anterior.
- **(c) Acortar el período de la EMA20** en 15m. Lo más simple, pero mete ruido y hay que
  recalibrar.

**Ojo al aplicar:** interactúa con el fix del gate de Crédito/Riesgo desplegado el
2026-08-05. Ese gate estaba rechazando el 100% de los créditos direccionales por un bug de
unidades y, al corregirlo, quedó habilitada una clase de trade que nunca se había
ejecutado — con el filtro de dirección todavía retrasado. Ver
`muestra-direccional-solo-debito` en memoria.

---


### 2. La banda de alejamiento deja pasar el setup por centésimas — REVERSION, impacto ALTO

**Anotado:** 2026-08-13 · **Evidencia:** 112 evaluaciones del 2026-08-13

De 112 evaluaciones, **77 murieron en `SIN_ALEJAMIENTO`** con el estiramiento entre
**−0.09% y −0.12%**, contra una banda que exige **0.13%–0.3%**. Siempre afuera, siempre por
centésimas.

⚠️ **Ojo, discrepancia sin registrar:** esa banda **no coincide** con lo documentado en
CLAUDE.md (0.10%–0.35%, con meseta óptima en 0.15%–0.20%). En algún momento se retocó sin
que quedara anotado — antes de mover nada, confirmar cuál es el valor real en producción y
por qué cambió.

---

### 3. Los dos checks de 5m son un VETO, no un peso — REVERSION, impacto ALTO

**Anotado:** 2026-08-13 · **Evidencia:** los 34 `SCORE_FAIL` del 2026-08-13

Las 34 veces que sí hubo estiramiento, el score dio **exactamente 44.4% contra un mínimo de
75%**, siempre por los mismos dos checks:

| check | peso | motivo |
|---|---|---|
| `compas_medias_5m` | 15 | compás 5m en contra (SMA8 debajo de SMA20) |
| `fase_weinstein` | 10 | Fase 5m no favorece la reversión |

⚠️ **El total no es 100, es 45.** Desde el 2026-08-09, con `puertasBinarias`, el alejamiento
(45) y el GEX (10) se deciden como puertas ANTES del score y su peso **sale del total** — si
no, se contarían dos veces. El score se calcula solo sobre `patron_confirmacion` (20) +
`fase_weinstein` (10) + `compas_medias_5m` (15) + `rsi` (0) = **45**.

Con eso, la aritmética es tajante:

| combinación | puntos | % de 45 | ¿pasa 75%? |
|---|---|---|---|
| solo patrón (lo de hoy) | 20 | **44.4%** | no |
| patrón + fase5m | 30 | 66.7% | no |
| **patrón + compas5m** | 35 | **77.8%** | **sí** |

O sea: **si fallan los dos checks de 5m es imposible llegar a 75, pase lo que pase**. No es
que "cueste": el máximo alcanzable sin ellos es 44.4%. El 5m no es un factor ponderado —
es un **veto**. Y `fase_weinstein` por sí sola tampoco alcanza nunca: la única combinación
que abre la puerta es patrón + compás.

**Esto es el diseño funcionando, no un bug:** es la "regla de oro" de Luis ("5 minutos
decide") — si el Juez contradice la dirección de la reversión, no hay trade. La pregunta es
si un veto es lo que se quiso, o si se creía que era un peso más entre otros.

⚠️ **La evidencia del 2026-08-13 juega EN CONTRA de tocar esto.** Ese día el veto evitó 4
entradas perdedoras seguidas: las señales pedían vender entre 7794 y 7805 y el precio siguió
hasta 7815 antes de girar. Medido sobre las 35 evaluaciones que pasaron las puertas: **34 en
contra a los 15 min, 32 a los 30 min**. Un día no prueba nada, pero cambia la pregunta — de
*"¿el veto es muy estricto?"* a *"¿cuántas veces acertó?"*. Eso lo va a contestar
`GET /api/spx/reversion-sombra` con semanas de muestra, no con intuición.

⚠️ **No mover 2 y 3 el mismo día.** Son las dos de impacto ALTO sobre la misma estrategia; si
se aplican juntas no se puede saber cuál funcionó. Además la 3 cambia *cuántas* señales
llegan a evaluarse y la 4 cambia *cuántas* pasan — mezclarlas hace ilegible la medición.

**Contexto de la muestra:** REVERSION lleva **dos días sin producir nada** (2026-08-12: una
sola señal, que además murió como orden zombi del sandbox; 2026-08-13: cero en 112
evaluaciones).

---

### 4. El tope del pullback (`maxATR` 0.8) mata 1 de cada 4 retrocesos — DIRECCIONAL, impacto ALTO

**Propuesta del jueves 2026-08-27** · **Evidencia:** 830 evaluaciones de pullback de la
semana 21–27 de agosto, más 562 de la semana anterior

`calcPullbackEntry` (`src/camino_b.js:148`) dispara con `cruce || roce`, y `roce` exige
`|d(i−1)| <= maxATR * ATR(14)` con **`maxATR = 0.8` fijo en el código** — no está en
`spx_config.json`, así que no se puede mover sin tocar el fuente.

Descompuse los 1204 `NO_PULLBACK_2M` de la semana. 374 (31%) ni llegan a evaluar el
retroceso porque el marco de 15m no está en Fase 2 ni 4 — esos son de la sugerencia 1, no
de esta. De los **830 que sí lo evalúan**:

| | n | % | qué lo mató |
|---|---|---|---|
| no gira (`d(i) <= d(i−1)`) | 522 | 62.9% | la forma no ocurrió; el tope no interviene |
| gira y está **dentro** del tope | 72 | 8.7% | murió en `d(i−2)`, no en el tope |
| **gira y el mínimo quedó fuera del tope** | **236** | **28.4%** | **el tope** |

Los 236 son la población donde `maxATR` decide. **No mueren por centésimas**: el exceso
mediano es **0.95 pts** contra un tope cuya mediana es **2.13 pts** — se pasan como un 45%
del tope. Por eso la palanca no es un retoque, es un escalón:

| `maxATR` | rescata de los 236 |
|---|---|
| 0.9 | 47 (19.9%) |
| **1.0** | **90 (38.1%)** |
| 1.2 | 140 (59.3%) |

La proporción se repite en la semana anterior — **155 de 562 (27.6%)** — así que es
estructural, no un día raro.

**Qué se espera que pase, en magnitud:** 90 disparos más en la semana. No son 90 órdenes:
el 26-ago se midió que de 16 `SIGNAL_BUILT` sólo 1 llegó a orden (14 murieron en el gate
de Crédito/Riesgo). Con esa proporción son **~5–8 órdenes más por semana**, contra las
pocas que hay hoy.

**Qué más se puede mover sin querer.** Un tope más ancho acepta entradas **más lejos de la
EMA10** — o sea menos retroceso y más perseguir el movimiento, que es exactamente el modo
de falla que motivó la escalera de TP por impulso el 27-ago. Y más entradas es más chance
de que una pierda y suba el listón a 90 para el resto del día.

> ⚠️ **El instrumento es parte de la propuesta, y esa es la mitad importante.**
>
> No hay sombra que pueda contestar esto, y no se puede construir hacia atrás.
> `NO_PULLBACK_2M` guarda `distMinima`, `distActual` y `atr` **sólo dentro de la frase**
> del `reason` (los números de arriba salieron de un regex sobre prosa), y el
> `SIGNAL_BUILT` — el lado aceptado, el que tiene resultado real — **no guarda nada del
> pullback**: su snapshot trae `macd15m`, `score`, `gex`, `spxPrice`, y ni un campo de
> `calcPullbackEntry`. O sea que **no se pueden partir los trades reales por qué tan
> ajustado fue su retroceso**, que es justo la pregunta.
>
> Primero se estampa `distMinima` / `distActual` / `atr` y la razón `|distMinima| ÷ tope`
> en el snapshot de `SIGNAL_BUILT` **y en el registro de la ejecución** — igual que se hizo
> con `macd15m` para DIR-1 y con `algoVersion`, para que la muestra crezca sin depender de
> las 5000 filas del log. Recién con eso se puede partir por banda, como
> `reversion-sombra.porBandaAlejamiento`, y recién ahí mover el 0.8.
>
> Declarada como **DIR-2** en `PROPUESTAS` con `instrumento: None`: el Auditor va a
> devolver `SIN INSTRUMENTO`, y eso es el veredicto correcto, no un trámite pendiente.

⚠️ **Orden con la sugerencia 1 (DIR-1).** Son las dos de impacto ALTO sobre la misma familia:
**no pueden aplicarse en la misma ventana**, o no se sabe cuál funcionó. Y el orden se decide
solo — DIR-1 ya tiene instrumento (`scripts/sombra_direccion.py`, construido el 22-ago) y
DIR-2 todavía no. **DIR-1 primero.** Las dos se tocan además por el mismo lado: DIR-1 cambia
*cuántos* retrocesos se evalúan (hoy 374 de 1204 mueren antes, porque el marco de 15m no está
en fase) y DIR-2 cambia *cuántos de los evaluados* pasan. Moverlas juntas hace ilegible la
medición de las dos.

---

## Anotaciones diarias — sin propuesta todavía (lun–jue se anota)

### 2026-08-31 · corrida diaria, 753 evaluaciones

**a) El día produjo 5 señales y ninguna entró: el embudo completo murió en el último paso.**
Los 5 `SIGNAL_BUILT` y los 5 `ORDEN_RECHAZADA` son el mismo evento, uno a uno, en el mismo
minuto, todas REVERSION y todas entre las **9:47 y las 10:05 ET** — 18 minutos que fueron la
producción entera de la jornada. Lo confirma la calidad del dato por otro lado: el
denominador de `sinSello` quedó en **208, idéntico al viernes**, o sea **ni un cierre nuevo**.
Las cuatro de 9:47–9:51 son el mismo setup reintentado (BULL_PUT 7680/7670 tres veces
seguidas): es el comportamiento esperado cuando la posición nunca llega a abrirse, no un
defecto de la señal. **La causa del rechazo es de la Torre de Control, no mía.**

**b) Un día entero en gamma negativo dejó a TENDENCIA sin margen aritmético, y eso explica las
113 muertes por score.** Dos instrumentos independientes leen lo mismo: NEUTRAL rechazó
**37 de 37** por «Gamma régimen NEGATIVO», y en TENDENCIA el check `regimen_institucional`
falló en **113 de 113**. Ese check pesa 10, así que con el GEX en contra **el techo del score
baja de 100 a 90 contra un listón de 80**: alcanza con que falle un solo check más para
quedar afuera. Y falló — `patrones_estructurales` (20 pts) en 70 casos y
`macd_cruce_pendiente` (15 pts) en 56. La distribución no dejó ni un caso cerca del corte por
arriba: **70% ×57, 75% ×43, 55% ×13, ninguno llegó a 80**. Las 113 fueron bajistas.

⚠️ **Esto no se parece al retrato que tiene el manual.** CLAUDE.md declara que los scores de
TENDENCIA «se apilan arriba» (mediana 90, 146 valen exactamente 100) y concluye que **subir el
listón casi no muerde**. Hoy la masa entera estuvo **entre 55 y 75, debajo del piso**. Un
check de 10 puntos que solo mira el signo del GEX se comportó como un **cuasi-veto de facto**
para toda la familia durante una sesión completa — sin haber sido diseñado como veto.
Se anota con el número; **no se propone nada hasta el jueves**, y conviene mirarlo junto con
la decisión abierta «DEX en el score», que es sobre este mismo check.

**c) El asesino de TENDENCIA se corrió una etapa hacia abajo respecto del viernes.** El 28-ago
el 46% de los `NO_PULLBACK_2M` era «Marco 15m sin Fase 2 ni Fase 4» (**139 de 299**): no había
dirección que operar. Hoy esa razón cayó a **12 de 403 (3%)** — sí hubo dirección, el pullback
disparó mucho más seguido, y por eso los que llegaron al gate de score pasaron de **13 a 113
(×8,7)**. El embudo no se estrechó, se movió: la puerta que mata dejó de ser el 15m y pasó a
ser el score. Es la lectura que el conteo por familia solo no da.

**d) El sello dejó de ser una fuga, y el parte lo lee al revés si uno se queda en el titular.**
`sinSello` está clavado en **127 desde el 21-ago** mientras el denominador subió de **183 a
208**: los **25 cierres nuevos de esos diez días entraron todos sellados**. El «127 de 208»
del parte es un **backlog histórico cerrado**, no un 61% roto ni una pérdida activa.

**e) Segundo día seguido de frescura impecable.** **350 lecturas, 0 sobre el umbral de 120s**,
mediana 18.0s, p90 33s, máximo 118s. **100% Sigma, sin una sola lectura de Yahoo** — coherente
y no sospechoso: Yahoo es el plan B y solo entra cuando Sigma pasa el corte, cosa que hoy no
pasó nunca. Confirma que la mejora anotada el 28-ago se sostuvo, con 350 lecturas en vez de
200.

**f) El hueco de `fuenteCotizacionTPSL` sigue abierto — y hoy quedó acotado a un solo camino de
código.** Los conteos no se movieron (**7 de 7 `TIME_STOP`, 3 de 3 `PRECIO_OBJETIVO`**) porque
no hubo cierres nuevos. Pero el dato nuevo es el contraste: después del corte del 16-ago,
**`TP` trae el campo en 18 de 18 y `SL` en 7 de 7**. La instrumentación **funciona en todo el
resto del sistema**; el hueco es exclusivo de los cierres por nivel de precio de
`checkAlejamientoSMATPSL`. Eso sube la confianza en lo escalado el 28-ago: no es muestra chica
ni un campo que nadie escribe, es esa función. **Sigue siendo posible corrección, no ajuste.**

### 2026-08-28 · corrida diaria, 591 evaluaciones

**a) La sesión estuvo pinneada al Gamma Flip, y eso explica solo las tres familias a la vez.**
Es la hipótesis del día, y las tres puertas la sostienen por separado. NEUTRAL rechazó por
proximidad al flip con el precio **arriba y abajo del mismo nivel** — 7717.09 y 7721.53 contra
un flip en **7720**, buffer 10 pts —, más 4 rechazos por GEX negativo: el régimen estuvo
oscilando sobre la frontera, no en un lado. REVERSION murió 92 veces por `SIN_ALEJAMIENTO` con
las tres razones más repetidas en **0%, 0.01% y 0.02%**, o sea el precio pegado a la SMA8. Y
TENDENCIA: **139 de sus 299 `NO_PULLBACK_2M` son «Marco 15m sin Fase 2 ni Fase 4»**, el 46% —
el filtro de dirección no sostuvo una dirección vieja, directamente no tuvo ninguna. Tres
instrumentos independientes describiendo la misma sesión comprimida contra 7720. **NEUTRAL no
construyó ni una señal** (el 26-ago construyó 1).

**b) Primer día de la serie con frescura impecable, y no es la trampa de composición.** 0 de 200
lecturas sobre el umbral de 120s — el 26-ago fueron 6, la semana pasada 18, la anterior 24 — y
el **máximo bajó a 115s**, primera vez que no roza el corte de validez de 180s (venía en 158s y
179s). Lo importante es que esta vez la mejora es real: **Sigma cubrió el 100% (200/200), sin
una sola lectura de Yahoo**, así que la mediana de 18.0s es puramente Sigma y se compara limpia
contra sus 22.0s del 26-ago y de la semana. Es lo contrario de lo anotado el 25, 26 y 27, donde
el promedio bajaba solo porque la fuente lenta pesaba menos. Cero Yahoo es además coherente y no
sospechoso: es el plan B y solo entra cuando Sigma pasa los 180s, cosa que hoy no pasó nunca.

**c) `PRECIO_OBJETIVO` confirma el patrón de `TIME_STOP`: el monitor de Reversión no sella
ninguno de sus cierres por nivel. Posible corrección.** `edadCotizacionTPSLSeg` y
`fuenteCotizacionTPSL` faltan en **7 de 7 `TIME_STOP` y en 3 de 3 `PRECIO_OBJETIVO`**: **10 de
10**, dos motivos independientes, los dos al 100%. El 26-ago `TIME_STOP` iba 4 de 4 y podía
leerse como muestra chica; con `PRECIO_OBJETIVO` sumándose desde el 27 (2 de 2, hoy 3 de 3) ya
es determinista — es el camino de código, no los casos. Los dos motivos son de
`checkAlejamientoSMATPSL`, que cierra por nivel de precio del índice. Importa por una razón
concreta: CLAUDE.md declara que **sin precio fiable ese monitor queda sin ninguna salida
automática** (TP, SL y time-stop son todos por nivel), así que la edad del spot con el que
cerró es justamente el dato que haría falta para auditar cada uno de esos 10 cierres, y no
existe. Misma forma que (b) del 27-ago con `paperEntry` en NEUTRAL. Campo que no se escribe =
bug, no ajuste: **se escala como posible corrección, no espera al viernes.**

**d) `SCORE_FAIL` de REVERSION se multiplicó por 9.5 en dos días — y el listón no es el mismo
número entre días, así que la comparación puede no significar nada.** 4 el 26-ago → **38 hoy**,
de las cuales **25 marcaron 33.3% contra un mínimo de 37.8%**: murieron por 4.5 puntos, todas
con el mismo score exacto. Pero antes de leer eso como «el mercado estuvo al borde»: el mínimo
citado en el log fue **37.8% hoy, 37.8% y 54.5% mezclados el 27-ago, y 75% el 21-ago** — y
`minScore` en los parámetros vigentes de Reversión es **75**. Si el listón se recalcula por
evaluación (checks aplicables, normalización), entonces **ningún `SCORE_FAIL` de esta familia es
comparable entre días ni dentro del mismo día**, que es el mismo defecto de instrumento que (j)
del 27-ago con `POSITION_OPEN` en TENDENCIA. **Pregunta abierta, sin propuesta: ¿por qué el
mínimo de Reversión cambia entre 37.8%, 54.5% y 75%?** Hasta contestarla, el ×9.5 no se puede
usar para nada.

**e) El slot de posición pesó el doble que el lunes, y sigue sin poder medirse en TENDENCIA.**
REVERSION `POSITION_OPEN` **23 → 49** contra el 26-ago, y por la asimetría documentada eso
arrastra a las otras: NEUTRAL pasó de **5 a 15** (×3), porque su `hasOpenPosition('SPXW')` sí ve
la posición de Reversión. TENDENCIA marca **0 por quinto día seguido** — el `return` mudo de
`server.js:6121` anotado el 27-ago —, así que la parte más grande del bloqueo es la que no se
ve. El total real de tiempo con el slot ocupado hoy es mayor que 64.

**f) Los 13 `SCORE_FAIL` de TENDENCIA marcaron los 13 el mismo score: 70% contra 80%.** Ni una
sola cita del escalón de 90 hoy. Trece evaluaciones clavadas en 70 sobre un listón de 80 es un
solo check de 10 puntos apagado y sostenido en el tiempo (`ema_10_20_alineadas` o
`regimen_institucional` son los dos que valen 10) — no una distribución. Contrasta con lo
documentado en CLAUDE.md, donde los scores de TENDENCIA se apilan en 90–100. **Anotado sin
propuesta: el snapshot de `SCORE_FAIL` no guarda qué check falló, así que no se puede confirmar
cuál de los dos fue.** Sin ese campo el hallazgo no se puede cerrar, igual que `NO_STRIKES` en
(h) del 27-ago.

**g) `NO_STRIKES` con delta 0.50 rebrotó en REVERSION: 9 hoy contra 4 en toda la semana previa.**
Delta 0.50 es ATM. Sigue sin poder distinguirse «cadena comprimida» de «problema de la cadena»
por la misma razón de (h) del 27-ago: el snapshot no guarda el rango de deltas que sí había.

**h) Constancias, sin novedad — se anotan solo para que no se relean como hallazgos.** Sellos:
**127 de 208**, con el numerador clavado en 127 desde el 21-ago mientras el denominador subió de
183 a 208 — **los 25 cierres nuevos de la semana están sellados los 25**, es la deuda del 3-ago
y no crece. `VETO_MURO_SOMBRA` volvió a empatar exacto con `SIGNAL_BUILT` (**6 y 6**), sexta vez
seguida: contador de sombra, no puerta, y `embudo.evaluaciones` sigue contando cada señal de
TENDENCIA dos veces. `sinLibroDespuesDelCorte` sigue en **4**, no sumó ninguno hoy.

**i) La corrida diaria no trae comparativa y el parte no lo dice.** `embudoPrevio` viene `null`
en las cuatro diarias de la semana (24, 25, 26 y hoy), así que la sección «dónde mueren las
decisiones» sale sin el «(antes m)» y toda la comparativa día-contra-día de esta anotación la
hice a mano contra `datos/2026-08-26.json`. Es distinto del problema de retención anotado el
27-ago —allá la ventana semanal estaba recortada, acá la comparativa diaria directamente no
existe— y se acumula sobre él: **hoy el motor no puede comparar ni contra ayer ni contra la
semana pasada.**

---

### 2026-08-27 (bis) · revisión SEMANAL del jueves, 21–27 de agosto

**a) `embudoPrevio` está truncado por la retención del log, y nadie lo dice.** El log de
producción está **exactamente en 5000 filas** — el tope. La semana en curso se lleva 2654 y
la de comparación 2346: **5000 justo**. El día más viejo, el 14-ago, conserva **171 filas y
su primera es de las 17:22Z**, cuando todos los demás días arrancan **13:45Z**: se perdieron
**3h37m de una sesión de 6h05m**, y los días comparables traen entre 425 y 887 filas. La
semana anterior está subestimada en unas **250–350 filas (~11–15%)**, concentradas en la
mañana.

Consecuencia: **todos los «(antes m)» del parte exageran el aumento.** El sentido del cambio
se sostiene, la magnitud no. Y va a empeorar solo: a 2654 filas por semana, el tope de 5000
no alcanza para dos ventanas de 7 días — **la comparativa semanal queda estructuralmente rota
de acá en adelante**. `scripts/sombra_direccion.py` ya documenta este límite para su propia
muestra; el motor de calidad no lo comprueba.
**Posible corrección, del lado del motor:** que compare `desde_prev` contra la fila más vieja
del log y avise en vez de reportar en silencio sobre una ventana recortada.

**b) NEUTRAL no escribe `paperEntry` nunca: 2 de 2, y ninguna otra familia falla.** Desde el
corte del 16-ago hay 32 cierres. TENDENCIA **0 de 24** sin `paperEntry`, REVERSION **0 de 6**,
NEUTRAL **2 de 2** — con el motivo a la vista en el propio registro: *«apertura sin marca: sin
dato»*. Uno es de **hoy** (`tex-1787774500000`, cierre por TP a las 13:48), así que no es deuda
vieja. Es un camino de código que no escribe, misma forma que el `TIME_STOP` confirmado el
26-ago, y el efecto es que **el Iron Condor no puede medirse nunca contra la cadena real**:
`src/pnl_oficial.js` lo marca no comparable. Explica la mitad NEUTRAL del hallazgo del 21-ago
(*«REVERSION y NEUTRAL: cero trades medidos contra la cadena real»*) — la mitad REVERSION ya
se cerró sola, hoy va 6 de 6 con libro completo. **Escalado como posible corrección.**

**c) `MANUAL_FORZADO` se queda sin `paperExit` la mitad de las veces** (2 de 4, las dos de
TENDENCIA) y es el **único** motivo de cierre que aparece en esa columna. Misma familia que
(b) pero sin determinismo: con 2 de 4 no se puede separar «el camino no lo escribe» de «esos
dos no lo tenían». Segundo caso del mismo tipo esperando muestra, como pasó con `TIME_STOP`.

**d) Los sellos no son un problema y conviene decirlo con el número: los 127 sin sello cerraron
todos el 3 de agosto o antes.** El denominador subió de 183 a 199 y el numerador no se movió ni
una vez: **los 18 cierres reales de la semana están sellados los 18**. Es deuda histórica con
frontera dura, no una fuga. El parte la canta como *«127 de 199»* al lado de la frescura, donde
se lee como un problema de hoy.

**e) La frescura «mejoró» otra vez por composición, y ahora se puede medir a escala semanal.**
Titular 16s de mediana contra 18s la semana pasada. Pero Sigma —la fuente que se paga y la que
manda— **empeoró de 20s a 22.0s** y su participación **cayó de 88.6% a 75.6%** (n 1041 → 900),
mientras Yahoo (4s por construcción) **duplicó su peso, de 11.4% a 24.4%**. Las dos fuentes
fueron a peor o a menos y el promedio mejoró: lo único que bajó la mediana es que la fuente
lenta pesó menos. Es la misma trampa anotada el 25 y el 26 de agosto, ahora con una semana
entera detrás. Las decisiones por encima de 120s bajaron de 24/1175 (2.0%) a **18/1191 (1.5%)**
y el máximo sigue clavado en **179s contra el corte de validez de 180s** — ninguna decisión se
tomó con dato inválido, pero se está usando el último segundo.

**f) La banda de alejamiento: la semana entera contesta la sugerencia 2, y contesta que no.**
822 rechazos por `SIN_ALEJAMIENTO`, **mediana |alejamiento| 0.040%** contra un piso de 0.10%,
p90 **0.080%**, y **cero** casos dentro de la banda. El reparto:

| \|alejamiento\| | n | % |
|---|---|---|
| 0.00–0.02% | 141 | 17.2% |
| 0.02–0.05% | 327 | 39.8% |
| 0.05–0.08% | 266 | 32.4% |
| 0.08–0.10% | 86 | **10.5%** |

Sólo el 10.5% queda a menos de 2 centésimas de la puerta; **el 89.5% está de 1.2x a 5x lejos**.
Bajar el piso a 0.08 rescata ese 10.5%; para alcanzar la mediana habría que llevarlo a ~0.04,
que es no tener puerta. **El diagnóstico que originó la sugerencia 2 (13-ago, «todo entre
−0.09% y −0.12%, siempre afuera por centésimas») ya no describe lo que pasa** — lo venían
diciendo las anotaciones del 24 y el 26, ahora con la semana completa. La sugerencia 2 debería
reescribirse o retirarse; el mercado no se está estirando, y eso no se arregla moviendo la
puerta.

**g) El escalón de `minScore` a 90 costó exactamente 3 señales en dos semanas.** Esta semana 12
de los 20 `SCORE_FAIL` de TENDENCIA citan el escalón, pero **sólo 3 marcaban 80** — el mínimo
normal — y las otras 9 marcaban 65, o sea que caían igual. La semana anterior: 22 rechazos con
escalón y **ninguno** habría pasado a 80 (marcaban 75 y 55). Total del daño medible en dos
semanas: **3 señales, todas del mismo día y del mismo cierre de −$60**. La pregunta abierta del
24-ago (¿el escalón se calibra por tamaño de la pérdida?) sigue abierta —salta igual con −$20,
−$45, −$60 y −$245— pero **con n=3 no hay propuesta**, y además no se sabe si esas 3 habrían
ganado.

**h) `NO_STRIKES` con delta 0.30 fue un brote de dos días, no una tendencia.** TENDENCIA: 25 el
25-ago, 13 el 26-ago, **0 el 21, el 24 y el 27**, y **0 en toda la semana anterior**. REVERSION
sumó 4 con delta 0.50. Siguen sin poder distinguirse «cadena comprimida» de «problema de la
cadena»: el snapshot de `NO_STRIKES` no guarda el rango de deltas que sí había. Sin eso no se
puede cerrar.

**i) `VETO_MURO_SOMBRA` volvió a empatar exacto con `SIGNAL_BUILT`: 74 y 74.** Quinta vez
seguida (7/7, 34/34, 50/50, 16/16 y ahora 74/74). El 26-ago quedó explicado —`server.js:6633`
lo emite incondicionalmente, es un contador de sombra y no una puerta— así que se repite sólo
para dejar constancia de que **`embudo.evaluaciones` sigue contando cada señal de TENDENCIA dos
veces**. Cualquier porcentaje por etapa de esa familia está inflado, y el motor no lo corrige.

**j) TENDENCIA sigue sin escribir `POSITION_OPEN`, cuarto día.** En toda la semana: NEUTRAL 97,
REVERSION 74, **TENDENCIA 0**. Es el `return` mudo de `server.js:6121` ya anotado el 27-ago por
la mañana. Con la semana entera delante el efecto es mayor de lo que parecía: NEUTRAL murió por
slot ocupado **97 de 194 veces (50%)**, así que el sistema pasa la mitad del tiempo con algo
abierto — y en toda esa mitad **el embudo de TENDENCIA está mudo**. No es comparable entre
semanas.

**k) Para la Torre, y no lo trae el motor: 7 órdenes atascadas sin llenar.** De las 11 de toda
la historia, **7 cayeron en esta ventana** (20-ago ×3, 21-ago ×4, 24-ago ×2, 25-ago ×1 — el
26 y el 27, ninguna), todas `canceled` con `pnl 0`. Tres son Reversión seguidas el 21-ago a las
15:45, 15:48 y 15:49. Importa acá por una sola razón: `hasLocalOpenSPXWPosition()` cuenta
`submitted` como abierta, así que **cada orden atascada bloquea a las tres familias hasta que
la limpieza la cancela a los 10 minutos** — es una causa candidata de los `POSITION_OPEN` de
(j). El diagnóstico es de la Torre. Se lo paso. `paraLaTorre` no las ve porque viven en las
ejecuciones, no en el log de estrategia.


### 2026-08-27 · corrida diaria, 381 filas de log

**a) La direccional salió por un `return` mudo ~3 horas del día, y el embudo no lo dice.**
`server.js:6121` — cuando hay una posición abierta que no es una Reversión, `checkDirectionalAutonomous`
hace `return` **sin escribir ninguna fila**. Los otros dos pipelines sí registran `POSITION_OPEN`
(NEUTRAL 31, REVERSION 17), por eso solo TENDENCIA desaparece.

La prueba es el control: **REVERSION quedó clavada en 195 filas exactas** el 26 y el 27
(166+23+4+2 = 170+17+6+2), o sea el proceso estuvo vivo y su ciclo corrió completo. En la misma
ventana TENDENCIA cayó de **501 a 143 filas (−71%)**. Descontando el doble conteo ya anotado el
26-ago (`VETO_MURO_SOMBRA` = `SIGNAL_BUILT`, 11) y los `CIERRE_DISPARADO` (20), quedan **~112
ciclos** que evaluaron entrada, contra los **~510** que caben en la ventana 9:45–14:00 a 30s.
**~78% del día operable la direccional no evaluó y no lo dijo.**

Consecuencia para el instrumento, que es lo que importa: **el embudo de TENDENCIA no es
comparable entre días.** Un día con mucho tiempo en posición se lee como *«el mercado no dio»*
cuando la puerta ni se abrió. Cualquier lectura de por qué no entró la direccional hoy está
sesgada a los ciclos en que el slot estaba libre.

No es un error de decisión — no operar mientras hay posición abierta es deliberado y está
documentado (2026-07-28). Es **un campo que no se escribe** → va como posible corrección, no
como ajuste de estrategia. Una línea de log, sin tocar la lógica.

**b) `TIME_STOP` y `PRECIO_OBJETIVO` sin `fuenteCotizacionTPSL` — es un falso positivo del motor.**
El parte los marca como *«falta en todos»* (4/4 y 2/2). No faltan: **no aplican.** Los dos son
cierres del monitor de Reversión (`server.js:11274-11278`), que decide por **precio del SPX**,
no por cotización de las patas — sólo escriben esos campos los monitores que sí cotizan
(`server.js:9233`, `9926`). No hay nada que arreglar ahí, y conviene que el motor deje de
pintarlo como defecto o el ámbar pierde significado.

**Lo que sí falta de verdad es otra cosa**: la Reversión cierra por precio del SPX y **no graba
la frescura de ese precio**. Es justo el dato que haría auditable un cierre (CLAUDE.md:
«sin precio fiable, los monitores NO actúan»). El campo no existe. Hueco real de instrumentación.

**c) Sigma es la fuente primaria y es 9x más vieja que el respaldo.** Hoy: sigma n=128 mediana
**28s**, yahoo n=78 mediana **3s**. Y el reparto se mueve solo, mucho: 25-ago yahoo 207/sigma 104,
26-ago sigma 248/yahoo **3**, 27-ago sigma 128/yahoo 78. Hoy **38% de las lecturas cayeron a
plan B**, o sea el daemon estuvo intermitente.

Las decisiones con precio de más de 120s vienen subiendo tres días seguidos: **1 → 6 → 7**, con
máximo **179s** contra el umbral duro de Sigma de **180s** — se está usando hasta el último
segundo de validez. Ninguna cruzó el corte, así que nada se decidió con dato inválido, pero la
tendencia va en una sola dirección. Palanca conocida (CLAUDE.md): bajar `MAX_EDAD_SIGMA_SPOT_SEG`
o acortar el ciclo del daemon. **Candidato a propuesta del jueves si el jueves sigue subiendo.**

**d) La banda de alejamiento está cerrada de hecho otra vez — 87%.** REVERSION murió en
`SIN_ALEJAMIENTO` **170 de 195** (87%), y los tres valores más repetidos son **0.05%, 0.06% y
0.08%** contra un piso de **0.10%**: 77 de las 170 quedaron a menos de 5 centésimas de la puerta.
Estable en los tres días (165 · 166 · 170), así que no es un día raro.

Es **el mismo patrón** que ya motivó bajar la banda de 0.13 a 0.10 (`075945c`, *«estaba cerrada
de hecho»*) — está volviendo a pasar en 0.10. Refuerza la sugerencia pendiente **2** con número
propio. **No se propone hoy** (lun–jue se anota); el jueves, si sostiene, va con esta evidencia.

**e) Los tres se pisaron por el mismo slot, y ese es el «por qué» del día.** El sistema pasó la
mayor parte de la sesión con una posición abierta: NEUTRAL bloqueada por `POSITION_OPEN` **31
veces** (vs 5 el 26) y REVERSION **17**, más los ~398 ciclos mudos de TENDENCIA de (a). El Iron
Condor **no murió por régimen hoy**: `GATE_FAIL` bajó de 31 a **5** y *«Gamma régimen NEGATIVO»*
—que ayer fue el bloqueo #1 con 17— **desapareció del top**; los 5 son falta de PIN (precio a
8.7/17.6/21.9 pts del muro, máx 5). O sea el régimen mejoró y el IC igual no entró, **porque el
slot estaba ocupado**, no porque el mercado no diera.

Y en TENDENCIA cambió la causa: ayer dominaba *«Marco 15m sin Fase 2 ni Fase 4»* (201 de 439);
hoy **no aparece en el top** — las tres razones son distancia a la EMA10 (3.90 pts contra tope
2.50; 2.58 contra 1.55). **Hubo tendencia definida y no hubo retroceso**: el precio se fue sin
dar entrada. Con la salvedad de (a): sólo se ve la parte del día con el slot libre.

**f) Los sellos están sanos; el 127 del parte es deuda vieja congelada.** `sinSello` marca 127 y
suena mal, pero es **exactamente 127 los tres días** mientras el denominador sube 188 → 191 → 199.
El numerador no se mueve: **los 11 cierres nuevos traen sello.** El 127 es histórico y no crece.

**g) Un cierre nuevo sin libro propio, y es de ayer después del campanazo.**
`sinLibroDespuesDelCorte` pasó de 3 a 4: entró `tex-1787774500000`, del **26-ago 16:01 ET** — o
sea *después* del cierre y después de la corrida de calidad de ayer (16:15), por eso aparece hoy.
Los otros tres siguen siendo los mismos del 14, 17 y 20 de agosto. Sin libro propio ese cierre
no es comparable (`src/pnl_oficial.js`).

### 2026-08-26 · corrida diaria, 735 filas de log

**a) `VETO_MURO_SOMBRA` no descarta nada — es un contador de sombra, y lo dije mal el lunes.**
Queda corregido acá porque la anotación del 24-ago decía que *«descarta ~1 de cada 2 señales de
TENDENCIA»*, y es falso. `server.js:6633` lo emite **incondicionalmente** para toda señal que
llega a ese punto, con `passed: !vetaria` — es una observación, no una puerta. Hoy: **16 de 16
`passed: true`, cero habrían sido vetadas.** En todo el log (14-ago → 26-ago): 107 emisiones,
**7** con `vetaria`. El empate perfecto con `SIGNAL_BUILT` cuatro días seguidos (7/7, 34/34,
50/50, 16/16) no era una proporción, era **la misma señal escribiendo dos filas**.

Consecuencia para el instrumento: **`embudo.evaluaciones` cuenta filas de log, no decisiones.**
Cada señal de TENDENCIA se cuenta dos veces. Que los conteos sumen exacto al total no prueba que
las etapas sean excluyentes — prueba que el motor suma todo lo que hay. Cualquier porcentaje por
etapa de TENDENCIA está inflado.

**b) La última etapa del embudo miente: 16 señales construidas, 1 trade.** De los 16
`SIGNAL_BUILT` de TENDENCIA de hoy (9:50–12:34 ET), **1 se ejecutó**, 1 se descartó por posición
ya abierta, y **14 murieron en el gate de Crédito/Riesgo — que no aparece en ninguna parte del
embudo**, porque se aplica después de `SIGNAL_BUILT`. Los 14 son Bull Put Spread con ratios de
**9.9%, 10.9%, 11.5%, 12.2% ×3, 12.4%, 13.4%, 13.6%, 13.8%, 15.2%, 17.2%, 18.6%, 19.2%** contra
un mínimo de 20%. Todos con **score 85 o 100**: el playbook decía señal buena y el mercado no
pagaba la prima. Con `ivRank 10` y `VIX 15.29` eso es lo esperable, no una anomalía — el gate
hizo su trabajo. Dos rozaron el corte (18.6% y 19.2%). **Lo anotable no es el gate: es que el
embudo declara «señal construida» como si fuera éxito cuando 15 de 16 no llegaron a orden.**

**c) El día fue un pin, y las tres familias se plantaron por la misma causa.** Sigma (631
lecturas, 571 en mercado): `netGex` **cruzó cero 32 veces**, `|netGex|` mediana 4.95B con 26% de
las lecturas por debajo de 2B, y el precio estuvo a una **mediana de 8.2 pts del Gamma Flip**,
con **68% de las lecturas dentro del buffer de 10 pts**. En la ventana del IC 0DTE: **55%
NEGATIVO, 11 cambios de régimen, 75% dentro del buffer.** Contra eso:
TENDENCIA murió en `NO_PULLBACK_2M` 439, y dentro de eso *«Marco 15m sin Fase 2 ni Fase 4»*
saltó de **81 a 201** — el marco de tendencia correctamente no encontró tendencia.
NEUTRAL murió en `GATE_FAIL` 31, con *«Gamma régimen NEGATIVO»* 17.

**d) Se cae mi hipótesis de ayer sobre el `GATE_FAIL` del Iron Condor.** Ayer atribuí el salto de
5→31 a que el daemon degradado empujaba al `calcGEX` interno, que tiene sesgo negativo medido.
**Hoy el daemon estuvo sano** (`mode: normal`, 0 fallos, sigma n=248 mediana 22s) y el
`GATE_FAIL` se mantuvo en 31. Con Sigma fresca y Sigma misma oscilando 32 veces sobre cero, el
bloqueo de hoy es **régimen real, no degradación de dato**. La hipótesis de ayer puede seguir
valiendo para ayer; para hoy no. Y hoy el buffer del Gamma Flip queda **respaldado**, no
cuestionado: existe porque el régimen puede darse vuelta de golpe, y hoy se dio vuelta 32 veces.

**e) La deriva del `minScore` de REVERSION sigue en pie, tercer día.** Los 4 `SCORE_FAIL` citan
*«mínimo 37.8%»* contra el **75** declarado en el bloque `parametros-vigentes-reversion` de
CLAUDE.md. Ya anotado el 24 y el 25; se repite para que no se pierda.

**f) La banda de alejamiento sigue sin morir por centésimas.** Los tres motivos más repetidos de
`SIN_ALEJAMIENTO` (166) son **−0.05%, −0.02%, −0.03%** contra un piso de 0.10% — de 2x a 5x
lejos, no al borde. Tercer día consecutivo. **Esto juega en contra de la sugerencia 2 del
backlog**, cuyo diagnóstico original (el setup moría por centésimas) ya no describe lo que pasa.

**g) Frescura: peor que ayer, y el parte no lo dice.** 6 de 251 decisiones sobre el umbral de
120s (**2.4%**, contra 0.3% ayer y 1.4% el lunes), máximo 158s — degradado, no inválido (el
corte de validez es 180s). Sigma volvió a ser primaria (248 vs 3 de Yahoo) y su mediana es 22s
contra los 4s de Yahoo: **la mediana del día empeoró de 5s a 22s justamente porque la fuente
buena volvió.** Misma trampa de lectura que ayer, al revés.

**h) Los sellos siguen sin sangrar, tercer día.** `sinSello` clavado en **127** con el
denominador subiendo 186 → 188 → **191**: los cierres nuevos vienen sellados. Es deuda histórica
congelada, no una fuga activa — el parte los mezcla en una sola cifra.

### 2026-08-25 · corrida diaria, 742 evaluaciones

**a) La frescura "mejoró" porque la fuente primaria se cayó.** El parte canta **mediana 5s
(p90 26s)** contra los 21s de ayer y lo lee como verde. No lo es: la mediana bajó porque
**Yahoo desplazó a Sigma**, y Yahoo es más rápido por construcción. El reparto se dio vuelta
entero en un día — **ayer sigma 207 / yahoo 2, hoy yahoo 207 / sigma 104**. La causa está en
`gamma_daemon/status.json`: `mode: "degraded"`, `consecutiveFailures: 6`, **`lastSuccessAt`
10:57 ET** — o sea sin lectura buena durante la mayor parte de la sesión. **La métrica de
calidad mejoró como consecuencia directa de una degradación.** Vale para el motor: una
mediana de frescura sin el reparto por fuente al lado se puede leer al revés.

**b) Lo que eso le hace a la señal (esto sí es del dato, no del proceso).** Cuando Sigma no
está fresca, `effectiveGex` cae al `calcGEX` interno — que tiene **sesgo negativo medido**
(ver `gamma_flip_discrepancy`, y el 05-ago el `gammaFlip` interno dio 7600 contra 7753 de
Sigma, 153 pts con un buffer de gate de 10). Hoy `NEUTRAL|GATE_FAIL` pasó de **5 a 31** y los
motivos visibles son *Gamma régimen NEGATIVO* y *precio a menos de 10pts del Gamma Flip*,
mientras la última lectura buena de Sigma —congelada a las 10:57— decía **`regime: POSITIVO`,
netGex +5.51B, gammaFlip 7660**. **Hipótesis, no veredicto:** el Iron Condor pasó el día
bloqueado por el régimen de la fuente de respaldo, no por la primaria que se paga. Lo
confirmaría registrar **qué fuente de GEX decidió cada bloqueo** — hoy el snapshot no lo trae,
y sin eso esto no se puede cerrar. Mismo día en que los muros gobernaron `VETO_MURO_SOMBRA`
(34) con el spot viniendo de otra fuente distinta a los muros.

**c) `VETO_MURO_SOMBRA` sigue empatado con `SIGNAL_BUILT`, y el empate ya es exacto tres
veces.** Hoy **34 y 34**; ayer 7 y 7; la semana del 16–22, 50 y 50. Verifiqué otra vez que
las etapas son terminales y excluyentes (510+194+38 = **742**, cuadra exacto), así que no es
doble conteo. Pero **un empate perfecto en tres ventanas de tamaño muy distinto (14, 100, 68)
no es lo que hace una proporción libre**. O el acoplamiento es estructural —toda señal se
evalúa contra el muro y justo la mitad cae— o los dos contadores se mueven juntos por
construcción. **Antes de proponer nada sobre el veto del muro hay que resolver cuál de las
dos es**, porque si es lo segundo, la mitad de la evidencia de la anotación de ayer (punto b)
se cae.

**d) `NO_STRIKES` con delta 0.3 apareció de la nada en TENDENCIA: 25 hoy, 0 ayer.** En la
semana previa fueron 6. Veinticinco evaluaciones que llegaron hasta la cadena y no encontraron
strike al delta objetivo. Puede ser cadena comprimida (día de vencimiento — `expiry` de Sigma
es hoy mismo) o un problema de la cadena. **No alcanza para distinguirlo desde el embudo.**

**e) El motor trunca los motivos a los 3 más repetidos, y eso está tapando la mayoría.** Es
la limitación que más pesó hoy: `NEUTRAL|GATE_FAIL` muestra **6 de 31**, `TENDENCIA|
NO_PULLBACK_2M` **93 de 410**, `REVERSION|SIN_ALEJAMIENTO` **80 de 165**. O sea que del mayor
movimiento del embudo —el 6x de GATE_FAIL— **no se ve el motivo de 25 de los 31 bloqueos**.
Sumado a que `embudoPrevio` viene `null` en modo diario (ya anotado ayer), el instrumento no
está alcanzando para el paso 3 en los días movidos.

**f) REVERSION marcó score **0%** nueve veces** (mínimo citado 37.8%). No es quedarse corto:
es que no pasó **ningún** check. Sigue vigente lo anotado ayer sobre que el mínimo citado se
mueve y nunca coincide con el **75** declarado en `parametros-vigentes-reversion`.

**Lo que mejoró de verdad:** `POSITION_CHECK_MISMATCH` llegó a **0** (era 4 ayer, 511 en la
semana) y **no hubo ninguna orden rechazada**. `paraLaTorre` quedó en 0/0 por primera vez. Y
los sellos siguen sin sangrar: `sinSello` clavado en **127** con el denominador subiendo de
186 a 188 — los cierres nuevos vienen sellados los dos.

---

### 2026-08-24 · corrida diaria, 425 evaluaciones

**a) Evidencia EN CONTRA de la sugerencia 2 (banda de alejamiento).** Hoy `SIN_ALEJAMIENTO`
mató **162 de 192** evaluaciones de REVERSION (84%), pero los tres motivos más repetidos son
**−0.02% (18), −0.04% (12) y −0.05% (12)** contra un piso de **0.10%**. Eso ya **no es "por
centésimas"**: están a 2–5x de distancia del piso. La banda ya bajó de 0.13 a 0.10 en
`075945c` y la puerta sigue matando la misma proporción (88% en la semana del 16–22, 84% hoy).
Bajarla otra vez no rescataría a estos salvo llevándola casi a cero. **Antes de volver a
tocar la banda el jueves, esta anotación pide releer la sugerencia 2 — el diagnóstico que la
originó (2026-08-13, todo entre −0.09% y −0.12%) ya no describe lo que pasa.**

**b) `VETO_MURO_SOMBRA` descarta cerca de la mitad de lo que llega al final — TENDENCIA.**
Hoy **7 `SIGNAL_BUILT` contra 7 `VETO_MURO_SOMBRA`**; en la semana del 16–22, **50 contra 50**.
Las etapas son terminales y mutuamente excluyentes (los conteos suman exacto las evaluaciones:
198+192+35 = 425), así que no es la misma señal contada dos veces: de cada dos señales que
llegan a esa altura, **una muere en el veto del muro**. La proporción se sostiene en dos
ventanas de tamaño muy distinto, o sea que es estructural, no ruido de un día.
**No hay propuesta:** falta saber si las vetadas habrían ganado o perdido, y eso lo contesta
la sombra, no el embudo.

**c) El escalón de `minScore` a 90% tras un perdedor cierra el día por muy poco.** Los **12**
`SCORE_FAIL` de TENDENCIA de hoy llevan todos el sufijo *«el trade anterior de hoy cerró en
$-60 — se exige 90%»*. **3 de esos 12 marcaban 80%**, que es el mínimo normal declarado. Una
pérdida de $60 subió la puerta y con eso se descartaron 3 señales que cumplían el estándar
habitual. El mismo patrón está en la semana (9 rechazos a 75% tras un cierre de −$45) y en la
anterior (22 rechazos a 85% tras uno de −$245). **Pregunta para el jueves, no propuesta:** el
escalón, ¿está calibrado por tamaño de la pérdida o se dispara igual con $60 que con $245?

**d) El `minScore` de REVERSION no citó 75 ni una sola vez hoy.** Los `SCORE_FAIL` citan
**«mínimo 54.5%»** (9 veces) y **«mínimo 37.8%»** (2). El bloque `parametros-vigentes-reversion`
de CLAUDE.md declara `minScore: 75`, y el 22-ago todavía aparecían 27 rechazos citando 75.
Los umbrales observados son múltiplos de 1/11 (9.1%, 45.5%, 54.5%), o sea que el denominador
de la normalización se mueve. Puede ser correcto —el diseño de puertas binarias saca pesos del
total— pero **el manual declara un número que el robot no está citando**, y ese bloque existe
justamente para que eso no pase.

**e) Sospecha de bug de trazabilidad en `TIME_STOP`** — ver PENDIENTE DE DECISIÓN abajo.

**Lo que mejoró y conviene no perder de vista:** el sangrado de sellos **paró**. `sinSello`
quedó clavado en **127** mientras el denominador subió de 183 a 186 — los 3 cierres nuevos
desde el sábado traen sello los 3. El 127 es **deuda histórica congelada, no una fuga activa**,
y el parte no distingue una cosa de la otra.

---

## Decisiones pendientes (no son sugerencias, son cosas sin responder)

- **¿Un cierre por `TIME_STOP` está dejando de escribir la trazabilidad de su cotización?**
  (anotado 2026-08-24). Aparece un motivo nuevo en `camposFaltantes`: `TIME_STOP` sin
  `fuenteCotizacionTPSL` **ni** `edadCotizacionTPSLSeg`, en **1 de 1 (`todos: true`)**. No
  estaba el 22-ago. Si el camino de código no escribe esos campos nunca, es un **bug** —es
  justo la trazabilidad que faltaba el 2026-08-08, cuando el spot llegaba 16 min tarde y no
  había cómo saberlo— y se corrige el mismo día. Con **n=1** no puedo separar «ese camino no
  lo escribe» de «ese cierre puntual no lo tenía», y por eso no lo escalo como bug confirmado.
  **Pregunta de sí o no: ¿se revisa el camino de `TIME_STOP` ahora, o se espera a un segundo
  caso?**

  > **Actualización 2026-08-25 — llegó el segundo caso, y la pregunta se contestó sola.**
  > Ahora son **2 de 2, `todos: true`** en los dos campos. Dos cierres por `TIME_STOP` en dos
  > días, ninguno con trazabilidad de su cotización: ya no se sostiene la lectura de «ese
  > cierre puntual no lo tenía». **Esto pide tratarse como posible corrección (bug), no como
  > ajuste** — no espera al viernes. Lo que falta es una sola cosa: confirmar en el código que
  > la rama de `TIME_STOP` no pasa por donde se sellan esos dos campos. **No lo toqué**
  > (implementar no es mío). Queda escalado.

  > **Actualización 2026-08-26 — confirmado en el código. Ya no es hipótesis.**
  > Van **4 de 4, `todos: true`**, tercer día seguido (1/1 → 2/2 → 4/4). Y la causa está a la
  > vista: los dos campos se escriben en `server.js:9127-9128` y `9820-9821` (los otros dos
  > monitores) y en `11526-11527` para el cierre manual. La rama de `TIME_STOP` de la Reversión
  > (`server.js:11172`) **no pasa por ninguna de las tres** — decide por conteo de velas y
  > precio del SPX, y las cotizaciones de las patas las pide después, solo para el colchón de
  > precio, sin sellar la trazabilidad. No es casualidad de muestra: es el camino.
  >
  > **Dos salidas posibles, y la elección no es mía:**
  > 1. Escribir los campos en esa rama con la fuente/edad del **spot** que sí se usó para
  >    decidir (`precioSPXFresco`), que es la trazabilidad que de verdad falta ahí.
  > 2. Aceptar que para `TIME_STOP` esos campos no aplican (no hay cotización de patas en la
  >    decisión) y que **el motor deje de contarlos como faltantes** para ese motivo.
  >
  > La primera arregla el dato; la segunda arregla el reporte. Hacer ninguna deja el hallazgo
  > repitiéndose todos los días sin significar nada. **Pregunta de sí o no: ¿1 o 2?**

- **El gate de Crédito/Riesgo no deja rastro en el embudo** (nuevo, 2026-08-26). Hoy mató 14 de
  16 señales de TENDENCIA y no figura como etapa: se aplica después de `SIGNAL_BUILT`, así que
  el embudo reporta esas 14 como señales construidas. No es un error de decisión —el gate hizo
  lo correcto— sino que **la última etapa del embudo no significa lo que parece**. ¿Se agrega
  una etapa al log para los descartes posteriores a `SIGNAL_BUILT`, o se deja y se documenta?

- **`smaReversion.earlyExitPct` está en 0.6** y el usuario lo había subido explícitamente a
  **0.9** el 2026-08-02. Apareció en 0.6 el 2026-08-13 junto con el `minScore` en 0, que sí se
  confirmó como config corrupta y se restauró. Este quedó sin decidir: ¿se devuelve a 0.9 o se
  deja en 0.6? Ver la sección "Config de producción a la deriva" en CLAUDE.md.

---

## Aplicadas

### El piso de crédito y el límite de precio, desacoplados · **2026-08-13**

Era la sugerencia 2. **Se resolvió el mismo día en que se anotó**, y el backlog la arrastró
nueve días como pendiente — con el Auditor devolviendo `SIN INSTRUMENTO` por ella cada vez
que corría. Queda anotado para que la próxima se cierre al aplicarla.

`limiteDeAperturaVertical()` calcula el límite desde la **prima estimada**
(`prem * (1 − tolerancia/100)` en crédito). `minCreditoAnchoPct` quedó como lo que es —el
gate de **entrada**— y sigue en 0 a propósito por el modo captura. Son dos decisiones
distintas, y mezclarlas ataba el precio de ejecución a un parámetro de estrategia.

**Verificado el 2026-08-22** con `scripts/sombra_credito.py`, que compara por apertura el mid
de la cadena real, el precio de cruzar el spread, el límite calculado y el fill real:

| día | mid | cruzando | límite | fill | vs límite |
|---|---|---|---|---|---|
| 14-ago | $65 | $50 | $49 | $55 | **+6** |
| 13-ago | $65 | $55 | $49 | $50 | **+1** |

**Ningún fill por debajo del límite.** Mediana contra el precio de cruzar: **$0** — se está
cobrando lo que da tomar el mercado, que es lo esperable y sano. Con 2 casos no es una
muestra; el Auditor lo dice así y lo sigue vigilando como su paso 4.

⚠️ **Ojo con la tolerancia.** `toleranciaDeslizamientoPct` está en **100** en producción. Hasta
el 2026-08-20 eso mandaba la orden **a mercado sin decirlo**; desde ese arreglo un valor fuera
de rango cae al 25 documentado en vez de desactivar la protección. El canario todavía lo
describe como *«orden a mercado, deliberado 16-ago»* — **ese comentario quedó viejo** y
conviene corregirlo antes de que alguien decida sobre él.


### Reversión — el stop se valida en 5m, no en 2m · **2026-08-05**

Entró **fuera de la cadencia viernes/sábado** por decisión explícita del usuario: no era un
ajuste sino una desviación del diseño ya validado la semana anterior ("5 minutos decide, 2
minutos afina" — el 2m nunca decide el setup, y el stop es una decisión de setup). Mantenerlo
en 2m costaba los trades de lo que quedaba de semana.

Medido: el rango mediano de una vela de 2m (4,58 pts) es igual a la excursión adversa mediana
del propio hold (4,70 pts) — el stop estaba dentro del ruido. Con 5m, la réplica de los 69
trades lleva los cierres por objetivo de 20% a 36% y los stops de 78% a 59%.

**A vigilar, no está demostrado:** que mejore la plata. Un stop 1,66x más ancho da pérdidas
más grandes; si la pérdida media crece en la misma proporción, la mejora del win rate se
cancela exacto. **La variable a seguir es la pérdida media, hoy en $39.** Cada ejecución nueva
graba `stopTimeframe` para poder separar las muestras.
