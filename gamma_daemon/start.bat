@echo off
cd /d "%~dp0"
:loop
node index.js
echo [%date% %time%] index.js termino (posible crash), reiniciando en 5s... >> daemon_crash_log.txt
timeout /t 5 /nobreak >nul
goto loop
