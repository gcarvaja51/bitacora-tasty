# Iron Balls fuera de Tradytics: Bola 8, reportes de mercado y comunidad (27-nov-2026)

**Fuentes.** Volcado de Discord del 27-nov (`1249695905133887561.jsonl`: Bola 8, 135 mensajes del 25-nov 11:16 ET al 27-nov 13:17 ET; `1249705567535239219.jsonl`: reportes-de-mercado, 5 mensajes), las imágenes de la Bola 8 del 27-nov (51 PNG en `imgs/`; las del 25-nov **no** se descargaron), `../../sondeos_discord.jsonl` (9 sondeos del 22 al 27-nov), la bitácora `/api/capas` (25 y 27-nov) y las velas de 1 min `/api/hiro` (25-nov: 393 velas de 09:30 a 16:02; 27-nov: 213 velas de 09:30 a 13:02).
**Script:** `analisis_bola8.py` (se corre con `python -I analisis_bola8.py <carpeta_volcado> <carpeta_api>`). **Tablas:** `bola8_tablas.json`.
**Convención:** **[H]** = hecho observado en los datos; **[I]** = interpretación mía.

---

## 1. Bola 8 a fondo: qué publica

Cada ~15 min (hh:00:5x, :15:5x, :30:5x, :45:5x según el reloj del bot; Discord lo publica ~1,5 min después) el bot "iron ball" publica **4 mensajes**: 1 de texto y 3 imágenes (`SPX_magic_*.png`, `SPX_quad_*.png`, `SPX_sonar_*.png`).
[H] 27-nov: 15 predicciones (09:45:50 a 13:16:32 ET, dos de ellas después del cierre). 25-nov: 18 con texto en el volcado (11:30 a 15:46 ET). La primera tanda del volcado del 25-nov (11:16 ET) trae solo imágenes, sin texto. **El volcado del 25-nov no tiene la mañana (09:30 a 11:15)**, aunque la bitácora sí capturó la Sonar desde las 09:46.

### 1.1 El TEXTO (hoy no lo leemos)

Ejemplo literal (27-nov 12:31:22):

```
Prediction for SPX - 11-27-2026 12:31:22 - Version: 1.0.37 Build 8
SPX current price of $7279.74 Up trend, closing near $7300.0, but will range from $7250 to $7300.
Price: 7279.74            Trend: Up              Predicted Close: 7280.06 - Experimental
Strength: 0.46            Short term: 7300.0     Short term bias: Bullish
Long term: 7278.81        Long term bias: Bullish
Calls: 7300.0  Puts: 7300.0  Center: 7300.0  Range: 50.0
Target 1: 7300.0  Target 2: 7250.0
Delta: 7279.1  Gamma: 7300.0  Interest: 7198.81  Sonar: 7300.0  Volume: 7275.35
Forecasts: 11-30-2026: Target: 7300.0 Direction: Up
Example Trades:
 Butterfly (neutral, centro): BUY +1 Butterfly SPX 27 Nov 26 7335/7295/7255 CALL @21.88 LMT
 Iron Condor (neutral, ancho): SELL -1 IC 7310/7315/7250/7245 @0.35 LMT
 Sonar (IC angosto):          SELL -1 IC 7300/7305/7260/7255 @0.95 LMT
 Vertical (crédito con sesgo): SELL -1 Vertical 7265/7260 PUT @0.75 LMT
```

| Campo | Qué es (observado) | Nota |
|---|---|---|
| Version | `1.0.37 Build 8`, igual en las 33 predicciones y también el 20-nov (sondeo) | [H] sin cambios de versión en la muestra |
| Price | SPX en el instante del cálculo | |
| Trend | Up/Down | [I] se comporta como lectura de momentum: el 25-nov pasó a "Up" a las 12:00, cuando el rally ya llevaba +40 pts |
| Predicted Close | cierre estimado, marcado "Experimental" | ver §2: peor que el precio actual |
| Strength | 0 a 1 | |
| Short term / Short term bias | nivel y sesgo de corto plazo | [H] **Short term = Gamma en 33 de 33** |
| Long term / Long term bias | nivel y sesgo de largo plazo | |
| Calls / Puts / Center | picos de calls y puts del panel Gamma; Center = (Calls+Puts)/2 | [H] Center = promedio en 33 de 33; Calls/Puts = los del panel Gamma del cuadro de 4 |
| Range | ancho del rango de la frase ("from X to Y") | 50 pts casi siempre; 25 al final del 25-nov; **5** después del cierre del 27 |
| Target 1 / Target 2 | extremos del rango | [H] **Target 1 = "closing near" en 33 de 33**. Es la misma información que la frase |
| Delta, Gamma, Interest, Sonar, Volume | nivel que predice cada submodelo | los 4 primeros salen también en el cuadro de 4; Interest (OI) queda lejos del precio (7163 a 7204 el 27-nov) |
| Forecasts | **pronóstico del día siguiente**: fecha, objetivo, dirección | no aparece en ninguna imagen |
| Example Trades | 4 operaciones 0DTE con strikes y precio límite | no aparecen en ninguna imagen |

