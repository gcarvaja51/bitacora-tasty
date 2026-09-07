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

### 5. El veto de muro no mira el muro que queda a la espalda — DIRECCIONAL, impacto ALTO

**Anotado:** 2026-09-01 · **Evidencia:** informe del trade `tex-1788275797593`
(`analisis tradier/09012026_BEAR_PUT_SPREAD_perdedor185.pdf`)

El Bear Put Spread 7645/7635 del 1-sep entró con **score 100/100** —los cinco checks del
playbook en verde, los tres Mundos alineados en bajista, Lower-High confirmado (7696,33 →
7661,69), MACD 15m en descenso, GEX y DEX negativos— y perdió **$185** en 25 minutos sin
estar a favor **ni un solo tick** (el trail sombra registró un pico de −8,3 pts).

Lo que lo explica no está en el score: se entró corto en 7646,34 con el **Call Wall en
7650, a 3,7 puntos por encima**, y con el precio ya rebotando desde el mínimo de 7643 de
las 11:06. El rebote contra ese muro se comió el trade.

`vetoMuroSombra` sí corrió y **no vetó** — correctamente, según cómo está escrito: midió los
21,34 pts de aire hasta el **Put Wall (7625)**, que es el muro del lado del **objetivo**,
contra los 6,27 pts que exigía el TP. Nunca miró el muro que quedaba **a la espalda**, que
era el que iba a frenar el movimiento antes de que empezara.

**La propuesta:** que el veto mire los dos muros — el del objetivo (¿hay recorrido hasta el
TP?) y el de la espalda (¿hay espacio para que el precio se aleje, o entramos pegados a la
pared que lo va a devolver?). El umbral de "pegado" hay que medirlo, no inventarlo: el
candidato natural es el ATR de 2m (aquí 2,69 pts, o sea que 3,7 pts es **1,4 ATR** — dentro
del ruido de una sola vela).

**Para el Auditor, antes de aplicar nada:** correr en sombra sobre el histórico qué habría
pasado vetando las entradas con el muro contrario a menos de N×ATR. Hace falta saber las dos
caras — cuántas pérdidas evita y cuántos ganadores mata. Con un solo trade no se decide;
esto es una hipótesis con una autopsia detrás, no un hallazgo.

**Ojo con no sobreajustar a este trade.** Es un caso, en un día de GEX negativo, con score
perfecto. Que la explicación sea convincente no la hace cierta.

---

### 6. El listón tras pérdida no mira el tamaño de la pérdida — DIRECCIONAL, impacto ALTO

**Anotado:** 2026-09-03 (revisión semanal del jueves) · **Evidencia:** 3.099 evaluaciones,
28-ago a 3-sep · **Código:** `minScoreEfectivoDireccional`, `server.js:6336`

`minScoreTrasPerdida: 90` es **binario**: `if (ultimo.pnl < 0)`. Cualquier pérdida, del
tamaño que sea, sube el listón de 80 a 90 para el resto del día.

**El número de la semana.** De los 203 `SCORE_FAIL` de TENDENCIA, **69 fueron por el listón
elevado tras pérdida** (los otros 129 son el listón normal de 80 y 5 son la escalera de
impulsos). De esos 69:

| | |
|---|---|
| Score 80 | 38 |
| Score 85 | 31 |
| Score < 80 | **0** |

**69 de 69 habrían pasado el listón normal.** El listón elevado hizo el 100% del bloqueo —
no son señales marginales que igual habrían muerto.

Disparó en **2 de las 5 sesiones** de la semana, y en las dos cerró la ventana entera:

| Día | Pérdida que lo disparó | Evals bloqueadas | Ventana ET | `SIGNAL_BUILT` después |
|---|---|---|---|---|
| 2026-09-01 | **−$10** | 45 | 11:59 → 13:59 | **0** |
| 2026-09-02 | −$125 | 24 | 12:55 → 13:59 | **0** |

El 1-sep una pérdida de **diez dólares** apagó las dos últimas horas útiles del direccional.
El 2-sep una de $125 hizo exactamente lo mismo. **La respuesta del sistema es idéntica ante
$10 y ante $125**, y el patrón se repite hacia atrás con otros tamaños: −$60 (3 casos a 80),
−$45 (9 a 75), −$245 (22 a 85).

**El eje de la propuesta es el umbral de magnitud, no el valor 90.** La regla existe por un
motivo bueno y documentado (*«los 4 trades de un día no son 4 apuestas independientes — si el
marco de 15m está mal leído, los 4 heredan el mismo error»*, `server.js:4543`). Lo que la
semana expone es que **una pérdida de $10 no es evidencia de que el marco esté mal leído**:
está dentro del ruido del cruce del spread. Propuesta: que el listón suba solo cuando la
pérdida supere un piso —`minScoreTrasPerdidaMinUsd`— y que el piso lo fije el Auditor con la
muestra, no yo con la intuición.

**Qué se espera que cambie, en magnitud:** devuelve al gate de score hasta 69 evaluaciones
por semana. ⚠️ **Evaluaciones no son oportunidades**: son 2 colas de sesión, o sea del orden
de **1 a 3 trades reales por semana**, no 69. Quien lea esto esperando un salto de volumen se
va a decepcionar; el efecto real es dejar de apagar el día por un scratch.

**Qué podría moverse sin querer:** (a) se reexpone el riesgo correlacionado que la regla fue
puesta a cubrir — si el 15m está mal leído, los trades siguientes heredan el error, y esta es
justo la familia con la propuesta 1 abierta por ese mismo motivo; (b) interactúa con la
escalera de impulsos, que también sube a 90 y donde *manda el más alto* — bajar este listón
no baja aquel, pero cambia cuál de los dos manda en los días que disparan los dos.

**Instrumento: no existe, y construirlo es parte de la propuesta.** Las 69 evaluaciones
murieron en `SCORE_FAIL`, **antes** de `SIGNAL_BUILT`: no tienen strikes, ni prima, ni
resultado. No hay nada que valorar hacia atrás. Lo que sí se puede construir con trades
reales ya cerrados es el test de la **premisa**: partir las TENDENCIA cerradas según si
venían después de una pérdida del mismo día, y según el tamaño de esa pérdida. Si los trades
posteriores a una pérdida **no** rinden peor, el problema no es el umbral de magnitud sino la
regla entera. Declarada como `DIR-3` en `scripts/veredicto_sombra.py` con `instrumento: None`.

