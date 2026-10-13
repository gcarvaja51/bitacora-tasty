@echo off
REM ===================================================================
REM  Cierre_del_Dia_SPX - lanzado por la Tarea Programada de Windows
REM  de lunes a viernes a las 16:00 HORA DE NUEVA YORK (pedido de
REM  Guillermo 2026-09-24: "16 hora nueva york, despues del cierre").
REM
REM  Windows programa en hora Colombia (sin horario de verano) y NY si
REM  cambia: la tarea dispara a las 15:00 y a las 16:00 locales y este
REM  script solo sigue si en NY son las 16 (Python zoneinfo; TZ= no
REM  sirve en esta maquina).
REM
REM  Genera "documentos premercado\<MMDDAAAA>_cierre del dia.docx" y
REM  anota resultado + llamada_siguiente en el log y el Excel. NO toca
REM  el premercado. Los feriados NYSE los descarta la propia rutina.
REM
REM  EL `call` NO ES ADORNO: `claude` resuelve a `claude.cmd`, y en
REM  Windows un .cmd que invoca otro .cmd SIN `call` nunca vuelve.
REM ===================================================================

python -c "from datetime import datetime;from zoneinfo import ZoneInfo;import sys;sys.exit(0 if datetime.now(ZoneInfo('America/New_York')).hour==16 else 1)"
if errorlevel 1 exit /b 0

cd /d "C:\Users\gcarv\Documents\CARPETA PERSONAL\01. guillermo carvajal\01_Sigma\mentoria alejandro\premercados alejandro"

set "LOG=%~dp0ejecuciones.log"

echo [%DATE% %TIME%] Iniciando cierre del dia >> "%LOG%"

call claude --chrome --permission-mode acceptEdits --allowedTools "Bash" "PowerShell" "Read" "Write" "Edit" "Glob" "Grep" "ToolSearch" "WebSearch" "mcp__claude-in-chrome__tabs_context_mcp" "mcp__claude-in-chrome__tabs_create_mcp" "mcp__claude-in-chrome__tabs_close_mcp" "mcp__claude-in-chrome__navigate" "mcp__claude-in-chrome__find" "mcp__claude-in-chrome__get_page_text" "mcp__claude-in-chrome__javascript_tool" "mcp__claude-in-chrome__browser_batch" -p "/cierre-del-dia Genera el informe Cierre del dia de HOY siguiendo el skill al pie de la letra. Primero pregunta a C:\Users\gcarv\bitacora-tasty\src\calendario_nyse (esDiaDeMercado) si hoy hubo mercado: si no, escribe una linea en el log y termina sin crear nada. Si el .docx de hoy ya existe, no lo sobrescribas y termina. Corre a las 16:00 ET: la lectura de Sigma del cierre sale ~16:05 ET, asi que usa el lastLevels mas reciente de status.json y di su hora. Usa el ultimo script de scripts\ como molde de formato (ojo con el \0 en las rutas: usa os.path.join). Revisa en Investing tambien la pestana Hoy por si aparecio un 3 estrellas a las 10:15 ET o despues que el premercado no tenia (D19). No envies nada a nadie; solo Word, nunca PDF. Nunca lances TradingView ni le cambies el simbolo." >> "%LOG%" 2>&1

echo [%DATE% %TIME%] Finalizado (codigo %ERRORLEVEL%) >> "%LOG%"
echo. >> "%LOG%"
