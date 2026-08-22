@echo off
REM ===================================================================
REM  Bitacora_Secretario — el registro. Dos momentos:
REM
REM    ACTA     (L-V 16:30 hora Colombia, despues del Contador y de Datos)
REM             Junta los partes de los cinco y deja las decisiones como
REM             preguntas de si o no.
REM
REM    DERIVA   (sabados 09:00, con "deriva")
REM             Repasa produccion contra el canario y contra el manual. Un
REM             parametro que se movio sin quedar anotado hace que todo lo que
REM             se midio despues sea sobre otra cosa.
REM
REM  El acta corre SIEMPRE, aunque no haya novedades: un dia sin acta no se
REM  distingue de un dia en que la rutina no corrio.
REM
REM  Requiere sesion de usuario activa (modo "Interactive only").
REM ===================================================================

cd /d "C:\Users\gcarv\bitacora-tasty"

set "PY=C:\Users\gcarv\AppData\Local\Programs\Python\Python314\python.exe"
set "LOG=%~dp0..\actas\ejecuciones.log"
set "PYTHONIOENCODING=utf-8"

set "MODO=%~1"

echo [%DATE% %TIME%] Iniciando Secretario (modo %MODO%) >> "%LOG%"

if /I "%MODO%"=="deriva" goto DERIVA

REM ---------- ACTA: primero la deriva del dia, luego el consolidado ----------
"%PY%" "C:\Users\gcarv\bitacora-tasty\scripts\deriva.py" >> "%LOG%" 2>&1
"%PY%" "C:\Users\gcarv\bitacora-tasty\scripts\acta.py" >> "%LOG%" 2>&1
if not "%ERRORLEVEL%"=="0" (
    echo [%DATE% %TIME%] El acta fallo - NO se arranca Claude >> "%LOG%"
    goto FIN
)
set "CONSIGNA=Es el ACTA del dia. Lee actas/acta_<hoy>.txt y actas/acta_<hoy>.json. Si algun puesto figura 'sin parte', averigua por que ANTES de entregar: un puesto sin parte puede ser una corrida que fallo, y eso no es lo mismo que un dia sin novedades. Entrega el acta con las decisiones como preguntas de si o no, sin arrastrar la narrativa de cada puesto."
goto CLAUDE

:DERIVA
"%PY%" "C:\Users\gcarv\bitacora-tasty\scripts\deriva.py" >> "%LOG%" 2>&1
if not "%ERRORLEVEL%"=="0" (
    echo [%DATE% %TIME%] La deriva fallo - NO se arranca Claude >> "%LOG%"
    goto FIN
)
set "CONSIGNA=Es el REPASO SEMANAL DE DERIVA. Lee deriva/<hoy>.json. Recuerda que la deriva la decide produccion contra el canario: lo del manual es una lectura aproximada por regex y se reporta como 'revisar', nunca como deriva confirmada. Si hay deriva, busca en el historial de git el commit que movio la perilla y dilo; una deriva con culpable identificado se resuelve, una anonima se discute."

:CLAUDE
claude --permission-mode acceptEdits --allowedTools "Bash" "Read" "Write" "Edit" "Glob" "Grep" "mcp__whatsapp__whatsapp_enviar" -p "/secretario Los motores ya corrieron; NO los vuelvas a correr. %CONSIGNA% No corriges nada en produccion: detectar deriva no es resolverla. Termina mandando el resultado por WhatsApp: cuenta colombia, destino 573186252537@s.whatsapp.net." >> "%LOG%" 2>&1

echo [%DATE% %TIME%] Finalizado (codigo %ERRORLEVEL%) >> "%LOG%"

:FIN
echo. >> "%LOG%"