⚠️ **Es la tercera propuesta ALTO abierta sobre DIRECCIONAL** (con la 1 y la 4). Solo se
puede aplicar una por ventana, o no se sabrá cuál funcionó.

---

## Anotaciones diarias — sin propuesta todavía (lun–jue se anota)

### 2026-09-03 (bis) · revisión SEMANAL del jueves, 28-ago a 3-sep

3.099 evaluaciones contra 1.901 la semana previa (**+63%**). Todo lo que sigue está
normalizado por ese crecimiento: en crudo casi cualquier puerta «subió».

**Una sola propuesta esta semana** (la nº 6, DIRECCIONAL). REVERSION y NEUTRAL **no reciben
propuesta**, y el motivo está abajo — en las dos hay números, pero ninguno es limpio.

---

**a) REVERSION — por qué NO se propone.** Había dos candidatas y las dos se caen:

- **`NO_STRIKES` con delta 0.5 pasó de 3 a 45** (×15, contra ×1,6 de las evaluaciones). De
  los 112 intentos que pasaron el score, **40% murió sin strike**. Pero la semana tuvo **56
  órdenes rechazadas** por el sandbox, y el log no distingue *«no hay strike en la tolerancia»*
  de *«la cadena vino vacía»* — son la misma rama de código. Hay horas que apuntan a que no
  es solo el broker (28-ago 11h: 7 `NO_STRIKES` y 0 rechazos; 3-sep 11h: 6 y 0), pero
  **15 de 45 no alcanzan para separarlo**, y la mitad del fenómeno es de la Torre. Proponer
  ensanchar el delta sobre este número sería proponer sobre un confundido.
- **El `minScore` efectivo no es el declarado** — ver defecto (d). Es una **deriva de config**,
  no un ajuste: no se propone, se pregunta.

**b) NEUTRAL — por qué NO se propone.** **2 señales en la semana** (n=2, no concluye nada). Y
el `GATE_FAIL` está dominado por **«Gamma régimen NEGATIVO» 79 de 120** (66%, contra 32% la
semana previa): eso es **régimen de mercado, no calibración**. Además el gate de GEX del 1DTE
es la única condición que el usuario dejó viva a propósito en MODO CAPTURA. No hay nada que
proponer que no contradiga una decisión explícita.

**c) Lo que sí mejoró, para que no se pierda.** `SIN_ALEJAMIENTO` bajó de **85,8% a 65,0%**
del embudo de REVERSION, y `SIGNAL_BUILT` subió de 6 a 67. La banda de 0.10 está dejando
pasar el setup: es la propuesta 2 funcionando. Y `NO_PULLBACK_2M` de TENDENCIA se mantuvo
clavado en **80,4% vs 80,7%** — esa puerta no se movió, el crecimiento fue del denominador.

---

#### Tres defectos a escalar — son bugs, no ajustes (no esperan al viernes)

**d) `regimen_gex` pesa 0 en producción, y eso anula una decisión explícita del usuario.**
La config de producción (`GET /api/spx/config`) trae `regimen_gex: 0`. CLAUDE.md § Reversión
dice: *«GEX negativo hace fallar el check `regimen_gex` (resta su 10%) pero no anula la
entrada — decisión explícita: que le baje puntos pero que no anule la entrada»*. Con peso 0
**no anula la entrada, pero tampoco le baja puntos**: el GEX no tiene ni voz ni voto en
REVERSION. La decisión del usuario no se está ejecutando en ninguna de sus dos mitades.

**e) La config declarada, la local y la de producción son tres cosas distintas.**

| | CLAUDE.md `parametros-vigentes-reversion` | `spx_config.json` local | **Producción** |
|---|---|---|---|
| `minScore` | 75 | 75 | **72** |
| `alejamiento_sma8` | (no declarado) | 45 | **55** |
| `regimen_gex` | (no declarado) | 10 | **0** |

El umbral efectivo se calcula `(minScore − pesoEnPuertas) / canasta × 100`. Con lo declarado
da **54,5%**; con producción da **37,8%** — y **101 de 101** `SCORE_FAIL` de REVERSION de la
semana citan 37,8%. La aritmética del reescalado es correcta y está bien documentada
(`src/spx_indicators.js:669`); lo que no cuadra es de dónde salieron 72/55/0. **La brecha
real del listón es de 16,7 puntos porcentuales, no de los 3 que sugiere comparar 75 con 72.**

**f) El canario vigila `minScore` pero no los `weights`, y el umbral depende de los dos.**
`VIGILADOS` en `scripts/deriva.py:110` no incluye los pesos. Por eso (d) y (e) llevan
quién sabe cuánto sin que nadie los viera: un cambio de peso mueve el listón efectivo **en
silencio**, y el chequeo de deriva sigue en verde. Es el mismo accidente que el propio
comentario del código dice haber cometido ya dos veces (*«el umbral y los pesos se tocan en
sitios distintos y nadie los compara»*). **La corrección es del instrumento, no del trading.**

**g) Los cierres por nivel de precio no registran con qué precio se cerraron.**
`edadCotizacionTPSLSeg` y `fuenteCotizacionTPSL` faltan en **11 de 11** `TIME_STOP`, **3 de 3**
`PRECIO_OBJETIVO` y **1 de 1** `CIERRE_1DTE_HORA_TOPE` — el 100% en los tres motivos. **No es
legado: son 9 esta semana** (28-ago, 1-sep y 3-sep) y **33 en todo el libro**, todos REVERSION
salvo el 1DTE. Importa por lo que CLAUDE.md ya advierte: *«Sin precio fiable los monitores NO
actúan — Reversión queda sin ninguna salida automática»*. Hoy **no se puede auditar si una
salida de Reversión disparó sobre un spot viejo**, que es exactamente el modo de falla
señalado como el peligroso. No afirmo que haya pasado: afirmo que el instrumento no permite
saberlo.

---

#### Calidad del dato — lo que está bien, dicho con número

