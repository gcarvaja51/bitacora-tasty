@echo off
REM ===================================================================
REM  Bitacora_Contador_Diario — lanzado por la Tarea Programada de Windows
REM  de lunes a viernes a las 15:45 hora Colombia (= 16:45 ET, 45 minutos
REM  despues del cierre, para que la reconciliacion ya haya asentado).
REM
REM  DOS FASES, y el orden importa:
REM
REM    Fase 1  cierre_diario.py en Python puro, con Claude APAGADO. Baja las
REM            ejecuciones de produccion y calcula. Es determinista: el mismo
REM            dia da siempre el mismo numero, y se puede correr a mano para
REM            verificar cualquier cifra que despues reporte el agente.
REM            Cuesta cero en tokens.
REM
REM    Fase 2  claude -p, solo si la fase 1 dejo el parte escrito. El agente
REM            LEE lo calculado, agrega criterio y entrega. Si la fase 1 fallo
REM            no se arranca Claude siquiera: no hay nada que interpretar.
REM
REM  --allowedTools no es opcional: sin el, la sesion automatica no puede
REM  EJECUTAR nada. Es el mismo tropiezo que costo una corrida del mananero
REM  el 2026-08-19.
REM
REM  Requiere sesion de usuario activa (modo "Interactive only").
REM ===================================================================

cd /d "C:\Users\gcarv\bitacora-tasty"

set "PY=C:\Users\gcarv\AppData\Local\Programs\Python\Python314\python.exe"
set "LOG=%~dp0..\cierres\ejecuciones.log"
set "PYTHONIOENCODING=utf-8"

echo [%DATE% %TIME%] Iniciando cierre del Contador >> "%LOG%"

REM ---------- FASE 1: el motor determinista ----------
"%PY%" "C:\Users\gcarv\bitacora-tasty\scripts\cierre_diario.py" >> "%LOG%" 2>&1
set PASO1=%ERRORLEVEL%

if not "%PASO1%"=="0" (
    echo [%DATE% %TIME%] Fase 1 fallo con codigo %PASO1% - NO se arranca Claude >> "%LOG%"
    goto FIN
)

REM ---------- FASE 2: el agente lee y entrega ----------
claude --permission-mode acceptEdits --allowedTools "Bash" "Read" "Write" "Glob" "Grep" "mcp__whatsapp__whatsapp_enviar" -p "/contador Ya corri scripts/cierre_diario.py: el parte y el JSON del dia estan en cierres/. NO vuelvas a correr el motor. Haz los pasos 2 a 5 de la skill: lee el JSON completo del dia (no solo el parte), revisa rojo y ambar, mira si algun ambar se viene repitiendo en los dias anteriores de cierres/historico.jsonl, y entregame el parte final. Si hay algo en rojo, marcalo como posible correccion y dilo primero. Si el estado es verde y no hay nada que agregar, entrega el parte tal cual esta. Termina mandandolo por WhatsApp como dice el paso 5: cuenta colombia, destino 573186252537@s.whatsapp.net. Manda aunque el estado sea verde." >> "%LOG%" 2>&1

echo [%DATE% %TIME%] Finalizado (codigo %ERRORLEVEL%) >> "%LOG%"

:FIN
echo. >> "%LOG%"
