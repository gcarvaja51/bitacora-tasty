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

### 2. El piso de crédito y el límite de precio de entrada son la MISMA perilla — NEUTRAL, impacto MEDIO

**Anotado:** 2026-08-13 · **Evidencia:** el IC 1DTE `tex-1786564157055` del 2026-08-12

`server.js` deriva el límite de la orden directamente del piso de crédito:

```js
minCreditPrice: +((icCfg.minCreditoAnchoPct ?? 25) / 100 * gate.spreadWidth).toFixed(2)
```

Con `minCreditoAnchoPct` en **0** (decisión del 2026-08-08, "no le pongamos límite a la prima
recibida por ahora"), ese precio da 0, y `placeIronCondorOrder` lo lleva a
`Math.max(0.01, 0)`. La orden sale como `type: credit` **con límite de un centavo**: acepta
cualquier fill.

**Medido en el primer IC 1DTE que disparó de verdad:** crédito estimado sobre el mid
**$125**, crédito real de fill **$65** — casi la mitad. Riesgo neto $435 para un TP de
$19.50.

Poner el piso en 0 no solo apagó el filtro de *"no entres si pagan poco"* — apagó también el
*"no me llenes a cualquier precio"*, que es una protección distinta y que nadie quiso quitar.
Ese acoplamiento no estaba documentado.

**Opción natural:** desacoplar las dos cosas. Mantener `minCreditoAnchoPct` en 0 (para que el
setup siga disparando y se junte muestra) pero mandar el límite al **mid observado menos un
colchón**, igual que ya hacen los cierres direccionales con `closeSlippageBufferPts`.

⚠️ Al tocarlo, tener presente el trade-off que ya se aceptó en los cierres: un colchón muy
angosto puede dejar la orden sin llenar, y la ventana del 1DTE da **1 o 2 intentos, no más**.

---

### 3. La banda de alejamiento deja pasar el setup por centésimas — REVERSION, impacto ALTO

**Anotado:** 2026-08-13 · **Evidencia:** 112 evaluaciones del 2026-08-13

De 112 evaluaciones, **77 murieron en `SIN_ALEJAMIENTO`** con el estiramiento entre
**−0.09% y −0.12%**, contra una banda que exige **0.13%–0.3%**. Siempre afuera, siempre por
centésimas.

⚠️ **Ojo, discrepancia sin registrar:** esa banda **no coincide** con lo documentado en
CLAUDE.md (0.10%–0.35%, con meseta óptima en 0.15%–0.20%). En algún momento se retocó sin
que quedara anotado — antes de mover nada, confirmar cuál es el valor real en producción y
por qué cambió.

---

### 4. Los dos checks de 5m son un VETO, no un peso — REVERSION, impacto ALTO

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

⚠️ **No mover 3 y 4 el mismo día.** Son las dos de impacto ALTO sobre la misma estrategia; si
se aplican juntas no se puede saber cuál funcionó. Además la 3 cambia *cuántas* señales
llegan a evaluarse y la 4 cambia *cuántas* pasan — mezclarlas hace ilegible la medición.

**Contexto de la muestra:** REVERSION lleva **dos días sin producir nada** (2026-08-12: una
sola señal, que además murió como orden zombi del sandbox; 2026-08-13: cero en 112
evaluaciones).

---

## Decisiones pendientes (no son sugerencias, son cosas sin responder)

- **`smaReversion.earlyExitPct` está en 0.6** y el usuario lo había subido explícitamente a
  **0.9** el 2026-08-02. Apareció en 0.6 el 2026-08-13 junto con el `minScore` en 0, que sí se
  confirmó como config corrupta y se restauró. Este quedó sin decidir: ¿se devuelve a 0.9 o se
  deja en 0.6? Ver la sección "Config de producción a la deriva" en CLAUDE.md.

---

## Aplicadas

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
