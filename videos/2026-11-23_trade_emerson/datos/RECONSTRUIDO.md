# Lecturas RECONSTRUIDAS cargadas en /api/capas el 23-nov-2026

El bot de Discord estuvo sin sesión de 9:31 a 13:14 ET. A pedido de Guillermo se cargaron en la hoja Hiro
57 lecturas reconstruidas de las pantallas de la tarde (script `rellenar_manana.py`):

| Capa | Horas | Fuente |
|---|---|---|
| GexBot Classic · Gamma Flip GB | 10:30–13:20, cada 5 min | línea naranja digitalizada de `capturas/2026-11-23/155738_gexbot_classic.png` (validada ±0,4 pts contra la cabecera de 13:15 y 13:28). Antes de 10:30 no se carga: se confunde con otra línea amarilla. |
| HIRO SpotGamma (calls/puts) | 10:00–13:20, cada 5 min | curva del día de la lectura de las 15:55 (captura `155016_hiro.png`), mediana de 7 min (quita los picos de las líneas "HIRO Flow") |
| Bola 8 | 10:06–11:54, las 16 predicciones (hh:mm:30) | historial del canal magic-8-ball (`historial_bola8.mjs`): sesgo = Trend Up, objetivo 1 = "closing near", objetivo 2 = el otro extremo del rango |

No se pudieron reconstruir (las pantallas solo muestran el valor del momento): barras del histograma de GexBot Classic,
GexBot State, Option Flow y Tradytics.

Identificación en el archivo del día: las lecturas reconstruidas son las de 10:00–13:20 que traen `gexbot_classic` SIN
barras, `hiro` o `bola8` sin curva Sonar; las reales de ese tramo solo tienen spx/fases/confluencia.

Agregado después: **Bola 8 Sonar de las 10:51** (curva por strike, pico 7.250), leída con `lector.bola8_sonar` de la única
imagen de Sonar que quedó en el historial del canal esa mañana (`bola8/bola8_1051_0.png`). Entre 10:51 y 13:25 la hoja
muestra esa Sonar (los demás informes de la mañana fueron solo texto).

**Corrección (mismo día):** con `historial_bola8.mjs` mejorado (toma los enlaces de los adjuntos aunque Discord no haya
cargado la imagen) salieron 94 imágenes; 30 son la "Magic 8-Ball Sonar" verdadera (curva por strike, con Bias y Strength),
de 9:48 a 13:24, cargadas a su hora (hh:mm:45) en `bola8_v2/sonar_lecturas.json`. La Sonar de 10:51:00 cargada antes salió
del gráfico en el tiempo (no de la Sonar) y queda superada por la verdadera de 10:51:45.