**[H] Lo único que hoy sale de la Sonar (sesgo, fuerza, T1, T2, precio, curva) cubre solo una parte del texto, y no siempre coincide con él:**
- 27-nov: el sesgo de la Sonar fue igual al `Trend` del texto en 13 de 13 y la fuerza difirió como mucho 0,02.
- 25-nov: **no coincidieron en 6 de 17** (12:17, 12:32, 12:47, 13:02, 13:17 y 15:32). La Sonar dijo *bearish* cuando el texto decía *Up*. Además la fuerza del texto (0,59 a 0,70) duplicó la de la Sonar (0,25 a 0,49).
- [I] La imagen se genera ~1 min después del texto y puede ser un cálculo distinto, o pudo fallar la lectura por OCR. No lo puedo verificar porque las imágenes del 25-nov no están en el volcado.
- Huecos de la bitácora: el 25-nov no hay Sonar de las 12:02 y falta Target 2 en 3 registros (13:17, 14:02 y 14:47). En 6 registros (25-nov 11:01 y 11:16; 27-nov 09:47, 10:02, 12:03 y 12:17) la curva está vacía y aparecen calls/puts. Hay un registro doble el 25-nov (11:16 y 11:17).

### 1.2 Imagen "magic" (gráfico en el tiempo)
[H] Muestra la historia de la sesión con Price (magenta), Short term (verde claro), Long term (verde oscuro), Target 1 y Target 2 (naranja, en escalón) y una traza azul "Sonar". Los nodos del precio parecen ir cada ~5 a 8 min, más seguido que el texto. A las 13:16 del 27-nov se ve todo el día: los objetivos saltan de 7200/7250 a 7300 desde ~10:30 y el Short term persigue al precio desde abajo.
[I] **Valor bajo.** Casi todo se puede reconstruir guardando el texto cada 15 min. Lo único que aporta es un poco más de resolución temporal, y no vale el costo del OCR.

### 1.3 Imagen "quad" (4 paneles)
[H] Son 4 submodelos, **Volume, Interest (OI), Gamma y Delta**. Cada panel trae su **sesgo propio (Bullish/Bearish)**, su nivel "Prediction", el precio, y el **strike con el pico de Puts y el de Calls** de ese modelo, dibujado sobre las curvas de puts (rojo) y calls (verde) por strike. Ejemplos:

| Hora (27-nov) | Volume | Interest (OI) | Gamma | Delta |
|---|---|---|---|---|
| 09:45 | Bearish 7256,31 · P 7200 / C 7350 | Bullish 7192,72 · P 7000 / C 7350 | Bullish 7250 · P 7250 / C 7250 | Bearish 7260,96 · P 7250 / C 7300 |
| 10:00 | Bearish 7239,13 · P 7200 / C 7300 | Bullish 7163,15 · P 7000 / C 7300 | Bullish 7250 · P 7250 / C 7250 | Bearish 7207,3 · P 7200 / C 7250 |
| 12:01 | Bullish 7250,49 · P 7200 / C 7300 | Bullish 7193,94 · P 7000 / C 7300 | Bullish 7300 · P 7300 / C 7300 | Bullish 7274,3 · P 7270 / C 7275 |
| 13:16 | Bullish 7285,44 · P 7270 / C 7300 | Bullish 7204,05 · P 7000 / C 7300 | Bullish 7300 · P 7300 / C 7300 | Bullish 7299,56 · P 7300 / C 7285 |

