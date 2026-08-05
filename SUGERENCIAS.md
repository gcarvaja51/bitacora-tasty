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