- **Frescura del spot: sana.** Mediana **16s**, p90 34s, máximo 171s. Solo **7 de 1.367**
  decisiones (0,5%) con precio de más de 120s. Sigma n=1.135 mediana 19s, Yahoo n=232 mediana
  2,0s: la primaria es ~9× más vieja que el respaldo, pero es **la cadencia del daemon (2 min),
  no un defecto** — y sigue muy por debajo del `MAX_EDAD_SIGMA_SPOT_SEG` de 180.
- **Los sellos están sanos, y el parte engaña.** El motor reporta «127 de 220 sin sello», pero
  el desglose por mes es: julio **123 sin sello** (antes de que `algoVersion` existiera), agosto
  4, septiembre 0. **En los últimos 7 días: 21 ejecuciones, 0 sin sello.** Es deuda histórica
  congelada, no un defecto vivo. ⚠️ **El chequeo de sellos no está acotado a la ventana** como
  el resto del parte, así que va a pintar ámbar para siempre y a costo de que se deje de leer.
  Acotarlo a la ventana es corrección del motor.
- **Los 4 cierres «sin libro propio» se explican:** 3 son `MANUAL_FORZADO` (cerrados a mano,
  fuera de los monitores — por definición no hay libro) y 1 es un TP del 26-ago. Todos previos
  al 28-ago. **Ninguno esta semana.**

### 2026-09-04 · corrida diaria, 657 evaluaciones

**a) El defecto escalado ayer sigue vivo, y hoy fue el día en que más costaba tenerlo.**
`GET /api/spx/config` de producción, leído hoy, sigue trayendo `weights.regimen_gex: 0`,
`minScore: 72` y `weights.alejamiento_sma8: 55`. Nada se movió desde la escalada del 03-sep.

Hoy se pudo cerrar la aritmética al decimal, que ayer quedó estimada. Con los pesos de
producción y `alejamientoEsPuerta: true`:

| | |
|---|---|
| `pesoEnPuertas` | 55 (alejamiento, sale del score por ser puerta) |
| `totalWeight` | 20 patrón + 0 rsi + 10 fase + 0 gex + 15 compás = **45** |
| listón efectivo | (72 − 55) / 45 × 100 = **37,8%** |

Cuadra exacto con los **15 de 15** `SCORE_FAIL` de REVERSION del día, que citan «mínimo
37.8%». El reescalado funciona como está documentado; lo que está mal son los insumos.

**El score de REVERSION corre hoy sobre tres checks vivos, no seis.** `rsi` y `regimen_gex`
pesan 0: no vetan y no puntúan. Quedan patrón (20), fase Weinstein 5m (10) y compás (15), y
hacen falta 17 de 45 puntos — o sea que **el patrón de confirmación solo alcanza, y fase +
compás juntos también, pero ninguno de los dos por separado**. Los 15 fallos del día dieron
**0% exacto**: los tres checks fallaron a la vez. No es un fallo por poco, es un setup sin
una sola pata de evidencia.

⚠️ **Y el gamma sí tenía algo que decir hoy.** El GEX volvió a negativo después de la única
sesión limpia de la semana: «Gamma régimen NEGATIVO» fue **20 de 29** `GATE_FAIL` de NEUTRAL,
contra **0 de 39 ayer**. Serie completa: 22 (vie 28) → 37 (lun 31) → 34 (mar 01) → 4 (mié 02)
→ 0 (jue 03) → **20 (vie 04)**. Encima el precio pasó parte de la sesión pegado al Gamma Flip
(7728,05 vs 7723 y 7727,11 vs 7724, ambos dentro del buffer de 10 pts). En un día así el
check `regimen_gex` debía estar restando su 0,5 del peso a cada entrada de Reversión —
la decisión explícita del usuario es *«que le baje puntos pero que no anule la entrada»*— y
restó **nada**, porque su peso es 0. NEUTRAL, en cambio, sí quedó apagada por el mismo GEX:
0 señales construidas.

**b) El canario confirma por qué esto salió por casualidad y no por chequeo.**
`ESPERADO_REVERSION` (en `chequeo_salud_estrategias.py`, leído vía `scripts/deriva.py`)
vigila exactamente 8 parámetros: `targetDelta`, `spreadWidth`, `stopMinPts`, `earlyExitPct`,
`alejamientoEsPuerta`, `requiereGammaPositivo`, `extBandMinPct`, `extBandMaxPct`. **Ni
`minScore` ni los `weights` están en la lista** — y son justo los dos que determinan el listón
efectivo. Los 4 que sí vigila coinciden con producción sin excepción. El canario no falló:
está mirando a otro lado.

**c) Las evaluaciones se recuperaron, pero el `SCORE_FAIL` de TENDENCIA cambió de
naturaleza.** 652 (mié) → 354 (jue, cupo de posición ocupado) → **657 hoy**: el cupo se
liberó y la familia volvió a evaluar normal. Pero `SCORE_FAIL` casi se dobló contra el
miércoles (24 → **41**), y no es el mismo fenómeno:

| | mié 02-sep | vie 04-sep |
|---|---|---|
| bloqueados por el listón subido a 90 tras pérdida previa | **22 de 24** (todos con score 85) | **14 de 41** (score 55) |
| bloqueados por el listón normal de 80 | 2 | **26** (scores 70 y 60) |

El miércoles el binding constraint era la regla de escalamiento por pérdida: 22 señales de
**85%** que habrían pasado el 80 normal. Hoy la mayoría son señales genuinamente flojas
(70%, 60%) contra el listón sin subir. Son dos causas distintas con el mismo nombre en el
log, y promediarlas en cualquier lectura semanal de «qué tan duro está el score» las mezcla.

**d) Día de fuente única para el spot: 251 de 251 lecturas desde Sigma, 0 de Yahoo.** La
frescura fue la mejor de la semana —mediana 20s, p90 35s, máx 97s, **0 sobre el umbral de
120s**, contra 4 el miércoles y 7 en la semana— pero conviene anotar la otra cara: el diseño
de `precioSPXFresco()` se apoya en que las fuentes se contradigan entre sí, y hoy no hubo
ninguna segunda fuente. Frescura no es exactitud: si Sigma hubiera derivado, nada lo habría
señalado. El miércoles la mezcla fue Yahoo 218 / Sigma 88. **Observación, no defecto** — no
hay ningún indicio de que Sigma haya estado mal hoy.