- [H] **El texto no trae** ni el sesgo de cada panel ni los picos de Puts/Calls de Volume, Interest y Delta. Solo trae los del panel Gamma, como "Calls/Puts".
- [H] El pico de calls por **OI fue 7300 desde las 10:00** (7350 a las 09:45), el mismo valor que el **Call Wall de Sigma (7300)**. El pico de puts por OI se quedó en 7000, lejos del Put Wall de Sigma (7250): es otra métrica.
- [H] La etiqueta del panel no es el signo de (Prediction − precio). A las 09:45 Delta dice "Bearish" con 7260,96 sobre el precio 7239,93, y a las 13:16 Volume dice "Bullish" con 7285 bajo el precio 7297.
- [I] La etiqueta seguramente refleja el balance calls/puts del modelo y no la dirección hacia el nivel. Conviene capturarla tal cual, sin interpretarla.

### 1.4 Imagen "Sonar" (la única que leemos)
Trae curva de 0 a 1 por strike, Price, Target 1/2, Bias y Strength. Todo eso, salvo la curva, ya viene en el texto (con la salvedad de §1.1).

---

## 2. Calidad de la Bola 8 (25-nov y 27-nov)

**Método.**
- **Base:** cierre de la vela de 1 min del minuto en que Discord publicó el texto, en hora ET. Es lo que un trader podía ver.
- **Acierto direccional:** signo(SPX(t+h) − base) igual al sesgo, sin zona muerta.
- **Objetivo tocado:** el máximo o mínimo de las velas entre t y t+h llegó a Target 1.
- **Cierre:** 25-nov 7182,88 (vela 16:00); 27-nov 7297,5 (cierre oficial que diste).
- **Sin dato:** si t+h cae después del cierre, el horizonte queda sin dato y no cuenta.
- **Fuera de la muestra:** las 2 predicciones post-cierre del 27.

### 2.1 Tabla hora → sesgo → SPX
En cada horizonte la celda dice "SPX (movimiento) acierto del Trend sí/no · Target 1 tocado ✓/✗". "Sesgo Sonar" es lo que capturó **nuestra bitácora** (±3 min).


**2026-11-25** (cierre 7182.88)

