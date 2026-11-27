# Canales Tradytics (Iron Balls): análisis del 27-nov-2026

**Para:** trader de SPX 0DTE (gamma/GEX, HIRO, flujo, fases EMA 10/20 en 5m y 2m)
**Fuentes:** volcado `discord_volcado/2026-11-27/` (11 canales de Tradytics), velas de 1 min del SPX (`/api/hiro`) del 24, 25 y 27-nov, y velas de 1 min de Yahoo (SPY, QQQ, IWM, VOO, UVXY, TSLA, STNG, NDX) solo para validar ideas.
**Convención:** **[H]** = hecho observado en los datos. **[I]** = interpretación mía. Horas en ET.
**Archivos de datos:** `tradytics_gex_2026-11-27.json` (tabla GEX y precio), `tradytics_flujo_ideas_2026-11-27.json` (sweeps, darkpool, ideas y su validación, estadísticas por canal), `scripts_tradytics/` (parser y tabla).

---

## 0. Resumen en 10 líneas

1. **[H]** Lo único que toca de verdad al SPX es **tradytics-bot**: 15 gráficos `/gexz` de SPX 0DTE hoy (09:35 a 12:45), 4 de SPY 0DTE, más niveles SR, niveles darkpool y heatmap. Los piden los miembros; no salen solos.
2. **[H]** Los gráficos de **SPX no traen línea "Magnet"**. Solo los de **SPY** traen "Magnet" y "2nd Magnet". Para el SPX usé la barra positiva más grande como "magnet".
3. **[H]** El strike **7300** dominó todo el día. Fue la barra + más grande de 09:49 a 10:01, con el SPX 75-85 pts abajo (7215). Desde 10:57 fue la barra − más grande y creció de −225 a −1.500 M. El precio llegó a 7304,1 a las 12:59 y cerró en 7297,5. Coincide con el Call Wall de Sigma.
4. **[H]** De 11:46 a 12:45, el magnet SPX fue **7285** y el precio osciló entre 7270 y 7295 durante una hora (pin). **[I]** En gamma positiva la barra + más grande describe dónde está el precio ATM. Casi nunca anticipa.
5. **[H]** El 25-nov fue un día de tendencia (+230 pts, de 6970 a 7199). Ahí la barra + más grande se quedó 75-80 pts **detrás** del precio toda la tarde. En días de tendencia no sirve como objetivo.
6. **[H]** La línea **SR de SPY 727,7** (pedida a las 09:44) equivale a SPX ≈7299. Fue el techo exacto del día (máximo SPX 7304,1, cierre 7297,5).
7. **[H]** Las alertas de sweeps, golden sweeps y trady-flow **no traen ni un SPX/SPY/QQQ/IWM**: todo son acciones sueltas. Lo más cercano: **VOO calls por 0,83 M a las 10:07**, en el minuto del mínimo del día (7211,5).
8. **[H]** Sweeps de hoy: calls 21,0 M frente a puts 11,7 M (64 % calls). Entre las 09 y las 10 h dominaron los puts. Desde las 11 h, los calls 3,8 a 1. **[I]** Coinciden con el giro del SPX o van detrás; no lo anticipan.
9. **[H]** scalps solo publicó 2 ideas en 5 días: 1 ganadora (STNG) y 1 perdedora (TSLA, stop 12:51). bullseye tuvo 34 ideas; las de índices bajistas (QQQ puts del 25 y del 27-nov) salieron contra el mercado.
10. **[I]** Vale la pena capturar a diario: (1) `/gexz SPX` (top ± strikes por hora), (2) Magnet/2nd Magnet de `/gexz SPY`, (3) niveles SR de SPY, (4) prints darkpool o block de SPY/QQQ ≥100 M, (5) la suma call/put de sweeps por hora como contexto. El resto es ruido para SPX 0DTE.

---

## 1. Canal por canal: qué publica, formato, frecuencia y relevancia para SPX

Conteos del volcado. Los canales con tope de 135 mensajes solo cubren desde el 25 o 26-nov.

