@echo off
REM ===================================================================
REM  Bitacora_Torre_Intradia — la Torre de Control.
REM  Cada 30 minutos en horario de mercado (L-V 08:30 a 15:00 Colombia).
REM
REM  LA CLAVE DE ESTE LANZADOR: si todo esta verde, NO ARRANCA CLAUDE.
REM
REM  Corre ~13 veces al dia. Gastar una sesion cada media hora para que diga
REM  "todo bien" seria absurdo, y ademas contraproducente: un vigilante que
REM  escribe cuando no pasa nada entrena a que se dejen de leer sus avisos.
REM
REM  El motor sale con codigo 0 (verde), 1 (ambar) o 2 (rojo). Claude solo se
REM  arranca cuando hay algo que diagnosticar, que es cuando su criterio vale.
REM
REM  Con "frenos" como argumento agrega la revision de los limites de riesgo
REM  (una vez por semana, viernes). OJO: verifica que esten CONFIGURADOS y
REM  cuanto margen queda, NO que disparen. Probar que un freno frena exige un
REM  simulacro deliberado que todavia no existe.
REM
REM  Requiere sesion de usuario activa (modo "Interactive only").
REM ===================================================================

cd /d "C:\Users\gcarv\bitacora-tasty"

set "PY=C:\Users\gcarv\AppData\Local\Programs\Python\Python314\python.exe"
set "LOG=%~dp0..\vigilancia\ejecuciones.log"
set "PYTHONIOENCODING=utf-8"

set "FLAG="
if /I "%~1"=="frenos" set "FLAG=--frenos"

"%PY%" "C:\Users\gcarv\bitacora-tasty\scripts\vigilancia.py" %FLAG% >> "%LOG%" 2>&1
set NIVEL=%ERRORLEVEL%

if "%NIVEL%"=="0" (
    REM Verde. Ni una linea mas, ni una sesion de Claude. El silencio es el parte.
    goto FIN
)

if "%NIVEL%"=="2" (
    set "URGENCIA=Es ROJO: el robot no puede operar o esta operando con datos malos. Avisa por WhatsApp de inmediato, antes de terminar el analisis."
) else (
    set "URGENCIA=Es AMBAR: algo esta degradado pero se puede operar. Avisa por WhatsApp solo si el incidente es nuevo o se agravo respecto de vigilancia/historico.jsonl; si es el mismo de la corrida anterior, no repitas."
)

echo [%DATE% %TIME%] Incidente nivel %NIVEL% - escalando a Claude >> "%LOG%"

claude --permission-mode acceptEdits --allowedTools "Bash" "PowerShell" "Read" "Grep" "mcp__whatsapp__whatsapp_enviar" -p "/torre-control La vigilancia detecto un incidente. El detalle esta en vigilancia/ultimo.json y el historial en vigilancia/historico.jsonl. NO vuelvas a correr el motor. %URGENCIA% Diagnostica la CAUSA RAIZ, que es la parte del puesto que no existe si no la escribes: que se rompio, desde cuando, que lo causo y que queda bloqueado. Si el dato esta mal pero el sistema esta sano, eso es del Ingeniero de Datos: se lo pasas, no lo dictaminas. Si hace falta pausar entradas, puedes hacerlo y lo dices de inmediato con la evidencia; nunca operes ni reinicies nada que no hayas entendido primero. WhatsApp: cuenta colombia, destino 573186252537@s.whatsapp.net." >> "%LOG%" 2>&1

echo [%DATE% %TIME%] Finalizado (codigo %ERRORLEVEL%) >> "%LOG%"

:FIN