| Hora ET | Trend | Fuerza | ST bias / LT bias | Sesgo Sonar (bitácora) | T1 / T2 | Pred. Close | SPX base | +15 min | +30 min | +60 min | Cierre |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 11:32 | Down | 0.8 | Bearish / Bearish | bearish 0.77 | 7000 / 7050 | 7002.88 | 7004.9 | 7004.2 (-0.7) sí · T1 ✓ | 7045.0 (+40.1) no · T1 ✓ | 7092.8 (+87.9) no · T1 ✓ | 7182.9 (+178.0) no · T1 ✓ |
| 11:47 | Down | 0.82 | Bearish / Bearish | bearish 0.79 | 7000 / 7050 | 7002.12 | 7004.2 | 7045.0 (+40.7) no · T1 ✓ | 7112.6 (+108.4) no · T1 ✓ | 7120.7 (+116.4) no · T1 ✓ | 7182.9 (+178.6) no · T1 ✓ |
| 12:02 | Up | 0.79 | Bearish / Bullish | no capturado | 7000 / 7050 | 7011.25 | 7045.0 | 7112.6 (+67.7) sí · T1 ✗ | 7092.8 (+47.9) sí · T1 ✗ | 7137.1 (+92.1) sí · T1 ✗ | 7182.9 (+137.9) sí · T1 ✗ |
| 12:17 | Up | 0.68 | Bearish / Bullish | bearish 0.46 | 7100 / 7000 | 7064.25 | 7112.6 | 7092.8 (-19.8) no · T1 ✓ | 7120.7 (+8.1) sí · T1 ✓ | 7154.6 (+41.9) sí · T1 ✓ | 7182.9 (+70.3) sí · T1 ✓ |
| 12:32 | Up | 0.7 | Bearish / Bullish | bearish 0.49 | 7100 / 7000 | 7069.0 | 7092.8 | 7120.7 (+27.8) sí · T1 ✓ | 7137.1 (+44.2) sí · T1 ✓ | 7147.2 (+54.4) sí · T1 ✓ | 7182.9 (+90.0) sí · T1 ✓ |
| 12:47 | Up | 0.62 | Bearish / Bullish | bearish 0.35 | 7100 / 7000 | 7070.62 | 7120.7 | 7137.1 (+16.4) sí · T1 ✗ | 7154.6 (+33.9) sí · T1 ✗ | 7188.8 (+68.2) sí · T1 ✗ | 7182.9 (+62.2) sí · T1 ✗ |
| 13:02 | Up | 0.64 | Bearish / Bullish | bearish 0.34 | 7100 / 7150 | 7103.0 | 7137.1 | 7154.6 (+17.5) sí · T1 ✗ | 7147.2 (+10.2) sí · T1 ✗ | 7181.3 (+44.2) sí · T1 ✗ | 7182.9 (+45.8) sí · T1 ✗ |
| 13:17 | Up | 0.59 | Bearish / Bullish | bearish 0.25 | 7100 / 7150 | 7105.5 | 7154.6 | 7147.2 (-7.3) no · T1 ✗ | 7188.8 (+34.3) sí · T1 ✗ | 7186.6 (+32.0) sí · T1 ✗ | 7182.9 (+28.3) sí · T1 ✗ |
| 13:32 | Up | 0.41 | Bearish / Bullish | bullish 0.07 | 7150 / 7100 | 7143.62 | 7147.2 | 7188.8 (+41.6) sí · T1 ✓ | 7181.3 (+34.0) sí · T1 ✓ | 7188.3 (+41.1) sí · T1 ✓ | 7182.9 (+35.6) sí · T1 ✓ |
| 13:47 | Up | 0.23 | Bearish / Bullish | bullish 0.31 | 7200 / 7150 | 7151.12 | 7188.8 | 7181.3 (-7.5) no · T1 ✗ | 7186.6 (-2.2) no · T1 ✗ | 7169.8 (-19.0) no · T1 ✗ | 7182.9 (-6.0) no · T1 ✗ |
| 14:02 | Up | 0.3 | Bearish / Bullish | bullish 0.23 | 7150 / 7200 | 7149.25 | 7181.3 | 7186.6 (+5.3) sí · T1 ✗ | 7188.3 (+7.1) sí · T1 ✗ | 7180.2 (-1.1) no · T1 ✗ | 7182.9 (+1.6) sí · T1 ✗ |
| 14:17 | Up | 0.19 | Bearish / Bullish | bullish 0.34 | 7200 / 7150 | 7153.25 | 7186.6 | 7188.3 (+1.7) sí · T1 ✗ | 7169.8 (-16.8) no · T1 ✗ | 7177.2 (-9.4) no · T1 ✗ | 7182.9 (-3.7) no · T1 ✗ |
| 14:32 | Up | 0.17 | Bearish / Bullish | bullish 0.36 | 7200 / 7150 | 7154.62 | 7188.3 | 7169.8 (-18.5) no · T1 ✗ | 7180.2 (-8.1) no · T1 ✗ | 7158.4 (-29.9) no · T1 ✗ | 7182.9 (-5.5) no · T1 ✗ |
| 14:47 | Up | 0.31 | Bearish / Bullish | bullish 0.23 | 7150 / 7200 | 7150.38 | 7169.8 | 7180.2 (+10.4) sí · T1 ✗ | 7177.2 (+7.4) sí · T1 ✗ | 7178.8 (+9.0) sí · T1 ✗ | 7182.9 (+13.1) sí · T1 ✗ |
| 15:02 | Up | 0.34 | Bearish / Bullish | bullish 0.22 | 7150 / 7200 | 7149.25 | 7180.2 | 7177.2 (-3.0) no · T1 ✗ | 7158.4 (-21.8) no · T1 ✗ | sin dato | 7182.9 (+2.7) sí · T1 ✗ |
| 15:17 | Up | 0.29 | Bearish / Bullish | bullish 0.27 | 7200 / 7150 | 7152.75 | 7177.2 | 7158.4 (-18.8) no · T1 ✗ | 7178.8 (+1.6) sí · T1 ✗ | sin dato | 7182.9 (+5.7) sí · T1 ✗ |
| 15:32 | Up | 0.52 | Bearish / Bullish | bearish 0.09 | 7150 / 7175 | 7140.81 | 7158.4 | 7178.8 (+20.4) sí · T1 ✗ | sin dato | sin dato | 7182.9 (+24.5) sí · T1 ✗ |
| 15:48 | Up | 0.4 | Bearish / Bullish | bullish 0.15 | 7150 / 7175 | 7145.93 | 7177.1 | sin dato | sin dato | sin dato | 7182.9 (+5.7) sí · T1 ✗ |

