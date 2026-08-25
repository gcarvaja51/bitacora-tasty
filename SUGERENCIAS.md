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

## Anotaciones diarias — sin propuesta todavía (lun–jue se anota)

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
