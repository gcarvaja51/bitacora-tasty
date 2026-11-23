# Material del reel "trade de Emerson · 23-nov-2026"

Todo lo necesario para rehacer el video o hacer otros sobre ese día (pedido de Guillermo: "guardar toda la información
para hacer los videos").

- `video/` — `guion.json` (voz y textos), `render.py` (matplotlib + edge-tts es-CO-GonzaloNeural + ffmpeg) y el MP4 final
  (2:08, 1080x1920). Para rehacerlo: copiar `datos/` a la carpeta padre de `video/` con esta estructura
  (`capas.json`, `hiro.json`, `gexbot_flip_historia.json`, `bola8/bola8_predicciones.json`, `bola8/bola8_1051_1.png`) y
  correr `python render.py` (PRUEBA=1 para fotogramas). El audio se regenera solo.
- `datos/` — SPX 1 min e HIRO propio (`hiro.json`), capas de Discord del día incluidas las reconstruidas (`capas.json`),
  Muros Sigma (`muros.json`, no se usan en el reel), Gamma Flip GB digitalizado, historial de la Bola 8 (texto y las 30
  Sonar ya leídas), `historial_bola8.mjs` y `rellenar_manana.py`. Ver `RECONSTRUIDO.md`.
- `imagenes/` — las 30 "Magic 8-Ball Sonar" de 9:48 a 13:24, el panel de 4 gráficos de las 10:50, y las capturas de la
  tarde con la historia del día (GexBot Classic 15:57, HIRO SpotGamma 15:50, GexBot State 15:50).
- Trade: Bear Call 7260/7265, entrada ≈11:16, TP ≈11:36 (+$55), horas ESTIMADAS (sin grabación de Emerson).