| Canal | Msgs (rango) | Formato / campos | Horario ET observado | ¿Toca SPX/SPY/QQQ/ES? | Veredicto |
|---|---|---|---|---|---|
| **tradytics-bot** | 122 (23→27-nov); hoy 22 | Imagen PNG pedida por miembros. Nombre de archivo = tipo_símbolo_fecha_hora: `gexz_spx_s` (barras 0DTE GEX por strike, en M), `gexz_spx_t` (serie horaria de los 5 strikes mayores), `gexz_spy_s` (con **Magnet @ X / 2nd Magnet @ Y**), `gexlevels_spx_all` (GEX todas las expiraciones, con **Highest GEX @ / Lowest GEX @**), `sr_spy_h` (niveles SR horarios), `dplevels_spy` (niveles darkpool en $B), `heatmap_iwm_d/qqq/ndx` (prima neta por strike y vencimiento), `gexz_iwm/qqq`. A veces solo texto: "No darkpool data available". | 09:30–15:15 (pico 10 h). Hoy de 09:35 a 12:45. SPX 66 imágenes, SPY 39, IWM 9, QQQ 3. | **SÍ, es el único útil** | **Capturar** |
| options-sweeps | 135 (25 y 27-nov); hoy 62 | Embed: `Large {Call/Put} Sweep Order · Symbol · Strike · Expiration · Premiums · Time` (hora real del trade). Se publica entre 2 y 15 min después del trade. | 09:30–16:00, unas 15/h (pico 12 h) | No (0 SPX/SPY/QQQ/IWM). Hay VOO, SMH, SOXX y TQQQ. | Solo contexto agregado |
| golden-sweeps | 76 (23→27-nov); hoy 8 | Mismo formato. `Golden Sweep` = sweep grande (≥1 M). También mezcla "Sweep Order" del mismo bloque. | 09:30–16:00, pico 11 h | No (MU, NVDA, AMD) | Solo contexto agregado |
| trady-flow | 6 (23–24-nov); hoy 0 | Embed largo "Repeat flow": texto en lenguaje natural + `Symbol, Strike, Expiration, Call/Put, Buy/Sell, Orders, Prems Spent, Volume, OI, Tracking Link`. | 09:30–15:45 | Una vez NDX (put 25200 de 18-dic, 51,6 M) | Ruido / muy raro |
| darkpool | 135 (26–27-nov); hoy 60 | `{TICKER} {Darkpool/Blocktrade} Signal · Price · Shares · Amount · (Filled NoMatch) · Float · MarketCap · Float Proportion`. **No trae hora del trade**, solo la de publicación. | Hoy desde 05:57 (prints atrasados del día anterior); de 09 a 13 h, unas 10/h | **4 hoy: QQQ ×2, SPY ×2** | Capturar solo SPY/QQQ |
| bullseye | 34 (23→27-nov); hoy 3 | Igual que trady-flow, con título de "setup" (`ETF calls bought again`, `Fresh call positions`, `Call burst on a strong day`, `Bearish Stress Bounce Puts`, `Power-Hour Bearish Hedge Puts`). Las versiones nuevas (desde 25-nov) traen la regla de gestión: "vender mitad a +35 %, stop a breakeven, objetivo +100 %, salir a los 5 días". | 09:30–10:30 y 15:00–16:00 | SPY ×3, QQQ ×4, IWM ×1, UVXY ×1, SQQQ ×2, SDOW ×1 | Opcional (sesgo macro, no intradía) |
| scalps | 2 (24 y 27-nov) | `Scalp Trade Idea · {Bullish/Bearish} Continuation on {marco} · Symbol · Entry · Position · Target · Stoploss · Potential Profit` | Mediodía | No | Ruido (muy poco y nada de índices) |
| insider-trades | 25 (23–26-nov) | `Insider {Selling/Buying} · fecha/hora · Symbol · Total Shares · Total Amount` | Después del cierre (16:27–19:16) | No | Ruido |
| stock-breakouts | 110 (23→27-nov); hoy 22 | `{TICKER} Stock {Breakout/Breakdown} Potential · on {Hourly/Daily/Weekly} chart · Momentum · Relative Volume · {Support/Resistance} Level` | 55 % a las 09:45–10:00, otra ráfaga a las 15 h | Solo VXX (breakout horario 23,5 a las 09:47 de hoy) | Ruido (VXX como mucho) |
| analyst-grades | 135 (25–27-nov) | `Analyst Grades for {TICKER}` + lista de casas / grado / acción / fecha | 07–11 h, ráfagas de 40/h | No ("ES" = Eversource, no el futuro) | Ruido |
| important-news | 135 (24–27-nov); hoy 41 | `Important News · titular · resumen · Symbol (TICKER) · Today ±% at $ · Research link`. Cadencia fija **cada 10 min (minuto :x1)**. | 06–14 h hoy | No hubo noticia macro; solo acciones (MRVL, STX, SNDK, MU…) | Ruido para 0DTE |

