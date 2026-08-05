@echo off
cd /d "%~dp0"
:loop
node index.js
echo [%date% %time%] index.js termino (posible crash), reiniciando en 15s... >> daemon_crash_log.txt
rem OJO: no usar "timeout" aca. Sin consola interactiva (que es el caso cuando lo
rem lanza la Tarea Programada) falla al instante con "Input redirection is not
rem supported" y este bucle deja de esperar — el 2026-08-05 eso produjo 128
rem reinicios en un solo segundo. "ping" no depende de stdin y siempre espera.
ping -n 16 127.0.0.1 >nul
goto loop
