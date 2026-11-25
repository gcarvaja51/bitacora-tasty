@echo off
REM ===================================================================
REM  GexBot_Confluencia_Sombra - Tarea Programada, lunes a viernes 8:15am hora Colombia
REM  Creado 2026-11-19: Discord de Iron Balls + confluencia en sombra + dibujo en TradingView. NO opera.
REM  24-nov-2026: captura CONTINUA (0 DTE / scalping, "cada minuto cuenta"):
REM    - barrido_discord.mjs --continuo (segundo plano): un solo navegador todo el dia, cambia de canal sin
REM      recargar Discord; espera solo hasta las 9:25 ET y termina al cierre + 2 min.
REM    - confluencia.py --continuo: lee cada 10 s las capturas nuevas; termina al cierre + 5 min.
REM  Antes (respaldo_2026-11-24\): confluencia.py --loop 180 lanzaba un barrido nuevo en cada ciclo.
REM ===================================================================
cd /d "%~dp0"
echo [%DATE% %TIME%] Inicio >> "%~dp0confluencia_tarea.log"
REM 23-nov: chequeo de la sesion de Discord al arrancar (8:15): si esta cerrada, aviso por WhatsApp para reloguear antes de 9:25
node barrido_discord.mjs --chequeo >> "%~dp0confluencia_tarea.log" 2>&1
REM 24-nov: capturador continuo en segundo plano (no bloquea). Si hay otro Chromium con discord_profile, no arranca.
start "" /b cmd /c "node barrido_discord.mjs --continuo >> barrido_continuo.log 2>&1"
python confluencia.py --continuo >> "%~dp0confluencia_tarea.log" 2>&1
echo [%DATE% %TIME%] Fin (codigo %ERRORLEVEL%) >> "%~dp0confluencia_tarea.log"
REM el capturador debio salir solo tras el cierre; si sigue vivo se cierra SOLO ese node y el Chromium de discord_profile
python confluencia.py --limpiar-capturador >> "%~dp0confluencia_tarea.log" 2>&1
REM 21-nov: historicos para backtesting -> rama "historicos" de bitacora-tasty (no toca main ni reinicia el robot)
python guardar_historicos.py >> "%~dp0confluencia_tarea.log" 2>&1
REM 24-nov (Guillermo: "hazlo de una vez"): fotos de Discord de mas de 5 dias -> MEGA /Bitacora/gexbot-capturas (verifica y recien borra del PC)
python archivar_mega.py >> "%~dp0confluencia_tarea.log" 2>&1