**2026-11-27** (cierre 7297.5)

| Hora ET | Trend | Fuerza | ST bias / LT bias | Sesgo Sonar (bitácora) | T1 / T2 | Pred. Close | SPX base | +15 min | +30 min | +60 min | Cierre |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 09:47 | Up | 0.31 | Bullish / Bearish | bullish 0.31 | 7250 / 7200 | 7233.75 | 7227.1 | 7218.4 (-8.7) no · T1 ✗ | 7243.6 (+16.5) sí · T1 ✗ | 7271.7 (+44.6) sí · T1 ✓ | 7297.5 (+70.4) sí · T1 ✓ |
| 10:02 | Down | 0.2 | Bullish / Bearish | bearish 0.2 | 7250 / 7200 | 7227.12 | 7218.4 | 7243.6 (+25.1) no · T1 ✗ | 7244.6 (+26.2) no · T1 ✓ | 7267.6 (+49.2) no · T1 ✓ | 7297.5 (+79.1) no · T1 ✓ |
| 10:17 | Up | 0.35 | Bullish / Bearish | bullish 0.33 | 7250 / 7200 | 7239.55 | 7243.6 | 7244.6 (+1.1) sí · T1 ✓ | 7271.7 (+28.1) sí · T1 ✓ | 7261.5 (+17.9) sí · T1 ✓ | 7297.5 (+53.9) sí · T1 ✓ |
| 10:32 | Up | 0.37 | Bullish / Bullish | bullish 0.36 | 7250 / 7300 | 7254.23 | 7244.6 | 7271.7 (+27.1) sí · T1 ✓ | 7267.6 (+23.0) sí · T1 ✓ | 7271.6 (+27.0) sí · T1 ✓ | 7297.5 (+52.9) sí · T1 ✓ |
| 10:47 | Up | 0.45 | Bullish / Bullish | bullish 0.46 | 7250 / 7300 | 7271.88 | 7271.7 | 7267.6 (-4.1) no · T1 ✗ | 7261.5 (-10.2) no · T1 ✗ | 7280.7 (+8.9) sí · T1 ✗ | 7297.5 (+25.8) sí · T1 ✗ |
| 11:02 | Up | 0.43 | Bullish / Bullish | bullish 0.43 | 7250 / 7300 | 7257.2 | 7267.6 | 7261.5 (-6.1) no · T1 ✗ | 7271.6 (+4.0) sí · T1 ✗ | 7276.4 (+8.8) sí · T1 ✗ | 7297.5 (+29.9) sí · T1 ✗ |
| 11:17 | Up | 0.41 | Bullish / Bullish | bullish 0.4 | 7250 / 7300 | 7256.65 | 7261.5 | 7271.6 (+10.1) sí · T1 ✗ | 7280.7 (+19.1) sí · T1 ✗ | 7278.5 (+17.0) sí · T1 ✗ | 7297.5 (+36.0) sí · T1 ✗ |
| 11:32 | Up | 0.45 | Bullish / Bullish | bullish 0.47 | 7250 / 7300 | 7265.93 | 7271.6 | 7280.7 (+9.0) sí · T1 ✗ | 7276.4 (+4.8) sí · T1 ✗ | 7285.4 (+13.7) sí · T1 ✗ | 7297.5 (+25.9) sí · T1 ✗ |
| 11:47 | Up | 0.49 | Bullish / Bullish | bullish 0.52 | 7300 / 7250 | 7279.57 | 7280.7 | 7276.4 (-4.2) no · T1 ✗ | 7278.5 (-2.1) no · T1 ✗ | 7276.0 (-4.6) no · T1 ✗ | 7297.5 (+16.8) sí · T1 ✓ |
| 12:03 | Up | 0.47 | Bullish / Bullish | bullish 0.47 | 7300 / 7250 | 7279.6 | 7276.7 | 7276.2 (-0.5) no · T1 ✗ | 7285.4 (+8.8) sí · T1 ✗ | sin dato | 7297.5 (+20.8) sí · T1 ✓ |
| 12:17 | Up | 0.46 | Bullish / Bullish | bullish 0.46 | 7300 / 7250 | 7279.03 | 7278.5 | 7285.4 (+6.8) sí · T1 ✗ | 7276.0 (-2.5) no · T1 ✗ | sin dato | 7297.5 (+19.0) sí · T1 ✓ |
| 12:32 | Up | 0.46 | Bullish / Bullish | bullish 0.48 | 7300 / 7250 | 7280.06 | 7285.4 | 7276.0 (-9.3) no · T1 ✗ | sin dato | sin dato | 7297.5 (+12.1) sí · T1 ✓ |
| 12:47 | Up | 0.43 | Bullish / Bullish | bullish 0.43 | 7250 / 7300 | 7273.91 | 7276.0 | sin dato | sin dato | sin dato | 7297.5 (+21.5) sí · T1 ✗ |
| 13:03 | Up | 0.5 | Bullish / Bullish | no capturado | 7300 / 7295 | 7293.43 | — | después del cierre | | | |
| 13:17 | Up | 0.47 | Bullish / Bullish | no capturado | 7300 / 7295 | 7293.29 | — | después del cierre | | | |

