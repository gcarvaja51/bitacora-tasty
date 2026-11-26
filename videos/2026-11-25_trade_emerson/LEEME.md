# Material del reel "trade de Emerson · 25-nov-2026" (salida por stop)

Todo lo necesario para rehacer el video o hacer otros sobre ese día.

- Trade: **Bear Call 6995/7000**, crédito 2,60. Entrada **11:12** (SPX 6994,55), stop **11:26** (SPX 7024,28), −$75 por contrato.
  Breakeven 6997,60, stop en 7017. Horas EXACTAS (grabación propia del Zoom, reloj real).
- Comunidad (chat Zoom + chat VIP, de `IRON BALLS - informes/informes emerson/scripts/dias.py`): 34 reportaron, −$865 en total.
  14 ganaron +$630 (tomaron ganancia en el piso de 6.990, prom. +$45), 19 perdieron −$1.495 (mantuvieron buscando 6.980 y
  salieron por stop, prom. −$79), 1 en cero.
- Enviado el 26-nov a Emerson, Pipe y Alejandro Iron Balls (línea Colombia), versión v3 de 4:56. No publicado en Instagram.
- Reglas de redacción que pidió Guillermo: tercera persona, nunca "error" (se dice "aprendizaje"), alternar "Emerson" y "el profe",
  narrar los títulos "El aprendizaje" y "La lección"; inicia con "Análisis del trade del 25 de noviembre de 2026, donde se salió por stop".

## Carpetas
- `video/` — `guion.json` (voz y textos, 14 escenas), `render.py` (matplotlib + edge-tts es-CO-GonzaloNeural + ffmpeg; escribe
  `reel_..._cuerpo.mp4`), `escenas_25.py` (las funciones de escena, ya pegadas dentro de render.py), `envolver_marca.py`
  (pega la marca Iron Balls al inicio y al final) y el MP4 final (4:56, 1080x1920).
- `datos/` — `datos.json` (lo que lee el render: SPX 1 min, HIRO propio, Gamma Flip GB, GexBot, State, Tradytics, Bola 8,
  curva HIRO SpotGamma), `armar_datos.py` (lo arma desde `discord/2026-11-25/confluencia.jsonl` de esta rama y
  `hiro_2026-11-25.json`, velas de la bitácora `/api/hiro`; el OCR lee 7 como 4 → se suma 3000 a todo nivel < 5000),
  `quantdata_releido_1037_1130.json` (Quant Data re-leído: el OCR se cayó por timeouts de 10:37 a 12:25),
  `historial_2026-11-25.jsonl` (GEX propio) y `chat_zoom_2026-11-25.txt`.
- `clips/` — audio ORIGINAL de Emerson (`clip_entrada.wav` 11:12:01, 16 s; `clip_stop.wav` 11:26:27, 21 s) y los cuadros de
  pantalla comprimidos en `c_entrada.mp4` (128 cuadros) y `c_stop.mp4` (168).
- `imagenes/` — Bola 8 (Sonar + paneles) de 10:01 a 11:47 ET (nombre en hora UTC), GexBot Classic 11:09 y 15:44 (historia
  del día), State 11:08/11:10, Tradytics 11:04, Option Flow 11:12, HIRO 11:24, 11:45 y 15:46.
- `marca/` — `marca_inicio.mp4` y `marca_final.mp4` (9,4 s c/u, ya armados), `rayo_logo_ib.mp4` (video de Iron Balls del 18-nov
  del grupo "Operaciones by Iron Balls"; se usan sus primeros 1,6 s y luego se congela con zoom hasta 1,38) y
  `cancion_ironballs.mp3` (la canción de Iron Balls que suena al inicio de cada sesión de Emerson; sacada de la transmisión de
  YouTube del 25-nov, id qIKdCLPG74w, del segundo 25 al 215). En este mp3: coro de inicio desde 80,8 s, coro de cierre desde
  91,6 s ("…te muestro la curva, Iron Balls, Iron Balls, resultados reales, cada semana").

## Para rehacerlo
1. Armar una carpeta `X/` con `X/datos.json`, `X/clips/` (los wav) y `X/video/` (`guion.json`, `render.py`,
   `envolver_marca.py`, y `marca/` con `marca_inicio.mp4` y `marca_final.mp4`).
2. Volver a sacar los cuadros: `ffmpeg -i clips/c_entrada.mp4 X/clips/c_entrada/%04d.png` (igual con `c_stop`).
3. `render.py` lee la Sonar y el logo con ruta absoluta (`gexbot-sombra/capturas/2026-11-25/bola8_202611251601_sonar.png` y
   `IRON BALLS - informes/informes emerson/scripts/marca/ironballs-traders-logo-web.png`): si no existen, apuntar la Sonar a
   `imagenes/bola8_202611251601_sonar.png`.
4. `python render.py` (PRUEBA=1 → un PNG por escena) y luego `python envolver_marca.py`. La voz se regenera sola; ~15 min.
