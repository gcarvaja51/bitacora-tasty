@echo off
REM ===================================================================
REM  GexBot_Confluencia_Sombra - Tarea Programada, lunes a viernes 8:15am hora Colombia
REM  (el loop espera solo hasta las 9:25 ET y termina a las 16:05 ET).
REM  Creado 2026-11-19: barrido del Discord de Iron Balls cada 3 min + confluencia en sombra
REM  + dibujo en TradingView. NO opera. Ver DICCIONARIO_GEXBOT.md y confluencia.py.
REM ===================================================================
cd /d "%~dp0"
echo [%DATE% %TIME%] Inicio >> "%~dp0confluencia_tarea.log"
REM 23-nov: chequeo de la sesion de Discord al arrancar (8:15): si esta cerrada, aviso por WhatsApp para reloguear antes de 9:25
node barrido_discord.mjs --chequeo >> "%~dp0confluencia_tarea.log" 2>&1
python confluencia.py --loop 180 >> "%~dp0confluencia_tarea.log" 2>&1
echo [%DATE% %TIME%] Fin (codigo %ERRORLEVEL%) >> "%~dp0confluencia_tarea.log"
REM 21-nov: historicos para backtesting -> rama "historicos" de bitacora-tasty (no toca main ni reinicia el robot)
python guardar_historicos.py >> "%~dp0confluencia_tarea.log" 2>&1