Ejemplos literales (resumidos):
- **[H]** options-sweeps: `Large Call Sweep Order · VOO · 665 · 12/11/2026 · 552.12K · Time 2026-11-27 10:07:44`
- **[H]** darkpool: `SPY Blocktrade · Price 725.675 · Shares 483.4K · Amount 350.79M · Filled NoMatch` (publicado 13:16)
- **[H]** bullseye: `Bearish Stress Bounce Puts · QQQ 650P 15-ene-2027 · $3,203/contrato · Prems 231K · Vol 192 · OI 56,017`
- **[H]** scalps: `Bullish Continuation on 30 Min · TSLA · Entry 399.4 · Long · Target 401.14 · Stop 397.25`

---

## 2. tradytics-bot: evolución del 0DTE GEX de SPX el 27-nov

### 2.1 Cómo leer la imagen `/gexz SPX`
- **[H]** Barras horizontales por strike: verde = GEX 0DTE positivo, rojo = negativo, en millones. El eje Y no es lineal: solo muestra los strikes con barra relevante y rotula uno de cada 2 o 3. Los strikes sin rótulo los inferí por la posición de la fila (marcados "~" en el JSON).
- **[H]** La escala crece durante el día: ±100 M a la apertura, ±1.500 M a las 12:45. Es lo normal al acercarse el vencimiento (la gamma 0DTE se dispara).
- **[H]** **Las imágenes SPX no tienen "Magnet".** Las de SPY sí (`Magnet @`, `2nd Magnet @`). La regla del Magnet no está documentada y **no es** simplemente la barra más grande. Ejemplo: a las 10:14 el Magnet de SPY fue 730 (barra −37) y el 2nd Magnet 718 (−49), con +250 en 720.
- **[I]** No se sabe la convención de signo de Tradytics. Lo más probable es GEX de calls positivo y de puts negativo, por lo que una barra roja grande significa mucho interés en puts en ese strike. No es lo mismo que la "Gamma Flip" de GexBot o Sigma.
- Margen de error de mis lecturas: ±10 % en la magnitud de las barras.

### 2.2 Tabla hora → magnet (barra + máx) / 2.º + / barra − máx → SPX

| Hora post (ET) | SPX en ese minuto | Magnet = barra + máx | 2.ª barra + | Barra − máx (2.ª) | ¿Tocó el magnet en los 30 min siguientes? | Rango SPX en los 30 min siguientes |
|---|---|---|---|---|---|---|
| 09:35 | 7238,0 | 7140 (+38) | 7255 (+34) | **7250 (−94)** | No | 7211–7252 |
| 09:36 | 7250,9 | 7260 (+39) | 7140 (+38) | **7250 (−107)** | No (faltaron 8) | 7211–7252 |
| 09:49 | 7225,9 | **7300 (+66)** | 7200 (+64) | 7250 (−67) | No | 7211–7247 |
| 09:52 | 7231,9 | **7200 (+79)** | 7300 (+66) | 7250 (−67) / 7240 (−34) | No (llegó a 7211,5, faltaron 11) | 7211–7247 |
| 09:59 | 7215,6 | **7300 (+53)** | 7200 (+49) | 7240 (−34) / 7275 (−32) | No | 7211–7251 |
| 10:01 | 7218,2 | 7300 (+53) | 7200 (+49) | **7180 (−65)** | No | 7211–7251 |
| 10:14 | 7238,1 | **7230 (+120)** | 7235 (+81) | **7275 (−95)** / 7180 (−72) | Casi (mínimo 7230,9) | 7231–7275 |
| 10:57 | 7271,8 | **7260 (+352)** | 7230 (+129) | **7265 (−258)** / 7300 (−225) | Sí (mínimo 7257,8) | 7258–7273 |
| 11:28 | 7267,3 | 7260 (+210) | 7230 (+186) | **7300 (−198)** / 7220 (−114) | No | 7267–7295 |
| 11:46 | 7281,0 | **7285 (+668)** | 7265 (+397) | **7300 (−845)** / 7295 (−315) | Sí | 7274–7295 |
| 11:57 (serie horaria) | 7284,5 | 7285 (+820 a las 11 h) | 7265 (+400) | 7300 (−1.250 a las 11 h) | Sí | 7274–7288 |
| 11:59 | 7281,0 | 7285 (+703) | 7265 (+397) | **7300 (−1.190)** | Sí | 7274–7288 |
| 12:19 | 7280,8 | 7285 (+365) | 7265 (+285) | **7300 (−1.295)** / 7280 (−728) / 7270 (−615) | Sí | 7270–7288 |
| 12:45 | 7274,4 | 7285 (+578) | 7265 (+275) | **7300 (−1.500)** / 7290 (−735) / 7275 (−630) | Sí; además rompió 7300 (7304,1 a las 12:59) y cerró en 7297,7 | 7270–7304 |

