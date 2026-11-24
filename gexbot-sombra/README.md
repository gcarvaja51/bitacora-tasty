# gexbot-sombra (copia versionada)

Bot que barre los escenarios de Discord (GexBot Classic/State, HIRO, Tradytics, Option Flow, Bola 8), los lee por OCR
(`lector.py`), calcula la confluencia en sombra (`confluencia.py`), dibuja en TradingView (`tv_dibujar.mjs`) y empuja las
capas a la bitácora (`POST /api/capas/discord`).

**Lo que corre en producción está en** `01. Trading\01. Pipe\gexbot-sombra\` (Tarea Programada `GexBot_Confluencia_Sombra`).
Esta carpeta es la copia versionada del código: al cambiar algo allí, copiarlo aquí y hacer commit.

No se versionan: capturas, `discord_profile`, logs, `.bitacora_token`, `trades_reales`, jsonl de historial.