**e) `edadCotizacionTPSLSeg` y `fuenteCotizacionTPSL`: confirmado que es estructural, y por
qué importa igual.** Faltan en el 100% de `TIME_STOP` (14/14), `PRECIO_OBJETIVO` (4/4) y
`CIERRE_1DTE_HORA_TOPE` (1/1). Verificado en código: los únicos que escriben esos dos campos
son `checkIronCondorTPSLImpl` (`server.js:9376`) y `checkDirectionalTPSLImpl`
(`server.js:10069`). `checkAlejamientoSMATPSL` **no los escribe nunca**, y es correcto que no
lo haga: cierra por nivel de precio del SPX, no cotizando las patas, así que no hay
cotización cuya edad registrar. No es una escritura perdida.

Pero el efecto sobre la auditoría queda igual: **esas 18 salidas de Reversión no tienen
registrada la procedencia del spot que las disparó**, y CLAUDE.md advierte explícitamente que
sin precio fiable ese monitor se queda sin TP, sin SL y sin time-stop. Hoy la frescura global
fue impecable, así que no hay motivo para sospechar de ninguna — pero el día que la haya, no
hay con qué verificarlo. Lo que falta no es el campo de cotización sino **el equivalente para
un cierre por nivel**: fuente y edad del spot que gatilló. Y siguen creciendo (`TIME_STOP`
10 → 11 → 14).

**f) Sin novedad, ya explicado el 03-sep:** los 127 «sin sello» siguen clavados en 127
mientras el denominador subió 215 → 220 → **228** — los 13 cierres nuevos salieron todos
sellados, es deuda de julio congelada. Y los 4 «sin libro propio» son **los mismos 4 ids**
por tercer día. Ambos chequeos siguen sin acotarse a la ventana y siguen pintando ámbar.

### 2026-09-03 · corrida diaria, 354 evaluaciones

**a) El hallazgo del día: las evaluaciones cayeron 46% (652 → 354) y no fue porque ningún
filtro se pusiera más duro — fue porque el cupo compartido de posición SPXW estuvo ocupado
casi toda la sesión.** Reconstruido minuto a minuto, sin huecos:

| tramo ET | quién tenía el cupo | a quién dejó afuera |
|---|---|---|
| 09:45–10:30 | el **IC 1DTE de ayer** (`38156221`), cerrado a las 10:30 por `CIERRE_1DTE_HORA_TOPE` | TENDENCIA — su primer evento del día es a las **10:30**, 45 min después de abrir su ventana |
| 10:33–11:04 | direccional #1 (Bull Call 7715/7705) | NEUTRAL (`POSITION_OPEN` 10:03–11:03) |
| 11:19–11:39 | REVERSION, en su cupo propio | — (18 `POSITION_OPEN` de sí misma) |
| 11:40–13:49 | direccional #2 (Bull Call 7750/7740) | NEUTRAL (`POSITION_OPEN` 11:43–12:58) y la propia TENDENCIA |

El hueco de TENDENCIA entre **11:40:53 y 13:49:26 son 129 minutos corridos sin una sola
evaluación**, dentro de una ventana que cierra a las 14:00. Sumado a los 45 min del arranque,
la familia estuvo fuera de juego **2h54 de sus 4h15 de ventana**: 112 evaluaciones contra
**402 ayer y 490 el lunes**.

⚠️ **Y el costo se cobró justo el día en que el régimen por fin acompañaba.** NEUTRAL llevaba
cuatro sesiones apagada por «Gamma régimen NEGATIVO» (22 el vie → 37 el lun → 34 el mar → 4 el
mié) y **hoy ese motivo fue 0 de 39**: el GEX giró a positivo. El Iron Condor 0DTE tuvo su
régimen por primera vez en una semana y **29 de sus 39 evaluaciones murieron en
`POSITION_OPEN`**; solo 7 ciclos (11:09–11:39) llegaron a evaluar su propio gate, y ahí falló
el PIN (precio a 10.6–16.6 pts del muro, tope 5; rango de 30 min 42.8 pts, tope 10).

Este es el eje de la eventual propuesta del jueves, y es **nuevo**: no es un umbral mal
calibrado, es que **cuatro estrategias comparten un cupo que el broker no sabe separar por
familia**, y el 1DTE lo hereda ocupado desde la noche anterior. REVERSION ya tiene cupo propio
por decisión explícita; la pregunta abierta es si NEUTRAL debería tener el suyo, o si el 1DTE
heredado debería dejar de contar como bloqueo para el 0DTE. **No se propone hoy** — hace falta
ver si el patrón se repite, porque un solo día con dos direccionales largos puede ser
casualidad.

**b) El broker se comió las dos mejores señales de REVERSION del día.** 8 `SIGNAL_BUILT`
emparejados **uno a uno, en el mismo segundo**, con 8 `ORDEN_RECHAZADA` (HTTP 500), todos
entre las **09:53:54 y las 10:13:50**. Lo que se perdió no fue ruido: entre esos 8 estaban
**dos intentos con score 96%** (`VELA_TIBURON_MARTILLO`, 10:10 y 10:11) y **dos con score
100%** (`VELA_9`, 10:12 y 10:13), todos el mismo Bull Put 7695/7685. Las dos señales que sí
sobrevivieron (11:19 y 11:34) traían **44.4%**.

Serie de rechazos, quinto día seguido: **1 (vie 28) → 5 (lun 31) → 26 (mar 01) → 16 (mié 02) →
8 (jue 03)**. Baja, pero sigue. La causa es de la Torre de Control y se le pasó sin
dictaminar. Lo mío: **la muestra de REVERSION está sesgada por arriba** — el broker no rechaza
al azar en el tiempo, rechaza en bloques, y hoy el bloque cayó encima de los scores más altos
de la sesión. Cualquier lectura de «qué score funciona» sobre estos días está midiendo la
disponibilidad de Tradier, no la señal.

**c) RESUELTO: el «37.8%» no era deriva.** El 01-sep y el 02-sep se anotó como sospechoso que
el log dijera *«mínimo 37.8%»* mientras la config decía 72 y el manual 75 — «tres números para
el mismo listón». **No lo son.** `calcReversionScore` (`src/spx_indicators.js:669`) reescala el
listón cuando hay puertas binarias, porque el peso que ya se consumió como puerta no puede
volver a exigirse en el score:

```js
minScore = (minScoreBase - pesoEnPuertas) / totalWeight * 100
```

37.8 es el **equivalente de 72 sobre la escala post-puertas**, no un umbral distinto. La
pregunta de sí o no de los dos días anteriores queda cerrada y se retira del pendiente. **Lo
que sí sigue vivo es la otra mitad**: producción tiene `smaReversion.minScore: 72` y el bloque
`parametros-vigentes-reversion` de CLAUDE.md declara **75**. El cotejo formal es del
Secretario; se anota acá porque es un umbral.

**d) También se cae la otra sospecha: el score de REVERSION sí evalúa.** El 02-sep se anotó
que un score «0% clavado, 15 veces, dos días idénticos» parecía un check muerto. Hoy la misma
función produjo **0%, 33.3%, 44.4%, 55.6%, 96% y 100%** en la misma sesión. El 0% era mercado,
no instrumento. Se retira la sospecha.

**e) TENDENCIA murió con el listón en 90 por tercer día seguido — y por tercer mecanismo
distinto.** Lunes fue *«el trade anterior cerró en −$10»* (45 evaluaciones), martes *«cerró en
−$125»* (24), y hoy los **5 `SCORE_FAIL` (13:51–13:53) fueron por `impulso 4 en 15m`** (umbral
10.64 pts), con score **65**. Este tercero es distinto en naturaleza: la escalera de impulsos
es una regla **calibrada con backtest propio** (impulso 3+ alcista exige 90), no un castigo
binario por una pérdida. Con score 65 no habría pasado ni el listón normal de 80, así que
**hoy el listón elevado no cambió el resultado** — se anota para que el jueves no se cuente
como un tercer caso a favor de la propuesta de «umbral de magnitud»: **no lo es.** Esa
propuesta sigue con sus dos casos (lunes y martes).

**f) El asesino ordinario de TENDENCIA volvió a ser el pullback, y hoy el precio estuvo lejos,
no cerca.** 86 `NO_PULLBACK_2M`. Las distancias a la EMA10 en el tramo largo de las 11
(11:06–11:39) van de **5.24 a 13.40 pts contra un tope de 3.75–4.12** — o sea entre 1.3× y
3.3× el tope. Ninguna de las tres razones más frecuentes fue «Marco 15m sin Fase 2 ni Fase 4»
(ayer eran 67): **hubo dirección toda la sesión, no hubo retroceso.** Segundo día en la misma
dirección de lectura que la sugerencia 4 del backlog (`maxATR` 0.8).

**g) `SIN_ALEJAMIENTO` bajó de 155 a 139 y sigue sin ser un problema de banda.** Los tres
valores más frecuentes fueron **−0.02%, 0% y 0.05%** (43 evaluaciones) contra un borde de
0.10%. Igual que ayer: no están rozando el listón, están un orden de magnitud abajo. **Sigue
sin servir como evidencia a favor de bajar la banda** (sugerencia 2).

**h) `NO_STRIKES` con delta 0.5 se estabilizó y hoy se despegó de la ventana de rechazos.**
REVERSION 14 (mar) → 9 (mié) → **10 (hoy)**. Pero a diferencia de los dos días anteriores,
hoy **solo 3 de los 10 caen en la franja de los rechazos** (09:55, 09:56, 10:08, 10:14); los
otros 6 están entre **11:14 y 11:33**, con el broker ya respondiendo bien. Eso **empieza a
separar** las dos hipótesis que el 01-sep no se podían distinguir: parece una falla propia de
la cadena en delta 0.5, no un subproducto del episodio del broker. Tercer día de serie; se
mira completo el jueves.

**i) Calidad del dato: el daemon se recuperó, y el contraste con ayer es la noticia.** Ayer
Sigma sirvió solo 88 de 306 lecturas y Yahoo gobernó 2h42; hoy **Sigma sirvió 206 de 207** y
Yahoo entró una sola vez. Frescura mediana **20s**, p90 **36s**, máximo **139s**, **1 sola
lectura sobre 120s** (0.5%). Es el perfil normal del daemon (empuje cada 2 min), y con Sigma
sirviendo todo el día **los muros y el GEX volvieron a moverse con el precio** — que era el
costo real del episodio de ayer, no el spot. ⚠️ Queda dicho, porque el manual lo pide: la
fuente primaria es **20× más vieja que la de respaldo** (Sigma 20s vs Yahoo 1s). Es cadencia,
no exactitud, y está aceptado a cambio de que el spot sea coherente con los muros.

**j) El hueco de instrumentación de cierres cumple una semana y hoy hay que afinarlo, porque
metí un caso que no corresponde.** `edadCotizacionTPSLSeg` y `fuenteCotizacionTPSL` siguen
faltando en **11/11 `TIME_STOP`** (10/10 ayer: **el cierre nuevo de hoy volvió a nacer sin
ellos**) y **3/3 `PRECIO_OBJETIVO`**. Escalado como posible corrección el 28-ago, el 01-sep y
el 02-sep; sigue sin arreglarse, cuarto escalamiento.

⚠️ **Pero el caso nuevo de hoy NO es parte del defecto.** El motor sumó
`CIERRE_1DTE_HORA_TOPE` (1/1) a la misma lista, y ese cierre dice literalmente en su propia
razón: *«cierre por tiempo, sin evaluacion de precio»*. No consultó ninguna cotización, así
que no tiene ninguna que registrar. **Es un falso positivo del chequeo de completitud**, no un
cierre sin instrumentar. Conviene que el motor lo exceptúe antes de que engorde el conteo y
haga ver el defecto más grande de lo que es.

**k) El sello sigue sano.** `sinSello` clavado en **127** con el denominador subiendo de 215 a
**220**: los 5 cierres nuevos entraron todos sellados. Sexto día igual — el «127 de 220» del
titular del parte es backlog histórico cerrado, no deuda que crezca.
`sinLibroDespuesDelCorte` sigue en los **mismos 4 ids** de siempre.

### 2026-09-02 · corrida diaria, 652 evaluaciones

