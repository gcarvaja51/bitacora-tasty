# Análisis del log de estrategia SPX

> Generado por `scripts/analisis_spx.py` (solo lectura). El resultado de cada evaluación se aproxima con el retorno adelantado del SPX, no con P&L real — ver la nota de método en la cabecera del script.

## Cobertura de los datos

- **Evaluaciones registradas:** 3,927
- **Sesiones de mercado (hora ET):** 10
- **Rango:** 2026-07-17 → 2026-08-04
- **Con precio del SPX:** 1,785
- **Con dirección y score:** 1,421

| sesión     | dia       | evaluaciones | precio_usable | señales |
|------------|-----------|--------------|---------------|---------|
| 2026-07-17 | Friday    | 22           | 22            | 0       |
| 2026-07-20 | Monday    | 104          | 102           | 0       |
| 2026-07-21 | Tuesday   | 290          | 261           | 0       |
| 2026-07-22 | Wednesday | 295          | 255           | 0       |
| 2026-07-23 | Thursday  | 270          | 254           | 0       |
| 2026-07-29 | Wednesday | 842          | 303           | 94      |
| 2026-08-01 | Saturday  | 649          | 0             | 0       |
| 2026-08-02 | Sunday    | 140          | 0             | 0       |
| 2026-08-03 | Monday    | 578          | 177           | 39      |
| 2026-08-04 | Tuesday   | 737          | 411           | 193     |


## Calidad de los datos: qué se descartó y por qué

De **2,040** evaluaciones que traían precio del SPX, se anularon **255** por no ser fiables. Quedan **1,785** usables para medir retornos.

| motivo del descarte                                           | registros |
|---------------------------------------------------------------|-----------|
| precio centinela 5530.00 (bug ya corregido en server.js:5135) | 25        |
| sesión de fin de semana (precio congelado del viernes)        | 230       |

> El embudo y el análisis de checks **sí** usan las 3.927 evaluaciones completas — la limpieza solo afecta a los cálculos de retorno.


## 1. El embudo: dónde mueren las evaluaciones

Cada fila es un motivo de corte. `SIGNAL_BUILT` es el único desenlace que produce una señal operable.

| etapa                   | NEUTRAL | REVERSION | TENDENCIA | TOTAL | % del total |
|-------------------------|---------|-----------|-----------|-------|-------------|
| TOTAL                   | 354     | 1566      | 2007      | 3927  | 100.0       |
| NO_CAMINO_B             | 0       | 0         | 1122      | 1122  | 28.6        |
| SCORE_FAIL              | 0       | 1082      | 1         | 1083  | 27.6        |
| POSITION_CHECK_MISMATCH | 80      | 0         | 592       | 672   | 17.1        |
| GEX_NOT_POSITIVE        | 0       | 429       | 0         | 429   | 10.9        |
| SIGNAL_BUILT            | 0       | 35        | 291       | 326   | 8.3         |
| GATE_FAIL               | 182     | 0         | 0         | 182   | 4.6         |
| POSITION_OPEN           | 80      | 0         | 0         | 80    | 2.0         |
| ERROR                   | 12      | 0         | 0         | 12    | 0.3         |
| NO_STRIKES              | 0       | 11        | 0         | 11    | 0.3         |
| INSUFFICIENT_BARS       | 0       | 9         | 0         | 9     | 0.2         |
| STRATEGY_INVALID        | 0       | 0         | 1         | 1     | 0.0         |

**Conversión por familia de estrategia:**

| familia   | evaluaciones | señales | % conversión |
|-----------|--------------|---------|--------------|
| TENDENCIA | 2007         | 291     | 14.5         |
| REVERSION | 1566         | 35      | 2.2          |
| NEUTRAL   | 354          | 0       | 0.0          |


## 2. ¿El score predice la dirección del SPX?

Comparación entre las evaluaciones que **pasaron** el umbral de score (`SIGNAL_BUILT`) y las que fueron **rechazadas** por score (`SCORE_FAIL`). Si el score sirve, las que pasan deben acertar más.

| horizonte | grupo                  | n   | % acierto direccional | retorno medio a favor (%) | retorno mediano (%) |
|-----------|------------------------|-----|-----------------------|---------------------------|---------------------|
| +15 min   | PASÓ (señal)           | 297 | 65.3                  | 0.041                     | 0.0593              |
| +15 min   | RECHAZADA (score bajo) | 807 | 29.6                  | -0.052                    | -0.0356             |
| +30 min   | PASÓ (señal)           | 261 | 69.0                  | 0.0914                    | 0.1016              |
| +30 min   | RECHAZADA (score bajo) | 744 | 24.3                  | -0.083                    | -0.0629             |
| +60 min   | PASÓ (señal)           | 212 | 89.6                  | 0.2448                    | 0.2854              |
| +60 min   | RECHAZADA (score bajo) | 675 | 25.3                  | -0.1432                   | -0.1149             |