### 2.2 Porcentajes de acierto (n = predicciones evaluables; ambos días juntos)

| Señal | +15 min | +30 min | +60 min | Al cierre |
|---|---|---|---|---|
| **Trend (texto)** | 51,7 % (15/29) | 63,0 % (17/27) | 65,2 % (15/23) | **80,6 % (25/31)** |
| Sesgo Sonar (**lo que capturamos**) | 42,9 % (12/28) | 42,3 % (11/26) | 40,9 % (9/22) | 60,0 % (18/30) |
| Short term bias | 44,8 % (13/29) | 44,4 % (12/27) | 52,2 % (12/23) | 51,6 % (16/31) |
| Long term bias | 51,7 % (15/29) | 55,6 % (15/27) | 56,5 % (13/23) | 74,2 % (23/31) |
| Dirección hacia Target 1 | 44,8 % (13/29) | 37,0 % (10/27) | 30,4 % (7/23) | 35,5 % (11/31) |
| Target 1 tocado | 24,1 % (7/29) | 29,6 % (8/27) | 39,1 % (9/23) | 41,9 % (13/31) |
| **Base ingenua "siempre alcista"** | 55,2 % (16/29) | 74,1 % (20/27) | 78,3 % (18/23) | **90,3 % (28/31)** |
| Base ingenua "momentum 15 min" | 41,4 % | 33,3 % | 47,8 % | 48,4 % |

Por día:
- **Trend:** 25-nov 58,8 / 62,5 / 57,1 / 72,2 %; 27-nov 41,7 / 63,6 / 77,8 / 92,3 %.
- **Sesgo Sonar:** 25-nov 43,8 / 26,7 / 15,4 / 35,3 %; 27-nov 41,7 / 63,6 / 77,8 / 92,3 %.
- **Short term bias:** 25-nov dijo **Bearish en las 18 publicaciones** mientras el SPX subía +178 pts (16,7 % al cierre). El 27-nov dijo Bullish en las 13 (100 % al cierre).

Otras medidas:
- **Cierre dentro del rango publicado:** 54,8 % (17/31); 25-nov 7/18 y 27-nov 10/13.
- **Error absoluto medio de cada nivel frente al cierre real (n=31):**

| Nivel | Error medio (pts) |
|---|---|
| Center | 43,5 |
| Precio del momento (ingenuo) | 43,9 |
| Gamma = Short term | 45,1 |
| Sonar | 51,8 |
| Target 1 = closing near | 53,8 |
| Delta | 58,1 |
| **Predicted Close** | **59,4** |
| Long term | 70,0 |
| Volume | 75,5 |
| Interest | 112,4 |

  → **[H] Ningún nivel le gana al precio del momento**, y el *Predicted Close* es 15 pts peor.
- **Fuerza:** con Strength ≥ 0,5 el Trend acertó a 60 min 6 de 8; con < 0,5 acertó 9 de 15. n demasiado chico para concluir.

### 2.3 Pronóstico del día siguiente ("Forecasts")
- [H] El 25-nov publicó "11-27: Target 7000 Down" **13 veces** (11:32 a 14:32). Desde las 14:47 cambió a "11-27: Target 7250 Up" (5 veces, hasta 15:48).
- [H] El 27-nov cerró en 7297,5 (+114,6 sobre el 25) y tocó 7304,1, así que el primero falló y el último acertó en dirección y en objetivo. **n = 1 día: no evaluable.**
- El 27-nov pronostica "11-30: Target 7300 Up" desde las 10:47 (pendiente).