**a) La fuente primaria del spot sirvió el 29% del día. Ayer servía el 96%.** yahoo **n=218**
(mediana 2.0s) contra sigma **n=88** (mediana 19.5s); ayer era sigma 291 / yahoo 13.
Reconstruido lectura por lectura, Sigma estuvo ausente **09:47–10:22**, **11:00–11:25** y
**11:35–13:42 corrido (2h07)** — en total ~2h42 de sesión gobernadas por el plan B. El
failover hizo su trabajo y la frescura **mejoró**: mediana **5.0s** (21.0 ayer), p90 **24s**
(38), 4 de 306 lecturas sobre 120s. Pero es un episodio **25 veces más largo** que el primero,
registrado apenas ayer (13 lecturas, 5 minutos). El máximo del día fue **171s**, a nueve
segundos del umbral de 180s con el que el propio sistema descarta la lectura.

El costo no está en el spot —Yahoo es más fresco— sino en que **los muros y el GEX viajan en
el mismo empuje del daemon**. Durante las ventanas de Yahoo, el trío (`callWall`, `putWall`,
`gammaFlip`) tomó **5 valores distintos en 218 lecturas**; en las de Sigma, **21 valores en
88**. Los muros estuvieron congelados mientras el precio corría.

**b) Los 39 registros de GEX NEGATIVO del día caen todos entre 09:47 y 10:18, y los 39 sobre
Yahoo. Ninguno mientras Sigma servía.** Desde que Sigma volvió a las 10:22, **88 de 88**
lecturas dijeron POSITIVO, y las 179 lecturas de Yahoo posteriores también. Consecuencia
medida: **los 4 bloqueos del Iron Condor por «Gamma régimen NEGATIVO» ocurrieron entre 10:01
y 10:16**, dentro de esa franja. Hipótesis —no hecho—: ese régimen negativo fue el cálculo
interno con su sesgo medido de ~−3.7B, no el mercado. **No se puede probar, porque no hay
ninguna lectura de Sigma en esa media hora contra la cual contrastar**, y eso es exactamente
el problema. Es el primer día en que la caída del daemon se puede atar a decisiones concretas.

**c) Segundo día seguido en que el listón por pérdida previa es el asesino principal de
TENDENCIA — y hoy se lee sin ruido.** Los **24 `SCORE_FAIL`** son **una hora corrida,
12:55–13:59**, el último tramo de la ventana que cierra a las 14:00. Los 24 traían score
**85** y en los 24 **el único check fallado fue `macd_cruce_pendiente` (peso 15)**:
`fase_weinstein` (45), `regimen_institucional` (10), `patrones_estructurales` (20) y
`ema_10_20_alineadas` (10) pasaron las 24 veces. Con el listón normal de 80, **las 24 pasaban
el gate de score**. Lo que lo subió a 90 fue el cierre en **−$125** de las 12:46 (22
evaluaciones lo citan literal; las otras 2 dicen «todavía no tiene P&L confirmado»).

Ayer el mismo mecanismo bloqueó **45** evaluaciones tras un cierre de **−$10**. Dos días, dos
pérdidas que difieren **12×**, el mismo castigo binario. El eje de la eventual propuesta del
jueves sigue siendo **umbral de magnitud**, no el valor 90 — y ya son dos casos con número.

**d) REVERSION: 16 señales, 16 rechazos, uno a uno, en 17 minutos (10:15–10:32). Cero
posiciones.** La familia no murió en ningún filtro propio, murió en el broker. Serie:
**1 (vie) → 5 (lun) → 26 (mar) → 16 (hoy)**, cuarto día. Mientras dure, **lo que se está
midiendo de REVERSION es la disponibilidad de Tradier, no la señal**. La causa es de la Torre
de Control; se le pasó sin dictaminar.

**e) `SIN_ALEJAMIENTO` creció 42% (109 → 155) y NO es un problema de calibración de la
banda.** Los tres alejamientos más frecuentes fueron **−0.02%, 0.02% y −0.03%** — 54
evaluaciones. El borde de la banda está en **0.10%**: estos números están a **un orden de
magnitud** del listón, no rozándolo. Fue una sesión pegada a la SMA8. ⚠️ **Es lo contrario del
caso que motivó la sugerencia 2 del backlog**, donde el setup moría por centésimas (−0.09% a
−0.12%, justo debajo del borde). Se anota explícitamente para que el jueves **nadie use el
número de hoy como evidencia a favor de bajar la banda**: no lo es.

**f) El `SCORE_FAIL` de REVERSION vuelve a dar 0% clavado, 15 veces, segundo día idéntico.**
«Score insuficiente: 0% (mínimo 37.8%)», entre 10:01 y 10:46 — **15 exactas ayer y 15 hoy,
todas con score cero absoluto**. Un score que da 0 dos días seguidos parece un check que no
evalúa, no un mercado malo. Y el listón que reporta el log (**37.8%**) sigue sin coincidir con
el `minScore` de la config (**72** medido ayer) ni con el manual (**75**). Tres números para
el mismo listón. Queda como pregunta de sí o no, no se dictamina.

**g) El filtro de dirección de 15m hoy estuvo cerrado, no atrasado — que es su modo de falla
benigno.** «Marco 15m sin Fase 2 ni Fase 4» **× 67**, concentrado en los primeros 75 minutos
(26 en la hora de las 9, 40 en la de las 10, 1 suelto a las 13:36). Se abstuvo en vez de
sostener una dirección vieja, que es justo lo contrario del 2026-08-05 que motivó la
sugerencia 1. No le agrega ni le quita nada a esa sugerencia.

**h) Primer caso registrado del veto de muro con el precio ya PASADO el muro, en alcista.**
Los 14 `VETO_MURO_SOMBRA` son **co-registros de los 14 `SIGNAL_BUILT`**, no muertes aparte —
importante para no leer mal el embudo. De esos, **5 evaluaciones BULLISH entre 11:37 y 12:04
tenían el precio por encima del Call Wall 7675**, con `aire` en **−3.33, −2.13, −0.20, −0.80
y −0.14 puntos**, y las 5 registraron `vetaria: false` porque el veto solo marca en BEARISH.
Entre 12:42 y 12:46 se dispararon **4 SL seguidos**. **No se afirma que una cosa causara la
otra**: un día no lo prueba, y la asimetría del veto está sostenida por su propio backtest
(los 4 trades abiertos pasado el Call Wall ganaron los 4). Se anota porque es el primer
registro con `aire` negativo del lado alcista, y es exactamente el material que la sugerencia
5 del backlog necesita para dejar de ser una corazonada.

