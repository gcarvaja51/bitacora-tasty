@echo off
REM ===================================================================
REM  Bitacora_Captura_Niveles — el max pain del dia y del viernes siguiente,
REM  de todos los activos abiertos, leidos de Sigma Terminal.
REM
REM  Lo pidio el usuario el 2026-08-22 para buscar una regla del movimiento
REM  esperado y poder decidir en la tercera semana de septiembre.
REM
REM  DOS VECES AL DIA: 09:45 (mercado recien abierto, el interes abierto del dia
REM  ya asentado) y 15:40 (antes del cierre). Suficiente para una serie diaria
REM  sin pelear con el ciclo de 2 minutos del daemon.
REM
REM  ⚠️ COMPARTE EL NAVEGADOR CON EL DAEMON. El capturador restaura Sigma a SPX
REM  al terminar —lo verifica leyendo— pero si algo sale muy mal sale con codigo
REM  distinto de cero y hay que mirar el log: el daemon exige SPX y sin el se
REM  queda sin muros.
REM ===================================================================

cd /d "C:\Users\gcarv\bitacora-tasty"
set "LOG=%~dp0captura_niveles.log"

echo [%DATE% %TIME%] Iniciando captura de niveles >> "%LOG%"
node gamma_daemon\capturar_niveles.mjs --todos >> "%LOG%" 2>&1
set CODE=%ERRORLEVEL%
echo [%DATE% %TIME%] Terminado con codigo %CODE% >> "%LOG%"

if not "%CODE%"=="0" (
  echo [%DATE% %TIME%] *** REVISAR: la captura fallo. Si Sigma quedo en otro simbolo, el daemon no operara. >> "%LOG%"
)
