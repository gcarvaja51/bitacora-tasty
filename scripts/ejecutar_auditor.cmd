@echo off
REM ===================================================================
REM  Bitacora_Auditor_Semanal — lanzado por la Tarea Programada de Windows
REM  los viernes a las 08:00 hora Colombia, ANTES de la ventana de cambios
REM  (viernes/sabado). El orden importa: el veredicto tiene que existir antes
REM  de que nadie mueva una perilla, no despues.
REM
REM  DOS FASES:
REM
REM    Fase 1  veredicto_sombra.py en Python puro, con Claude APAGADO. Corre
REM            cada propuesta del backlog contra el libro sombra y calcula los
REM            intervalos de confianza. Es determinista y se puede correr a
REM            mano para verificar cualquier veredicto.
REM
REM    Fase 2  claude -p, solo si la fase 1 dejo el veredicto escrito. El agente
REM            lee, cruza contra lo ya aplicado y entrega el parte.
REM
REM  EL AUDITOR NO PROPONE. Si en la corrida se le ocurre una idea mejor, va
REM  como observacion al backlog por la via del Ingeniero de Datos, nunca como
REM  propuesta suya: quien propone no puede juzgar.
REM
REM  Requiere sesion de usuario activa (modo "Interactive only").
REM ===================================================================

cd /d "C:\Users\gcarv\bitacora-tasty"

set "PY=C:\Users\gcarv\AppData\Local\Programs\Python\Python314\python.exe"
set "LOG=%~dp0..\veredictos\ejecuciones.log"
set "PYTHONIOENCODING=utf-8"

echo [%DATE% %TIME%] Iniciando veredicto del Auditor >> "%LOG%"

REM ---------- FASE 1: el motor determinista ----------
"%PY%" "C:\Users\gcarv\bitacora-tasty\scripts\veredicto_sombra.py" >> "%LOG%" 2>&1
set PASO1=%ERRORLEVEL%

if not "%PASO1%"=="0" (
    echo [%DATE% %TIME%] Fase 1 fallo con codigo %PASO1% - NO se arranca Claude >> "%LOG%"
    goto FIN
)

REM ---------- FASE 1b: el segundo dominio, el PREMERCADO SPX ----------
REM Lee el log de hipotesis del premercado y recalcula el acierto desde los
REM hechos, sin creerle a la nota que el propio premercado se puso. No bloquea:
REM si este motor falla, el veredicto de la Bitacora sigue saliendo igual — son
REM dominios independientes y uno caido no puede tumbar al otro.
"%PY%" "C:\Users\gcarv\bitacora-tasty\scripts\veredicto_premercado.py" >> "%LOG%" 2>&1
if not "%ERRORLEVEL%"=="0" echo [%DATE% %TIME%] Fase 1b (premercado) fallo - se sigue sin ella >> "%LOG%"

REM ---------- FASE 2: el agente lee, cruza y entrega ----------
claude --permission-mode acceptEdits --allowedTools "Bash" "Read" "Write" "Glob" "Grep" "mcp__whatsapp__whatsapp_enviar" -p "/auditor Ya corri scripts/veredicto_sombra.py: el veredicto y el JSON estan en veredictos/. NO vuelvas a correr el motor. Haz los pasos 2 a 5 de la skill: lee el JSON completo, revisa si alguna senal en observacion se viene sosteniendo respecto de los veredictos de semanas anteriores en veredictos/, y haz el paso 4 —cruzar lo ya aplicado contra /api/spx/version-stats bloque comparable— para ver si la sombra le esta acertando a la muestra en vivo. Entregame el parte final. Ademas ya corri scripts/veredicto_premercado.py: el parte del segundo dominio esta en veredictos/parte_premercado_<fecha>.txt y su JSON al lado — leelo y entrega TAMBIEN el parte del dominio PREMERCADO, siguiendo el paso 6 de la skill. Recuerda: no propones nada, y nunca recomiendes aplicar dos propuestas de nivel alto sobre la misma familia en la misma ventana. Termina mandandolo por WhatsApp: cuenta colombia, destino 573186252537@s.whatsapp.net. Manda aunque no haya ningun veredicto concluyente." >> "%LOG%" 2>&1

echo [%DATE% %TIME%] Finalizado (codigo %ERRORLEVEL%) >> "%LOG%"

:FIN
echo. >> "%LOG%"