**i) `NO_STRIKES` bajó, pero se corrió de familia.** REVERSION **14 → 9** (delta 0.5,
10:26–10:45); TENDENCIA **0 → 6** (delta 0.3, 10:40–11:36). Los dos tramos caen en la misma
franja de la mañana que los 18 rechazos del broker. Con un día no se puede separar «cadena
degradada» de «no había strike», igual que ayer. Se vigila con la serie de la semana.

**j) El sello sigue sano; el hueco de instrumentación de cierres sigue abierto y ya lleva dos
escalamientos.** `sinSello` clavado en **127** con el denominador subiendo de 212 a **215**:
los 3 cierres nuevos entraron sellados. Cuarto día igual — el «127 de 215» es backlog
histórico cerrado, no deuda que crece. `sinLibroDespuesDelCorte` sigue en los **mismos 4 ids**
sin moverse. En cambio `edadCotizacionTPSLSeg`/`fuenteCotizacionTPSL` siguen faltando en
**10/10 TIME_STOP** y **3/3 PRECIO_OBJETIVO** (hoy no sumó casos nuevos porque no hubo cierres
nuevos de REVERSION), y aparece **el mismo hueco desde el otro lado**: los **7
`CIERRE_DISPARADO` de TENDENCIA de hoy escribieron `cotFuente` y `cotEdadSeg` en `null`**, los
dos campos, en los 7. Escalado como posible corrección el 28-ago y el 01-sep; sigue sin
arreglarse y ahora se ve en dos familias.

### 2026-09-01 · corrida diaria, 749 evaluaciones

**a) Una pérdida de $10 apagó TENDENCIA por dos horas.** Es el hallazgo del día y el candidato
más claro a propuesta del jueves. Secuencia completa, sin huecos: a las **11:16** entró el
único trade direccional de la jornada (Bear Put 7635/7645, «auto-ejecutada en Tradier»); a las
**11:38–11:41** el monitor disparó el SL y el registro cerró en **−$10** (`ordenes_reales`,
`tex-1788275797593`). Desde las **11:59 y hasta las 13:59** —las dos horas útiles que quedaban
de ventana— **45 evaluaciones murieron contra el listón elevado**, todas con la misma razón
literal: *«el trade anterior de hoy cerró en $-10 — se exige 90%»*. **38 traían score 80 y 7
traían 85**: con el listón normal de 80, las 38 habrían pasado el gate de score.

El filtro hizo exactamente lo que está escrito — `minScoreTrasPerdida: 90` es **binario**, no
mira la magnitud. Lo que la sesión expone es que **una pérdida de diez dólares pesa igual que
una de quinientos**, y que en una familia cuya masa de scores se apila en 80–85 el salto de 80
a 90 no encarece la entrada: la cierra. **No se propone nada hoy**; el número queda anotado
para el jueves y el eje de la eventual propuesta es *umbral de magnitud*, no el valor 90.

⚠️ Dato al margen, para que el jueves nadie lo confunda: los tres `CIERRE_DISPARADO` del SL
registraron *«P&L estimado $-177.50 / $-182.50»* y el resultado grabado fue **−$10**. La
brecha estimado-vs-real **es del Contador**, no mía; se anota solo porque el freno se alimenta
del número real y conviene tener claro cuál de los dos gobierna antes de tocar el umbral.

**b) REVERSION fue la única familia que produjo, y el broker se comió el 90% de lo que
produjo.** **29 `SIGNAL_BUILT` y 26 `ORDEN_RECHAZADA`**, todos HTTP 500, entre las **09:57 y
las 11:11**, con **21 de los 26 concentrados en la hora de las 10**. Sobrevivieron tres
posiciones, y **las tres cerraron por `TIME_STOP`** (−$180, −$255, −$115): ninguna llegó al
objetivo ni a la invalidación de nivel. La causa del rechazo **es de la Torre de Control**, se
le pasó sin dictaminar. Lo que sí es mío: la escalada del embudo — **1 rechazo el viernes, 5
el lunes, 26 hoy**. Mientras dure, la señal de REVERSION no se puede medir: lo que se está
midiendo es la disponibilidad del broker.

**c) `NO_STRIKES` con delta 0.5 se cuadruplicó: 3 el lunes → 14 hoy**, todos entre 09:57 y
11:51 y todos con la misma razón (*«No se encontraron strikes con delta 0.5»*). Cae en la
misma ventana horaria que los rechazos, así que puede ser el mismo episodio de cadena
degradada visto por otra puerta — o puede ser independiente. **No alcanza para distinguirlo
con un día.** Se vigila el jueves con la serie de la semana.

**d) NEUTRAL lleva tres sesiones seguidas apagada por régimen, no por calibración.**
**34 de 34** por «Gamma régimen NEGATIVO» (37 de 37 el lunes, 22 el viernes). Hoy el
`gammaFlip` estuvo en **7704 con el precio en 7629**: 75 puntos por debajo, sin ninguna
chance de cruzar. El Iron Condor no está mal ajustado, está fuera de su régimen. Nada que
proponer mientras el GEX no gire.

**e) El asesino de TENDENCIA volvió a ser el pullback, y por primera vez en tres días no hubo
problema de dirección.** `NO_PULLBACK_2M` 408 (403 el lunes, 299 el viernes), pero **ninguna
de las tres razones más frecuentes fue «Marco 15m sin Fase 2 ni Fase 4»** — el lunes eran 12 y
el viernes 139. Hubo dirección toda la sesión; lo que no llegó fue el retroceso. Es la lectura
que conecta con la sugerencia 4 del backlog (`maxATR` 0.8), y la refuerza sin agregarle nada.