### 2.4 Operaciones de ejemplo (al vencimiento, relleno al LMT publicado, sin comisiones)

| Operación | Ganadoras | P&L total (pts) | P&L medio |
|---|---|---|---|
| Vertical de crédito | **28/31** (16/18 y 12/13) | **+11,58** (+5,55 y +6,03) | +0,37 |
| IC ancho | 28/31 | −2,73 | −0,09 |
| IC "Sonar" (angosto) | 22/31 | −8,31 | −0,27 |
| Butterfly comprada | 8/31 | −164,67 | −5,31 |

[I] El vertical gana ~0,85 y pierde ~4,1, así que su resultado depende de 1 a 3 pérdidas. Con 2 días alcistas la muestra no permite separar acierto de régimen. Además el precio LMT puede no haberse llenado.

### 2.5 Veredicto sobre la calidad
- [H] El **Trend** del texto acierta más que el **sesgo de la Sonar** que hoy capturamos: al cierre 80,6 % frente a 60,0 %; a 60 min 65,2 % frente a 40,9 %.
- [H] Pero **ninguna señal de la Bola 8 le gana a "siempre alcista"** en estos 2 días: 90,3 % al cierre y 78,3 % a 60 min.
- [I] Con n = 31 en 2 días alcistas **no hay evidencia de ventaja**. La Bola 8 sirve hoy como mapa de niveles (Gamma, picos de OI) y no como gatillo direccional.
- [I] Siguiendo tu regla de 50 trades, se necesitan ≥ 10 días con días bajistas y laterales antes de concluir algo.

---

## 3. Publicaciones después del cierre (27-nov 13:01 y 13:16 ET)

[H] Son dos publicaciones casi idénticas, con precio 7298,16 / 7297,49 (ya liquidado):
- Trend Up, Strength 0,50 / 0,47; **Range 5** (7295 a 7300); T1 7300 / T2 7295.
- **Predicted Close 7293,4**: ya había cerrado en 7297,5, así que no tiene sentido.
- Interest 7204,05 y Volume 7285,44 **idénticos** en ambas: datos congelados.
- Las 4 operaciones de ejemplo vencen **el 27-nov, ya expirado**. Hay un vertical a 0,08.
- **Única información útil:** "Forecasts 11-30-2026: Target 7300 Direction Up". Es el mismo valor desde las 10:47, así que no agrega nada nuevo.

[I] **No sirven** para el día. Como mucho dejan el pronóstico del próximo día y el último mapa de niveles (OI calls 7300, Gamma 7300). Conviene guardarlas marcadas `post_cierre=true` y no mezclarlas con las intradía.

---

## 4. reportes-de-mercado, Emerson y comunidad

**reportes-de-mercado** (Emerson732):
- [H] Un mensaje **cada día hábil**, siempre entre 09:15 y 09:56 ET. Fechas vistas: 19, 20, 23, 24 y 25-nov. El 26 fue feriado y el 27 no hubo reporte al momento del volcado.
- [H] El texto solo dice "REPORTES DE MERCADO NOBIEMBRE dd 2026". Todo viene en **adjuntos**:
  1. *Founder's Notes – SpotGamma* (PDF, 0,7 a 1,8 MB)
  2. *MARKET SITUATION REPORT* (PDF de un correo, con título diario: 23-nov "Complete Destruction Of Systematic Positioning", 24-nov "Where Market Structure Meets Microstructure", 25-nov "Lack Of Demand For Optionality")
  3. *MSR 2.0* (PDF)
  4. *QuantData dd Noviembre* (PDF)
  5. 1 captura de pantalla
- [H] **No se descargó ningún adjunto** (no están en `imgs/` ni en ninguna carpeta de gexbot-sombra). Los enlaces de Discord vencen (`ex=`).
- [I] No puedo afirmar qué niveles traen. SpotGamma Founder's Notes suele traer Call Wall, Put Wall, Hedge Wall, Key Gamma Strike y Vol Trigger, pero eso **hay que verificarlo** abriendo uno.
- **No hay planes de trade en texto.**

