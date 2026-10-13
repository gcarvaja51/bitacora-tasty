@echo off
REM ===================================================================
REM  Bitacora_Informe_Semanal - lanzado por la Tarea Programada de Windows
REM  los viernes a las 16:30 hora Colombia (= 17:30 ET): despues del cierre
REM  y despues del Contador (15:45), para que el ultimo dia ya este asentado.
REM
REM  DOS FASES, mismo patron que el Contador y el Auditor:
REM
REM    Fase 1  informe_semanal.py datos, en Python puro, con Claude APAGADO.
REM            Baja TastyTrade (cuenta real) y Tradier (sandbox) de produccion,
REM            calcula todo y deja JSON + graficos en informes_semanales\<AAAA-Www>\.
REM            Determinista: se puede re-correr y da la misma cifra.
REM
REM    Fase 2  claude -p con la skill informe-semanal: lee los JSON, escribe
REM            la narrativa (veredicto, bueno/malo/feo, seguimiento del plan
REM            anterior, plan nuevo) y corre la fase render, que deja el HTML
REM            y el PDF en informes bitacora\tastytrades y \tradier.
REM
REM  Requiere sesion de usuario activa (modo "Interactive only").
REM ===================================================================

cd /d "C:\Users\gcarv\bitacora-tasty"

set "PY=C:\Users\gcarv\AppData\Local\Programs\Python\Python314\python.exe"
if not exist "%~dp0..\informes_semanales" mkdir "%~dp0..\informes_semanales"
set "LOG=%~dp0..\informes_semanales\ejecuciones.log"
set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"

echo [%DATE% %TIME%] Iniciando informe semanal >> "%LOG%"

REM ---------- FASE 1: el motor determinista ----------
"%PY%" "C:\Users\gcarv\bitacora-tasty\scripts\informe_semanal.py" datos >> "%LOG%" 2>&1
set PASO1=%ERRORLEVEL%

if not "%PASO1%"=="0" (
    echo [%DATE% %TIME%] Fase 1 fallo con codigo %PASO1% - NO se arranca Claude >> "%LOG%"
    goto FIN
)

REM ---------- FASE 2: el agente lee, escribe la narrativa y renderiza ----------
claude --permission-mode acceptEdits --allowedTools "Bash" "Read" "Write" "Edit" "Glob" "Grep" "mcp__whatsapp__whatsapp_enviar" -p "/informe-semanal Ya corri scripts/informe_semanal.py datos: los JSON de la semana estan en informes_semanales/<semana>/. NO vuelvas a correr la fase datos. Haz los pasos 2 a 6 de la skill: lee tasty.json y tradier.json completos, lee los partes del Contador y del Auditor de la semana, califica el plan de la semana anterior, escribe narrativa_tasty.json y narrativa_tradier.json, corre la fase render y revisa los dos PDF. Al final manda el resumen por WhatsApp (mcp__whatsapp__whatsapp_enviar, cuenta colombia, destino 573186252537@s.whatsapp.net), en texto plano: primera linea [INFORME SEMANAL] semana y fechas; luego TASTYTRADE (real) con P&L realizado, NLV inicio y cierre, win rate, la causa en una linea y la accion ALTA mas importante; luego TRADIER (demo) con P&L oficial, P&L del broker, trades, win rate, causa y accion ALTA; ultima linea donde quedaron los PDF. Si algun PDF no se genero, dilo en el mensaje. Manda siempre, aunque la semana haya sido buena." >> "%LOG%" 2>&1

echo [%DATE% %TIME%] Finalizado (codigo %ERRORLEVEL%) >> "%LOG%"

:FIN
echo. >> "%LOG%"
