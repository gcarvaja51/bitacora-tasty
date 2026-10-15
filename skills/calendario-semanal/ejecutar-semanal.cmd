@echo off
REM ===================================================================
REM  Sigma_Calendario_Semanal - lanzado por la Tarea Programada de Windows
REM  lunes, martes y miercoles a las 11:00am (hora Colombia).
REM
REM  TRES FASES, igual que el mananero: la espera va FUERA de Claude.
REM
REM    Fase 1  agenda.py esperar, Python puro. Si la semana ya esta cargada
REM            sale al instante (por eso el martes y el miercoles no cuestan
REM            nada). Si es lunes festivo en NY no busca: la agenda sale el
REM            martes. Si la agenda no esta, mira cada hora hasta las 20:00.
REM
REM    Fase 2  claude -p, solo si la fase 1 dejo la agenda en disco. Crea los
REM            eventos en Google Calendar y escribe <lunes>_cargada.json.
REM
REM    Fase 3  agenda.py cerrar, Python puro: parte a Guillermo por WhatsApp.
REM
REM  El `call` delante de claude NO es adorno: sin el, claude.cmd no vuelve
REM  y la fase 3 no corre nunca (paso con el mananero, 2026-08-31).
REM  Requiere sesion de usuario activa (modo "Interactive only").
REM ===================================================================

cd /d "%~dp0"

set "PY=C:\Users\gcarv\AppData\Local\Programs\Python\Python314\python.exe"
set "LOG=%~dp0ejecuciones.log"
set "DATOS=C:\Users\gcarv\Documents\CARPETA PERSONAL\01. guillermo carvajal\01_Sigma\calendario semanal"
set "PYTHONIOENCODING=utf-8"

echo [%DATE% %TIME%] Iniciando calendario semanal >> "%LOG%"

"%PY%" -W ignore "%~dp0agenda.py" esperar --hasta 20 >> "%LOG%" 2>&1
set PASO1=%ERRORLEVEL%
if not "%PASO1%"=="0" (
    echo [%DATE% %TIME%] Fase 1 termino con codigo %PASO1% - NO se arranca Claude >> "%LOG%"
    goto FIN
)

REM  Claude arranca en la carpeta de datos (fuera de .claude): dentro de .claude
REM  no puede escribir su _cargada.json, es carpeta protegida (2026-09-28).
REM  El `< nul` evita la espera de 3 s por stdin.
REM
REM  HASTA 3 INTENTOS: el conector de Google Calendar de claude.ai a veces no
REM  carga en una sesion -p (en la segunda prueba del 2026-09-28 no aparecio y
REM  en la primera si; a offside e interesados les pasa igual con Gmail). Si
REM  Claude no deja el _cargada.json, se espera 2 min y se relanza.
REM  `ping` en vez de `timeout`: sin consola, timeout falla al instante.
REM  Y que -p ESPERE a que conecten los conectores antes del primer turno
REM  (por defecto conectan en segundo plano y Claude puede arrancar sin ellos).
set "MCP_CONNECTION_NONBLOCKING=0"
set "MCP_CONNECT_TIMEOUT_MS=60000"
set "MCP_TIMEOUT=60000"
set INTENTO=0
:CLAUDE
set /a INTENTO+=1
echo [%DATE% %TIME%] Fase 2, intento %INTENTO% de 3 >> "%LOG%"
cd /d "%DATOS%"
call claude --permission-mode acceptEdits --allowedTools "Read" "Write" "Glob" "ToolSearch" "mcp__claude_ai_Google_Calendar__list_events" "mcp__claude_ai_Google_Calendar__create_event" -p "/calendario-semanal La agenda de esta semana YA ESTA en disco: la fase 1 la bajo del grupo antes de arrancarte, asi que NO leas WhatsApp. Busca en la carpeta semanas\ (dentro de la carpeta donde arrancas) el archivo <lunes>_agenda.json de la semana en curso (y el .txt con el texto original, para comprobar que el JSON lo leyo bien). Corre SOLO el paso 3 de la ficha: carga las sesiones en Google Calendar con timeZone America/New_York, sin invitados, notificationLevel NONE, sin duplicar lo que ya este, y termina escribiendo semanas\<lunes>_cargada.json con el formato de la ficha. Si ToolSearch no encuentra las herramientas de Google Calendar, NO escribas el _cargada.json y termina en una linea: la tarea te relanza sola. No mandes nada por WhatsApp: el parte lo manda la fase 3." < nul >> "%LOG%" 2>&1
cd /d "%~dp0"
"%PY%" -W ignore "%~dp0agenda.py" hecha
if not errorlevel 1 goto CERRAR
if %INTENTO% GEQ 3 goto CERRAR
echo [%DATE% %TIME%] Claude no dejo el _cargada.json - reintento en 2 min >> "%LOG%"
ping -n 121 127.0.0.1 > nul
goto CLAUDE

:CERRAR
echo [%DATE% %TIME%] Fase 2 terminada tras %INTENTO% intento(s) >> "%LOG%"

"%PY%" -W ignore "%~dp0agenda.py" cerrar >> "%LOG%" 2>&1
echo [%DATE% %TIME%] Finalizado (codigo %ERRORLEVEL%) >> "%LOG%"

:FIN
echo. >> "%LOG%"