**Otros canales** (según `sondeos_discord.jsonl`):
- **repeticiones-en-vivo:** grabaciones de Zoom de "Análisis y trading en vivo" (9, 10, 11, 12 y 13-nov), publicadas 0 a 2 días después. Desde el 21-nov hay 0 mensajes.
- **sesiones-de-herramientas:** introducción a Discord, Bola 8, Tradytics y option flow (9-nov); PDF de comandos de Tradytics; 2.ª sesión de GexBot con el PDF "Que-es-GEXBOT.pdf" (16-nov). Desde el 21-nov hay 0 mensajes.
- **chat-general y bienvenida:** saludos, preguntas de nuevos (acceso VIP, dónde estudiar GexBot, oferta de Black Friday). 0 mensajes desde el 21-nov. **Sin niveles ni ideas de trade.**
- **Escenarios de video (stage channels):** los sondeos los marcan "enVivo" en días hábiles. El 27-nov a las 13:19 ET ninguno estaba en vivo, lo que confirma que hoy no se transmitieron.

---

## 5. Qué estamos desaprovechando (prioridad)

1. **El texto de la Bola 8: leerlo en vez de hacer OCR de la Sonar.** Es texto plano: cero OCR y cero errores de lectura.
   - **Campos por publicación:** `hora_calculo`, `version`, `precio`, `trend`, `strength`, `pred_close`, `st`, `st_bias`, `lt`, `lt_bias`, `calls`, `puts`, `center`, `range`, `t1`, `t2`, `delta`, `gamma`, `interest`, `sonar_nivel`, `volume`, `forecast_fecha`, `forecast_target`, `forecast_dir`.
   - **Motivo [H]:** el `trend` del texto acertó al cierre 80,6 % frente a 60,0 % del sesgo Sonar, y el 25-nov ambos se contradijeron en 6 de 17. Es mejor fuente para el mismo concepto.
   - **Cómo:** la Sonar queda solo para la `curva`.
2. **Los PDF de reportes-de-mercado (09:15 a 10:00 ET).** Bajarlos a diario, antes de que venzan los enlaces, y extraer los niveles.
   - **Campos:** `fecha`, `titulo_msr` y, si los trae, `spotgamma_call_wall`, `put_wall`, `hedge_wall`, `key_gamma_strike`, `vol_trigger`, más los niveles o flujo de QuantData.
   - **Primero hay que abrir uno** para confirmar qué contienen [I]. Es la única fuente que llega **antes** de la apertura y podría alimentar el premercado.
3. **Cuadro de 4 de la Bola 8.**
   - **Campos:** `vol_bias`, `vol_puts`, `vol_calls`, `oi_bias`, `oi_puts`, `oi_calls`, `delta_bias`, `delta_puts`, `delta_calls`, `gamma_bias`. Los niveles "Prediction" ya vienen en el texto.
   - **Motivo [H]:** `oi_calls` = 7300 coincidió con el Call Wall de Sigma, y `vol_puts`/`vol_calls` muestran dónde se concentra el volumen del día. Requiere OCR de 4 títulos y 4 leyendas, de esfuerzo medio.
4. **Forecast del día siguiente:** guardar el último `forecast_*` antes del cierre y el post-cierre. Sirve para el premercado y para medir su acierto con n que crezca a diario (hoy n = 1).
5. **Libro sombra con las operaciones de ejemplo.** Guardar las 4 por publicación (`tipo`, `strikes`, `clase`, `precio_lmt`, `vencimiento`) y liquidarlas al cierre.
   - [H] El vertical ganó 28 de 31 con +11,6 pts en 2 días.
   - [I] Son 2 días alcistas, así que hay que acumular hasta 50 antes de juzgar.
6. **Marcar las publicaciones post-cierre** (`post_cierre=true`) y no tomarlas como señal.
7. **Completar los huecos de captura:** la mañana del 25-nov en el volcado, el registro doble del 25-nov 11:16/11:17 y las curvas vacías.
8. **Valor bajo, no priorizar:**
   - imagen "magic": se reconstruye con el texto;
   - repeticiones y sesiones: ya hay un proceso de Zoom de Emerson;
   - chat-general y bienvenida: sin contenido de mercado.

**Advertencia general [I]:** las cifras de acierto salen de 31 publicaciones en solo 2 días, ambos alcistas. Sirven para decidir **qué capturar**, no para operar con la Bola 8.
