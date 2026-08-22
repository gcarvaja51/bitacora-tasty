@echo off
REM ===================================================================
REM  Bitacora_Datos — el Ingeniero de Datos. Dos cadencias distintas:
REM
REM    DIARIA   (L-V 16:15 hora Colombia, despues del Contador)
REM             Solo calidad del dato y donde murieron las decisiones.
REM             De lunes a jueves se ANOTA, no se propone: la cadencia del
REM             proyecto pone los ajustes en viernes/sabado para que empiecen
REM             a operar el lunes y se puedan medir limpio.
REM
REM    SEMANAL  (jueves 19:00, con --semana)
REM             Revision de la semana con comparativa contra la anterior, y
REM             UNA propuesta por familia, maximo, con su evidencia.
REM
REM  Se elige con el primer argumento: "semana" o nada.
REM
REM  Requiere sesion de usuario activa (modo "Interactive only").
REM ===================================================================

cd /d "C:\Users\gcarv\bitacora-tasty"

set "PY=C:\Users\gcarv\AppData\Local\Programs\Python\Python314\python.exe"
set "LOG=%~dp0..\datos\ejecuciones.log"
set "PYTHONIOENCODING=utf-8"

set "MODO=%~1"
if /I "%MODO%"=="semana" (
    set "FLAG=--semana"
    set "CONSIGNA=Es la revision SEMANAL del jueves. Haz los pasos 2 a 5 de la skill y ADEMAS el paso 4: formula UNA propuesta por familia como maximo, solo si hay evidencia con numero. Si no la hay, dilo y no propongas: una propuesta sin numero gasta una ventana de cambios. Anota lo que propongas en SUGERENCIAS.md y declaralo en PROPUESTAS dentro de scripts/veredicto_sombra.py para que el Auditor pueda juzgarlo manana; si no existe sombra que pueda contestarla, di que el instrumento es parte de la propuesta."
) else (
    set "FLAG="
    set "CONSIGNA=Es la corrida DIARIA. Haz los pasos 2, 3 y 5 de la skill. NO propongas nada: de lunes a jueves se anota. Si ves algo que merece propuesta, dejalo anotado para la revision del jueves."
)

echo [%DATE% %TIME%] Iniciando Ingeniero de Datos (modo %MODO%) >> "%LOG%"

REM ---------- FASE 1: el motor determinista ----------
"%PY%" "C:\Users\gcarv\bitacora-tasty\scripts\calidad_datos.py" %FLAG% >> "%LOG%" 2>&1
set PASO1=%ERRORLEVEL%

if not "%PASO1%"=="0" (
    echo [%DATE% %TIME%] Fase 1 fallo con codigo %PASO1% - NO se arranca Claude >> "%LOG%"
    goto FIN
)

REM ---------- FASE 2: el agente lee, interpreta y entrega ----------
claude --permission-mode acceptEdits --allowedTools "Bash" "Read" "Write" "Edit" "Glob" "Grep" "mcp__whatsapp__whatsapp_enviar" -p "/ingeniero-datos Ya corri scripts/calidad_datos.py: el parte y el JSON estan en datos/. NO vuelvas a correr el motor. Lee el JSON completo, no solo el parte. %CONSIGNA% Recuerda la frontera: la ejecucion (fills, slippage, costo de cruce) es del Contador y no la repites, y lo que este en paraLaTorre se lo pasas a la Torre de Control sin dictaminarlo. Termina mandando el parte por WhatsApp: cuenta colombia, destino 573186252537@s.whatsapp.net." >> "%LOG%" 2>&1

echo [%DATE% %TIME%] Finalizado (codigo %ERRORLEVEL%) >> "%LOG%"

:FIN
echo. >> "%LOG%"