SPX del día **[H]**: apertura 7262,6 · mínimo 7211,46 (10:05–10:09) · máximo 7304,1 (12:59) · cierre 7297,5.

**Serie horaria `gexz_spx_t` de las 11:57 [H]:** 7300 pasó de +50 (09 h) a −150 (10 h) y a −1.250 (11 h). 7285 pasó de ~0 a +30 y a +820. 7265 de 0 a −250 y a +400. 7295 de 0 a −90 y a +340. 7260 de −20 a +350 y a +290.

### 2.3 SPY 0DTE (con Magnet explícito) → equivalente SPX (ratio ≈10,03, medido con SPY 719,6/728,3 frente a SPX 7211,5/7304,1)

| Hora | Magnet | 2nd Magnet | Barra + máx | Barra − máx | SPX en ese minuto | Magnet en SPX | 2nd Magnet en SPX | ¿Se alcanzó? |
|---|---|---|---|---|---|---|---|---|
| 09:52 | 730 | 717 | 722 (+148) | 717 (−32) | 7231,9 | ≈7322 | ≈7192 | Ninguno (rango 7211–7304) |
| 10:14 | 730 | 718 | 720 (+250) | 718 (−49) | 7238,1 | ≈7322 | ≈7202 | No (el mínimo 7211,5 quedó 10 pts arriba de 7202) |
| 10:33 | 730 | 727 | 722 (+357) | 727 (−51) | 7243,3 | ≈7322 | **≈7292** | **2nd sí**: 7295 a las 11:52; cierre 7297,5 |
| 10:57 | 725 | 730 | 722 (+392) | 725 (−212) | 7271,8 | ≈7272 (= precio actual) | ≈7322 | 725 ya estaba en precio; 730 no |

### 2.4 ¿Los "Magnet" anticiparon el precio?

- **[H]** Magnet SPX (barra + máx) tocado en los 30 min siguientes: **6 de 14** capturas. Las 6 fueron a partir de las 10:57, con el magnet a 0-12 pts del precio. Cuando el magnet estaba lejos (>30 pts: 09:35, 09:49, 09:59, 10:01), **0 de 4** se alcanzaron en 30 min.
- **[H]** Excepción importante: **7300** fue magnet + a las 09:49-10:01, con el SPX en 7215-7226. No llegó en 30 min, pero **sí al final del día** (7304,1 a las 12:59, cierre 7297,5). Después cambió de signo y fue la barra − más grande desde las 10:57. Fue el strike más grande en valor absoluto en 6 de las 14 capturas (todas desde las 09:59 y de forma continua desde las 11:46) y estuvo entre los 3 mayores en 11 de 14.
- **[H]** Barras − grandes y reacción del precio:
  - 7250 (−94 a −107, de 09:35 a 09:52): el precio quedó debajo y no pasó 7252 hasta las 10:20.
  - 7275 (−95 a las 10:14): el precio subió hasta 7281 (10:45) y se devolvió a 7258.
  - 7300 (−198 a −1.500 desde las 11:28): techo hasta las 12:55, rotura de 4 pts y cierre debajo.