**f) Primer episodio registrado de failover del spot — y funcionó.** A las **10:00** una
lectura de Sigma llegó con **148s** de edad y sobre ella se construyó un `SIGNAL_BUILT` de
REVERSION (la orden la rechazó el broker, así que nunca fue posición). Inmediatamente después,
**de 10:01 a 10:06 el sistema cayó a Yahoo en 13 lecturas** (mediana **1s**) y volvió solo a
Sigma. O sea: Sigma cruzó los 180s, el plan B entró como está diseñado y ninguna decisión
quedó a ciegas. **Es la primera vez que se ve el mecanismo actuar en vivo.** El costo es que
la frescura del día se degradó: mediana **21.0s** (18.0 los dos días previos), p90 **38s**
(33/34), máximo **148s** contra 118/115, y **2 de 304 lecturas sobre 120s** — las primeras
desde que se vigila. Sigue siendo un hueco de **cadencia del daemon**, no de exactitud.

**g) El hueco de `fuenteCotizacionTPSL` dejó de ser histórico y sumó casos nuevos.** El 31-ago
se anotó que los conteos «no se movieron porque no hubo cierres nuevos». Hoy sí los hubo:
**`TIME_STOP` pasó de 7/7 a 10/10**, o sea **los tres cierres nuevos de REVERSION nacieron sin
`edadCotizacionTPSLSeg` ni `fuenteCotizacionTPSL`**. El contraste está dentro del mismo día:
el cierre de TENDENCIA (`SL`) trae `edadCotizacionTPSLSeg: 0` y `fuenteCotizacionTPSL: 'tasty'`.
Confirma sin margen lo escalado el 28-ago: el hueco es exclusivo de `checkAlejamientoSMATPSL` y
**sigue produciendo cierres sin instrumentar**. **Es posible corrección, no ajuste** — no
espera al viernes.

**h) Deriva entre lo declarado y lo que corre, en Reversión.** `GET /api/spx/config` devuelve
hoy `smaReversion.minScore: **72**`, y el bloque `parametros-vigentes-reversion` de CLAUDE.md
—el que existe justamente para que esto no pase— declara **75**. En el mismo objeto,
`weights.regimen_gex: **0**` mientras el manual describe que el GEX «resta su 10%», y
`weights.rsi: 0`. Los tres valores viajan sellados en la huella `024e6795` de los tres cierres
de hoy, así que **la muestra en curso está sellada contra los valores de producción, no contra
los del manual**. El cotejo formal doc-vs-producción es del **Secretario**; se anota acá
porque son umbrales y pesos, que sí son míos, y porque afecta cómo se lee cualquier propuesta
del jueves sobre esta familia.

**i) Menor, pero estorba para leer el embudo.** Los `SCORE_FAIL` de REVERSION se registran como
*«Score insuficiente: 0% (mínimo 37.8%)»* mientras la config dice `minScore: 72`. Dos números
distintos para el mismo listón en dos lugares distintos. No cambia ninguna decisión, pero
obliga a adivinar cuál gobierna cada vez que se lee el log. Queda como pregunta de sí o no.

**j) El sello sigue sano y el titular del parte sigue engañando.** `sinSello` clavado en **127**
mientras el denominador subió de **208 a 212**: **los 4 cierres nuevos de hoy entraron todos
sellados**, con `algoVersion` completo y `commit: c602800`. El «127 de 212» es backlog
histórico cerrado. `sinLibroDespuesDelCorte` sigue en los **mismos 4 ids** desde hace días, sin
crecer.

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

- ~~**¿Por qué el `minScore` de REVERSION cambia entre 37.8%, 54.5% y 75% en el log?**~~
  **CERRADA el 2026-09-03.** No era deriva ni corrupción: `calcReversionScore`
  (`src/spx_indicators.js:669`) reescala el listón cuando hay puertas binarias, con
  `minScore = (minScoreBase − pesoEnPuertas) / totalWeight × 100`. El número que imprime el log
  es el **equivalente del `minScore` de config sobre la escala post-puertas**, y cambia cuando
  cambia qué puertas se consumieron ese ciclo — por eso 37.8 / 54.5 / 75 en días distintos.
  Anotado como sospechoso el 24, 25, 26 y 28-ago y el 01 y 02-sep; **deja de contarse como
  hallazgo.** Lo que sí queda vivo, y es otra cosa, es que producción tiene
  `smaReversion.minScore: **72**` y `parametros-vigentes-reversion` de CLAUDE.md declara **75**.

- ~~**¿El score de REVERSION tiene un check muerto?**~~ **CERRADA el 2026-09-03.** Venía de dos
  días con «0% clavado, 15 veces» (01 y 02-sep). El 03-sep la misma función produjo **0%,
  33.3%, 44.4%, 55.6%, 96% y 100%** en una sola sesión. El 0% era mercado, no instrumento.

- **¿El motor debería exceptuar `CIERRE_1DTE_HORA_TOPE` del chequeo de `camposFaltantes`?**
  (nuevo, 2026-09-03). Hoy entró a la lista con 1/1 en `edadCotizacionTPSLSeg` y
  `fuenteCotizacionTPSL`, pero su propia razón dice *«cierre por tiempo, sin evaluacion de
  precio»*: no consulta cotización, así que no tiene ninguna que sellar. **Es un falso positivo
  del reporte**, no un cierre sin instrumentar, y si se deja va a engordar el conteo del hueco
  real de `TIME_STOP`/`PRECIO_OBJETIVO` hasta hacerlo ver más grande de lo que es. Es la misma
  disyuntiva de la pregunta de abajo, opción 2, aplicada a otro motivo. **Sí o no.**

- **¿NEUTRAL debería tener cupo propio de posición, como ya lo tiene REVERSION?** (nuevo,
  2026-09-03). Hoy el GEX giró a positivo por primera vez en cinco sesiones —el régimen que el
  Iron Condor necesita— y **29 de sus 39 evaluaciones murieron en `POSITION_OPEN`**, con el
  cupo SPXW tomado por el 1DTE de ayer (hasta las 10:30) y después por dos direccionales. Solo
  7 ciclos llegaron a evaluar su gate. **No es una propuesta todavía** —falta ver si se repite,
  un día con dos direccionales largos puede ser casualidad— pero la pregunta previa sí se puede
  contestar sin más muestra: **¿un IC 1DTE heredado de la noche anterior debería contar como
  posición que bloquea al 0DTE de la mañana siguiente?** Sí o no.

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