⚠️ **Lo mismo contado por episodios.** El motor evalúa cada ~29 s: treinta filas seguidas son el MISMO momento de mercado. Esta tabla da un voto por episodio (huecos de más de 10 min separan episodios) y es la que hay que mirar — la de arriba exagera la muestra.

**Horizonte +15 min**

| grupo                  | episodios | pct_acierto | ret_medio |
|------------------------|-----------|-------------|-----------|
| PASÓ (señal)           | 167       | 56.9        | 0.022     |
| RECHAZADA (score bajo) | 547       | 25.3        | -0.0562   |

**Horizonte +30 min**

| grupo                  | episodios | pct_acierto | ret_medio |
|------------------------|-----------|-------------|-----------|
| PASÓ (señal)           | 154       | 62.0        | 0.0702    |
| RECHAZADA (score bajo) | 499       | 22.3        | -0.0932   |

**Horizonte +60 min**

| grupo                  | episodios | pct_acierto | ret_medio |
|------------------------|-----------|-------------|-----------|
| PASÓ (señal)           | 127       | 82.7        | 0.2019    |
| RECHAZADA (score bajo) | 474       | 22.5        | -0.1514   |

**Acierto por tramo de score** (¿es monótono? debería serlo):

| tramo de score | filas | episodios | sesiones | acierto_30m | ret_medio_30m |
|----------------|-------|-----------|----------|-------------|---------------|
| 0-25           | 243   | 109       | 5        | 23.5        | -0.0889       |
| 25-50          | 337   | 244       | 5        | 29.7        | -0.0692       |
| 50-60          | 71    | 71        | 3        | 18.3        | -0.087        |
| 60-70          | 73    | 72        | 3        | 15.1        | -0.0974       |
| 70-75          | 51    | 51        | 3        | 3.9         | -0.1428       |
| 75-85          | 29    | 15        | 1        | 100.0       | 0.3156        |
| 85-100         | 201   | 109       | 3        | 74.1        | 0.0919        |

> Mirar la columna `episodios`, no `filas`. Un tramo con muchas filas pero 2 o 3 episodios describe un par de ratos concretos, no una regularidad — su porcentaje no significa nada todavía.

**Rechazos al filo del umbral:** 65 de 1,083 (6.0%) quedaron a 10 puntos o menos del mínimo exigido.
De esos, el **11.3%** acertó la dirección a +30 min (n=53).


## 3. Qué checks del playbook bloquean de verdad

`puntos perdidos` = peso del check × su tasa de fallo. Es el check que más puntaje te está costando en promedio.

| familia   | check                                       | veces | peso | pct_ok | puntos perdidos |
|-----------|---------------------------------------------|-------|------|--------|-----------------|
| REVERSION | Alejamiento de SMA8                         | 1082  | 45   | 55.5   | 20.0            |
| REVERSION | Patrón de Confirmación (García/Tiburón/9)   | 1082  | 20   | 26.5   | 14.7            |
| REVERSION | Compás de Medias 8/20 (5m)                  | 1082  | 15   | 36.2   | 9.6             |
| REVERSION | Fase Weinstein 5m a favor                   | 321   | 10   | 9.7    | 9.0             |
| REVERSION | Fase Weinstein 15m a favor                  | 761   | 10   | 52.8   | 4.7             |
| REVERSION | Régimen GEX + Confluencia con Muro de Gamma | 714   | 10   | 72.5   | 2.8             |
| REVERSION | Confluencia con Muro de Gamma               | 368   | 10   | 100.0  | 0.0             |
| REVERSION | RSI sobrecompra/sobreventa                  | 1082  | 0    | 31.7   | 0.0             |
| TENDENCIA | macd_cruce_pendiente                        | 293   | 15   | 84.3   | 2.4             |
| TENDENCIA | ema_10_20_alineadas                         | 293   | 10   | 98.3   | 0.2             |
| TENDENCIA | patrones_estructurales                      | 293   | 20   | 99.7   | 0.1             |
| TENDENCIA | confirmacion_algoritmica                    | 293   | 0    | 1.4    | 0.0             |
| TENDENCIA | fase_weinstein                              | 293   | 45   | 100.0  | 0.0             |
| TENDENCIA | macd_doble_marco                            | 293   | 0    | 99.7   | 0.0             |
| TENDENCIA | regimen_institucional                       | 293   | 10   | 99.7   | 0.0             |
| TENDENCIA | volumen_rompimiento                         | 293   | 0    | 0.0    | 0.0             |


## 4. Acierto direccional según el contexto de mercado

Sobre todas las evaluaciones con dirección (pasaran o no). Busca regímenes donde la lectura funciona mejor o peor.

⚠️ **Sesgo de régimen.** En la ventana analizada el SPX pasó de 7,475 a 7,749 (**+3.7%**) en solo 10 sesiones. En un tramo alcista, cualquier tesis BULLISH acierta más que una BEARISH por el simple arrastre del mercado. La tabla de dirección de abajo mide eso tanto como mide la calidad del sistema — no se puede separar con 10 días.

