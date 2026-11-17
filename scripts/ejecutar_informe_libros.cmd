@echo off
REM ===================================================================
REM  Bitacora_Informe_Libros — Tarea Programada, lunes a viernes 16:30
REM  hora Colombia (16:30 ET en invierno, 17:30 ET en verano: siempre
REM  despues del cierre de Nueva York).
REM
REM  Informe diario de los CUATRO libros del Demo Tasty (fase 2 paso 3,
REM  2026-11-16): que trades hizo cada libro y el resultado del dia.
REM
REM    Fase 1  informe_libros.py en Python puro, SIN Claude. Baja
REM            /api/libros/diario, arma el PDF y lo manda por WhatsApp
REM            (linea Colombia, chat propio). Codigo 3 = no es dia de
REM            mercado: no hay informe y no se arranca nada mas.
REM
REM    Fase 2  claude -p SOLO para el correo, con lo ya calculado. No
REM            recalcula ni interpreta: copia el resumen y adjunta el PDF.
REM
REM  SOLO se envia a Guillermo. Requiere sesion de usuario activa.
REM ===================================================================

cd /d "C:\Users\gcarv\bitacora-tasty"

set "PY=C:\Users\gcarv\AppData\Local\Programs\Python\Python314\python.exe"
set "LOG=C:\Users\gcarv\bitacora-tasty\informes_libros\ejecuciones.log"
set "PYTHONIOENCODING=utf-8"
if not exist "C:\Users\gcarv\bitacora-tasty\informes_libros" mkdir "C:\Users\gcarv\bitacora-tasty\informes_libros"

echo [%DATE% %TIME%] Iniciando informe de libros >> "%LOG%"

"%PY%" "C:\Users\gcarv\bitacora-tasty\scripts\informe_libros.py" >> "%LOG%" 2>&1
set PASO1=%ERRORLEVEL%

if "%PASO1%"=="3" (
    echo [%DATE% %TIME%] No es dia de mercado - sin informe >> "%LOG%"
    goto FIN
)
if not "%PASO1%"=="0" (
    echo [%DATE% %TIME%] Fase 1 fallo con codigo %PASO1% - NO se manda correo >> "%LOG%"
    goto FIN
)

call claude --permission-mode acceptEdits --allowedTools "Bash" "Read" "ToolSearch" "mcp__claude_ai_Gmail__send_message" -p "Informe diario de los 4 libros del Demo Tasty: ya esta generado y enviado por WhatsApp. Tu UNICA tarea es mandar el correo. 1) Lee C:\Users\gcarv\bitacora-tasty\informes_libros\ultimo.txt: trae la ruta base del informe de hoy; el resumen esta en <base>.txt y el PDF en <base>.pdf. 2) Envia UN correo con mcp__claude_ai_Gmail__send_message (cargala con ToolSearch si hace falta) SOLO a guillermo.alu@gmail.com, sin copia a nadie, asunto 'Demo Tasty - informe diario <fecha del resumen>', htmlBody = el resumen tal cual (una linea por libro, los avisos debajo de su libro), sin agregar analisis, sin recalcular y sin sumar los saldos de los libros. Adjunta el PDF con la referencia sha256:<hash>:<ruta absoluta con /> (hash con sha256sum). Si el adjunto falla, reenvia sin adjunto diciendo que el PDF llego por WhatsApp. 3) Responde en una linea: correo ok / sin adjunto / fallo. No hagas nada mas." >> "%LOG%" 2>&1

echo [%DATE% %TIME%] Finalizado (codigo %ERRORLEVEL%) >> "%LOG%"

:FIN
echo. >> "%LOG%"
