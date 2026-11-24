# Material del reel "trade de Emerson · 24-nov-2026"

Todo lo necesario para rehacer el video o hacer otros sobre ese día.

- Trade: **Bear Call 7160/7165**. Entrada **11:27** (SPX 7164,55), TP **11:42** (SPX 7146,30), breakeven 7162,55.
  Horas EXACTAS (grabación propia del Zoom, reloj real). 51 personas reportaron, USD 2.905 en total (chat Zoom + VIP).
- Enviado el 24-nov a Emerson, Pipe y Alejandro Iron Balls (línea Colombia). No publicado en Instagram.

## Carpetas
- `video/` — `guion.json` (voz y textos), `render.py` (matplotlib + edge-tts es-CO-GonzaloNeural + ffmpeg) y el MP4
  final (2:56, 1080x1920).
- `datos/` — `datos.json` (SPX 1 min, Gamma Flip GB por ciclo, GexBot, State, Tradytics, Option Flow, curva HIRO,
  Bola 8: lo que lee el render), `confluencia.jsonl` y `barridos.jsonl` del bot de Discord, `historial_2026-11-24.jsonl`
  (GEX propio por strike), `muros_sigma.json` (Muros/Gamma Flip de Sigma Terminal del día, no se usan en el reel).
- `clips/` — audio ORIGINAL de Emerson (`clip_entrada.wav`, `clip_tp.wav`; no se regenera), `m_e.wav`/`m_t.wav`,
  imágenes de los clips y los cuadros de pantalla comprimidos en `c_entrada.mp4` (209 cuadros) y `c_tp.mp4` (307).
- `imagenes/` — Bola 8 (Sonar + 4 paneles) de 10:01 a 11:46 ET (nombre en hora UTC), GexBot Classic de la entrada
  (11:21) y de la tarde (14:46, con la historia del día), HIRO 14:41, State 14:46, Option Flow 13:18, Tradytics 13:25.

## Para rehacerlo
1. Armar una carpeta `X/` con `X/datos.json` (de `datos/`), `X/clips/` (los wav y png de `clips/`) y `X/video/`
   (`guion.json` y `render.py`).
2. Volver a sacar los cuadros: `ffmpeg -i clips/c_entrada.mp4 X/clips/c_entrada/%04d.png` (igual con `c_tp`).
3. `render.py` lee la Sonar con ruta absoluta (`gexbot-sombra/capturas/2026-11-24/bola8_202611241531_sonar.png`):
   si no existe, apuntarla a `imagenes/bola8_202611241531_sonar.png`.
4. `python render.py` (PRUEBA=1 → un PNG por escena). La voz se regenera sola; tarda ~15 min.