**Familia de estrategia**

| Familia de estrategia | filas | episodios | sesiones | acierto_30m | ret_medio |
|-----------------------|-------|-----------|----------|-------------|-----------|
| REVERSION             | 789   | 544       | 5        | 23.3        | -0.0848   |
| TENDENCIA             | 226   | 119       | 3        | 78.3        | 0.1231    |

**Régimen GEX**

| Régimen GEX | filas | episodios | sesiones | acierto_30m | ret_medio |
|-------------|-------|-----------|----------|-------------|-----------|
| NEGATIVO    | 258   | 214       | 1        | 30.2        | -0.0691   |
| POSITIVO    | 757   | 449       | 4        | 37.4        | -0.0281   |

**Dirección de la tesis**

| Dirección de la tesis | filas | episodios | sesiones | acierto_30m | ret_medio |
|-----------------------|-------|-----------|----------|-------------|-----------|
| BEARISH               | 585   | 409       | 5        | 20.9        | -0.0722   |
| BULLISH               | 430   | 254       | 5        | 55.6        | 0.0072    |

**Fase Weinstein 15m**

| Fase Weinstein 15m | filas | episodios | sesiones | acierto_30m | ret_medio |
|--------------------|-------|-----------|----------|-------------|-----------|
| 1.0                | 29.0  | 16.0      | 2.0      | 20.7        | -0.1692   |
| 2.0                | 756.0 | 448.0     | 4.0      | 37.4        | -0.0281   |
| 4.0                | 230.0 | 199.0     | 1.0      | 31.3        | -0.0564   |

**Hora del día (ET)**

| Hora del día (ET) | filas | episodios | sesiones | acierto_30m | ret_medio |
|-------------------|-------|-----------|----------|-------------|-----------|
| 9.0               | 98.0  | 54.0      | 2.0      | 41.8        | -0.1119   |
| 10.0              | 276.0 | 207.0     | 5.0      | 51.8        | 0.0015    |
| 11.0              | 277.0 | 202.0     | 5.0      | 24.9        | -0.0528   |
| 12.0              | 291.0 | 189.0     | 5.0      | 27.8        | -0.0488   |
| 13.0              | 73.0  | 16.0      | 3.0      | 37.0        | 0.0034    |

**VIX**

| VIX   | filas | episodios | sesiones | acierto_30m | ret_medio |
|-------|-------|-----------|----------|-------------|-----------|
| 15-17 | 574   | 387       | 3        | 36.9        | -0.037    |
| 17-19 | 219   | 89        | 3        | 37.4        | -0.0262   |
| >19   | 222   | 192       | 3        | 30.2        | -0.0546   |


## 5. Los gates duros

Cortes que ocurren ANTES de calcular el score. No guardan dirección, así que no se puede medir su acierto — pero sí cuánto filtran.

| gate                    | NEUTRAL | REVERSION | TENDENCIA | TOTAL |
|-------------------------|---------|-----------|-----------|-------|
| NO_CAMINO_B             | 0       | 0         | 1122      | 1122  |
| POSITION_CHECK_MISMATCH | 80      | 0         | 592       | 672   |
| GEX_NOT_POSITIVE        | 0       | 429       | 0         | 429   |
| GATE_FAIL               | 182     | 0         | 0         | 182   |

**Motivos textuales más frecuentes:**

| motivo                                                                                          | veces |
|-------------------------------------------------------------------------------------------------|-------|
| Sin alineación Camino B                                                                         | 1119  |
| Tradier dice true, registro local dice false — se usa el mas conservador (bloquear si cualquier | 672   |
| GEX NEGATIVO — reversión requiere gamma positivo (gate duro)                                    | 429   |
| Gamma régimen NEGATIVO — Iron Condor requiere GEX POSITIVO.                                     | 85    |
| Rango de apertura (9:30-10:00) roto — Iron Condor no recomendado, esperar nueva estructura.     | 33    |
| No se pudo determinar si el rango de apertura fue respetado — sin datos suficientes para Iron C | 26    |
| No se pudo verificar el calendario económico de mañana (Investing.com) — por seguridad, no se e | 5     |
| Fase Weinstein 15m = 2 — Iron Condor requiere Fase 1 o 3 (consolidación/rango, sin tendencia cl | 5     |
| Precio (7489.72) a menos de 20pts del Gamma Flip (7470) — el régimen puede cambiar de golpe.    | 4     |
| Historial insuficiente (2m)                                                                     | 3     |
| Precio (7493.77) a menos de 20pts del Gamma Flip (7495) — el régimen puede cambiar de golpe.    | 1     |
| Precio (7494.53) a menos de 20pts del Gamma Flip (7495) — el régimen puede cambiar de golpe.    | 1     |