- **[H]** SPY Magnet 730 (≈7322) nunca se alcanzó. 2nd Magnet 727 (≈7292) sí, 80 min después. 717/718 (≈7192-7202) no por 10 pts.
- **[I] Conclusión:**
  - La barra + más grande del 0DTE de Tradytics **describe** el pin cuando el precio ya está ahí (11:46-12:45, con 7285 sujetando al SPX entre 7270 y 7295). No es buen predictor a 30 min si está lejos.
  - Lo útil es el **strike con mayor |GEX|** y su persistencia (7300 hoy): marcó el techo y el imán de cierre, igual que el Call Wall 7300 de Sigma.
  - En días de tendencia (25-nov), las barras se quedan atrás: a las 11:19 la barra + máx estaba en ~6920 con el precio en 6995; a las 13:13, en ~7050 con el precio en 7129. **Muestra: 1 día con detalle y 1 de contraste. No sirve para sacar estadística.**
- **[H] Muestra de días previos:**
  - 25-nov 13:00 `gexlevels_spx_all` (todas las expiraciones): **Highest GEX @ 7250, Lowest GEX @ 7000**. Ese 7250 es el Put Wall de Sigma de hoy.
  - 25-nov 10:01 (0DTE): barra + máx ~6950-6960, con el SPX en 7049 (el mínimo 6970 había sido a las 09:45).
  - 25-nov 15:13: barras + máximas ~7200 (+490) y ~7050 (+520); el SPX cerró en 7182,9 (máximo 7199,3 a las 14:32).

### 2.5 Otras imágenes útiles del bot hoy
- **[H] `sr_spy_h` (09:44):** niveles 770,63 / 742,21 / **727,70** / 712,78 / 699,07. 727,70 SPY ≈ **SPX 7299**: techo exacto del día. 712,78 ≈ 7149 (no se tocó).
- **[H] `dplevels_spy` (09:45), $ acumulado en darkpool por nivel:** 713,08 (30,8 B; ≈SPX 7152) · 720,59 (23,6 B; ≈7227) · 750,62 (22,9 B) · 735,61 (19,3 B; ≈7378) · 690,56 (17,7 B) · 728,10 (11,1 B; ≈7303). **[I]** El nivel 720,59 (≈7227) quedó 16 pts encima del mínimo del día y 728,10 (≈7303) coincide con el máximo. Es sugerente, pero es un solo día.
- **[H] `heatmap_iwm_d` (09:43):** prima neta por strike y vencimiento de IWM (p. ej. 250C 18-dic +21,15 M). No es útil para SPX 0DTE.

---

## 3. scalps y bullseye: ideas de trade y resultado

### 3.1 scalps (todas las del volcado)
| Fecha/hora | Símbolo | Setup | Dir. | Entrada | Objetivo | Stop | Resultado (precios Yahoo 1 min) |
|---|---|---|---|---|---|---|---|
| 24-nov 12:42 | STNG | Bearish Continuation, 1 Day | Short | 78,80 | 77,77 | 80,40 | **[H] Ganadora al día siguiente.** El 24-nov no tocó nada (rango 78,66–79,63). El 25-nov tocó el objetivo a las 10:00 (77,75) antes del stop. El máximo del 25 fue 80,38, 2 centavos bajo el stop. |
| 27-nov 11:47 | TSLA | Bullish Continuation, 30 Min | Long | 399,40 | 401,14 | 397,25 | **[H] Perdedora: stop a las 12:51 (397,16)** sin tocar el objetivo. |

