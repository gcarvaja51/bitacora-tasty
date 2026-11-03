@echo off
REM Lector de Iron Balls — bucle de reinicio. Lanzar oculto (ver CLAUDE.md § IRONBALLS):
REM   Start-Process cmd.exe -ArgumentList "/c","C:\Users\gcarv\bitacora-tasty\ironballs\start.bat" -WorkingDirectory "C:\Users\gcarv\bitacora-tasty" -WindowStyle Hidden
REM Sin "timeout": sin consola interactiva falla al instante (gotcha del gamma_daemon). Se usa ping.
cd /d C:\Users\gcarv\bitacora-tasty
:loop
node ironballs\lector.js >> ironballs\lector_consola.log 2>&1
ping -n 31 127.0.0.1 >nul
goto loop
