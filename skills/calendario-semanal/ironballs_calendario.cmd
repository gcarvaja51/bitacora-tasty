@echo off
REM ===================================================================
REM  Pasa a Google Calendar (color AZUL, colorId 9) las sesiones de Iron Balls
REM  que detecto aviso_ironballs.ps1 y que aun no estan en en_calendario.json.
REM  Lo lanza aviso_ironballs.ps1 (como mucho un intento cada 30 min).
REM  Mismas curas que ejecutar-semanal.cmd: `call` delante de claude, `< nul`,
REM  y que -p espere a que conecte el conector de Google Calendar.
REM ===================================================================
set "DATOS=C:\Users\gcarv\Documents\CARPETA PERSONAL\01. guillermo carvajal\01_Sigma\calendario semanal\ironballs"
set "LOG=%DATOS%\calendario.log"
set "MCP_CONNECTION_NONBLOCKING=0"
set "MCP_CONNECT_TIMEOUT_MS=60000"
set "MCP_TIMEOUT=60000"
cd /d "%DATOS%"
echo [%DATE% %TIME%] Iniciando carga Iron Balls al calendario >> "%LOG%"
call claude --permission-mode acceptEdits --allowedTools "Read" "Write" "ToolSearch" "mcp__claude_ai_Google_Calendar__list_events" "mcp__claude_ai_Google_Calendar__create_event" -p "Carga sesiones de Iron Balls en Google Calendar. En la carpeta donde arrancas estan sesiones.json (objeto: clave 'YYYY-MM-DD HH:MM' en hora de Nueva York -> {fecha, hora_et, titulo, quien, texto}) y en_calendario.json (lista de claves ya cargadas; puede no existir). Para cada sesion de sesiones.json cuya clave NO este en en_calendario.json y que todavia no haya empezado: 1) mira con list_events (fullText 'Iron Balls', ese dia completo, timeZone America/New_York) si ya existe un evento a esa hora; 2) si no existe, create_event con summary = titulo, startTime fecha+'T'+hora_et+':00', endTime una hora despues, timeZone 'America/New_York' (OBLIGATORIO), colorId '9' (azul), notificationLevel 'NONE', sin invitados, description 'Canal Oficial - Iron Balls (WhatsApp, linea usa). Anunciado por <quien>: <texto>. El link de Zoom lo pegan en el canal unos minutos antes; el aviso del PC y del celular lo trae.' Al terminar escribe en_calendario.json con la lista completa (las claves que ya tenia mas las que cargaste o ya existian). Si ToolSearch no encuentra las herramientas de Google Calendar, NO toques en_calendario.json y termina en una linea." < nul >> "%LOG%" 2>&1
echo [%DATE% %TIME%] Fin (codigo %ERRORLEVEL%) >> "%LOG%"