### 3.2 bullseye y trady-flow en índices (las de acciones sueltas no se validaron: no hay precio de la opción)
| Fecha/hora | Sím. | Contrato | Prima | Subyacente en la alerta → 27-nov | Lectura |
|---|---|---|---|---|---|
| 23-nov 09:31 | SPY | 690C 18-dic | 827K | 721,34 → 728,32 | [H] Subyacente a favor (+1 %). Sin precio de la opción. |
| 23-nov 10:20 | QQQ | 640C 27-nov | 1,2 M | 655,52 → 650,99 | [H] Vence hoy ITM, pero el subyacente bajó 4,5 pts: probablemente perdedora. |
| 23-nov 09:59 | NDX | 25200P 18-dic (trady-flow) | 51,6 M | 26.688 → 26.726 | [H] Plano; sin resolución. |
| 24-nov 09:32 | QQQ | 620C 27-nov | 182K | 637,56 → 650,99 | [H] A favor; vence ITM por 31. |
| 24-nov 09:36 | UVXY | 25C 27-nov | 127K | 26,36 → 22,92 | [H] Vence OTM: pérdida total. |
| 24-nov 10:24 | SPY | 700C 18-dic | 205K | 716,18 → 728,32 | [H] A favor. |
| 24-nov 10:33 | IWM | 267C 24-nov (0DTE) | 324K | 266,11 → cierre 267,15 | [H] Venció ITM por 0,15. [I] Casi seguro perdedora contra la prima. |
| 24-nov 10:55 | SPY | 716C 24-nov (0DTE) | "13,3 M" (incoherente con "438 contratos") | 715,47 → cierre 718,79 | [H] Venció ITM por 2,79 (SPX ~7165→7201). |
| 25-nov 09:35 | QQQ | 645P 18-dic ("Bearish Stress Bounce") | 1,7 M | 611,98 → 650,99 | [H] **En contra**: +39 pts; el put pasó de ITM a OTM. |
| 27-nov 09:43 | QQQ | 650P 15-ene-27 ("Bearish Stress Bounce") | 231K | 639,51 → 650,99 | [H] **En contra**: compró puts cerca del mínimo de la mañana. |

**[I]** Los setups "Bearish Stress Bounce Puts" (25 y 27-nov) salieron en las aperturas débiles, justo antes de fuertes rebotes alcistas. Tomados como señal intradía para SPX, habrían ido en contra las dos veces (n=2).

---

## 4. Sweeps, golden sweeps, darkpool y flow del 27-nov: sesgo y coincidencia con giros del SPX

**[H] No hubo ningún sweep de SPX, SPXW, SPY, QQQ ni IWM en ningún canal** (ni hoy ni en los días anteriores del volcado). Proxies de índice hoy:
- **VOO** (S&P 500): 665C 11-dic **552K** (trade a las 10:07:44) + 680C 15-ene **278K** (10:07:02). Total **0,83 M en calls, en el minuto del mínimo del día** (SPX 7211,5 entre 10:05 y 10:09).
- **SMH/SOXX** (semis): puts a las 09:48 (SMH 380P 443K, SOXX 130P 284K), cerca del mínimo. Calls a las 12:34-12:50 (SMH 470C ×2 = 830K; 430C 559K) **antes del empujón final** 7270→7304 (12:50-12:59).
- **TQQQ** 45P 18-dic, 465K (12:47).

**Sesgo neto de sweeps (deduplicados; options-sweeps + golden-sweeps), por hora real del trade [H]:**

| Hora ET | Calls (M$) | Puts (M$) | SPX en esa hora |
|---|---|---|---|
| 09 h | 1,77 | **3,01** | Caída 7262 → 7216 |
| 10 h | **7,15** | 5,52 | Mínimo 7211 (10:05-10:09) y subida a 7281 (10:45) |
| 11 h | **5,49** | 1,40 | 7258–7295 |
| 12 h | **6,59** | 1,77 | 7270–7304 |
| **Total** | **21,01 (44 órdenes)** | **11,70 (26)** | Calls 64 % |

- **[H] Racimo de 10:06-10:08 (justo en el mínimo):**
  - Puts: AMD 300P golden (1,16 M + 0,76 M + 0,55 M), NVDA 130P golden 1,25 M, NVDA 143P/120P, META 600P, MSTR, LRCX. Suma ≈5,5 M.
  - Calls: META 620C/650C 1,25 M, NVDA 150C 0,51 M, VOO 0,83 M. Suma ≈2,6 M.
- **[H] Segundo racimo, 10:43-10:47 (casi todo calls):** CRDO, CLS, SNDK 85C 939K, AAPL, AMZN, META 650C, TSM 370C 759K. Coincide con el máximo local 7281 (10:45-10:49), al que siguió una bajada a 7258 (11:10-11:15).
- **[I]** El flujo de sweeps en acciones sueltas **coincide** con los giros, pero no los anticipa. En el mínimo dominaron los puts (cobertura o capitulación), y el racimo de calls de las 10:43 marcó un máximo local. Como señal de entrada intradía para SPX, no aporta ventaja. Como **contexto de sesgo** (calls > puts desde las 11 h), sí acompañó el día alcista.
- **[H] Golden sweeps hoy:** solo 8 (MU 800C 1,14 M a las 09:32; AMD 300P 1,16 M a las 10:08; NVDA 130P 1,25 M a las 10:06; AMD 470C 1,42 M a las 12:24).

