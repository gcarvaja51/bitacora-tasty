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
REM  YA NO COMPARTE EL NAVEGADOR CON EL DAEMON (2026-08-25). Antes si, y por eso
REM  se mataban: limpiarChromiumHuerfano() mata el Chromium que retiene el perfil
REM  ANTES de lanzar, asi que el que arrancaba segundo tumbaba al primero. El
REM  2026-08-24 a las 18:20 la captura murio con "Failed to launch the browser
REM  process!" y ese error quedo pegado en el lastError del daemon.
REM
REM  El 24-ago se le agrego a sigma.js la variable SIGMA_PROFILE_DIR justamente
REM  para separar los perfiles, y se creo captura_profile con su propia sesion de
REM  Sigma — pero este lanzador nunca la paso, asi que seguia cayendo al default
REM  (sigma_profile, el del daemon) y el arreglo no hacia nada. Se pasa aca.
REM
REM  EL NOMBRE IMPORTA: el filtro de limpiarChromiumHuerfano() compara por
REM  SUBCADENA contra el ultimo segmento de la ruta. Un perfil que contenga
REM  "sigma_profile" lo mataria el filtro del daemon igual. Por eso "captura_profile".
REM
REM  Sigue restaurando Sigma a SPX al terminar y verificandolo: si sale con codigo
REM  distinto de cero hay que mirar el log, porque el daemon exige SPX.
REM ===================================================================

cd /d "C:\Users\gcarv\bitacora-tasty"
set "LOG=%~dp0captura_niveles.log"
set "SIGMA_PROFILE_DIR=C:\Users\gcarv\bitacora-tasty\gamma_daemon\captura_profile"

echo [%DATE% %TIME%] Iniciando captura de niveles >> "%LOG%"
node gamma_daemon\capturar_niveles.mjs --todos >> "%LOG%" 2>&1
set CODE=%ERRORLEVEL%
echo [%DATE% %TIME%] Terminado con codigo %CODE% >> "%LOG%"

if not "%CODE%"=="0" (
  echo [%DATE% %TIME%] *** REVISAR: la captura fallo. Si Sigma quedo en otro simbolo, el daemon no operara. >> "%LOG%"
)
