# Sugerencias de cambio — backlog

**Cadencia (regla del usuario, 2026-08-05):** los cambios de estrategia se aplican
**solamente viernes y sábado**, para que empiecen a operar el lunes siguiente. De lunes a
jueves las ideas se anotan acá, no se implementan.

**Excepción:** los bugs que causan daño real se arreglan cuando aparecen (un loop
colocando órdenes reales, un P&L mal calculado). Si cambia *cuándo se entra o se sale*, es
ajuste y espera al viernes.

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

_(vacío — mover acá lo que se despliegue, con la fecha)_