**Darkpool / blocks en índices [H]** (precio del print comparado con el precio en el minuto de publicación):

| Publicado | Sím. | Tipo | Precio | Monto | Mercado al publicar | ≈SPX equivalente |
|---|---|---|---|---|---|---|
| 11:47 | QQQ | Darkpool | 645,00 | **403,1 M** | QQQ 646,73 | — |
| 12:21 | SPY | Blocktrade | 726,06 | **239,6 M** | SPY 727,05 | ≈7282 |
| 13:16 | SPY | Blocktrade | 725,675 | **350,8 M** | después del cierre (SPY 728,32) | ≈7279 |
| 13:18 | QQQ | Darkpool | 647,32 | **213,6 M** | después del cierre (QQQ 650,99) | — |

**[I]** Los 4 prints tienen precio por debajo del mercado al publicarse. Probablemente son reportes atrasados (el canal no trae la hora del trade), así que **no sirven para timing**. Los dos de SPY marcan negocio institucional en ≈SPX 7279-7282, la misma zona del magnet 7285. Sirven como nivel de referencia para el lunes.

---

## 5. Conclusión: qué capturar automáticamente y qué no (por prioridad)

**Sí capturar:**

1. **`/gexz SPX` 0DTE (canal tradytics-bot), cada imagen del día.** Campos: hora de publicación (ET), top-3 strikes positivos con valor en M, top-3 negativos con valor, escala máxima del eje y **strike con mayor |GEX|**.
   - Cómo: el nombre del archivo (`gexz_spx_s_AAAA-MM-DD_HH-m`, con m = minuto/3) ya da la hora. Las barras requieren OCR o lectura de imagen. Lo más fiable es leer los píxeles de las barras y los rótulos del eje, ojo con los strikes sin rótulo.
   - Por qué: hoy el strike con mayor |GEX| (7300) dio el techo y el imán de cierre, y el + máximo (7285) dio el pin de 11:46-12:45.
2. **`/gexz SPY`: líneas "Magnet @ X" y "2nd Magnet @ Y"** (texto de la leyenda, fácil de OCR). Convertir a SPX con ratio SPX/SPY del día (≈10,03). Campos: hora, magnet, magnet2, equivalente SPX y distancia al precio. Hoy el 2nd Magnet 727 (≈7292) se cumplió y el Magnet 730 no.
3. **`sr_spy_h` (niveles SR) y `gexlevels_spx_all` (Highest/Lowest GEX @).** Campos: lista de niveles (texto en el gráfico) y Highest/Lowest GEX. Hoy SR 727,70 ≈ 7299 fue el techo exacto. El 25-nov, Highest GEX 7250 = Put Wall de Sigma.
4. **darkpool: solo SPY/QQQ/IWM/DIA con Amount ≥100 M.** Campos: `ticker, clase (Darkpool/Blocktrade), Price, Amount, hora publicación`, más el equivalente SPX. Usarlo como nivel, no como gatillo.
5. **(Contexto, baja prioridad) Suma horaria call/put de options-sweeps + golden-sweeps.** Campos: `Call/Put, Premiums, Time` (hora real del trade). Además, alerta si aparece VOO/SPY/QQQ/SMH/SOXX/TQQQ. Sirve de termómetro de sesgo, no de entrada.

**No capturar (ruido para SPX 0DTE):** scalps (2 ideas en 5 días, ninguna de índices), insider-trades (post-cierre, acciones sueltas), analyst-grades, important-news (sin macro), stock-breakouts (salvo VXX, si se quiere), trady-flow (6 mensajes en 5 días). bullseye solo como lectura de sesgo de varios días: sus puts de índice del 25 y 27-nov fallaron.

**Limitaciones:**
- Un solo día analizado en detalle (media jornada, festivo) más una muestra del 24-25-nov.
- Valores de barras leídos a ojo (±10 %).
- La regla del "Magnet" de Tradytics no es pública.
- Los gráficos `/gexz` dependen de que un miembro los pida: hoy no hubo ninguno entre 10:14 y 10:57 ni después de las 12:45.
- **[I]** Antes de convertir esto en regla hace falta acumular al menos 20-30 días (ver norma "Esperar 50 trades").
