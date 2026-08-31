# Captura del PERFIL DE GEX cada 5 minutos durante la sesion.
#
# Guarda, por cada strike, cuanto GEX tiene -- el dato que NO se estaba
# guardando en ningun sitio y sin el cual no se puede medir la regla de
# Guillermo: "el call wall se mantiene 30-60 min Y tiene 2x el GEX del
# siguiente strike de calls".
#
# El historial de muros del daemon (7192 lecturas desde el 21-jul) trae el
# STRIKE del muro pero nunca su MAGNITUD, asi que la mitad del criterio era
# imposible de evaluar. Esto lo arregla de aqui en adelante.
#
# Dos triggers (08:00 y 09:00 hora Colombia) por el horario de verano de EE.UU.;
# el bucle interno espera a la apertura y se apaga solo a las 16:05 ET, asi que
# el disparo de la temporada equivocada no hace dano.
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $dir 'gex_perfil_run.log'
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

try {
  $et = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId((Get-Date), 'Eastern Standard Time')
  if ($et.DayOfWeek -eq 'Saturday' -or $et.DayOfWeek -eq 'Sunday') {
    Add-Content $log "$stamp  SKIP - fin de semana"; exit 0
  }
  $h = $et.Hour + $et.Minute / 60.0
  if ($h -ge 16.0) {
    Add-Content $log "$stamp  SKIP - mercado ya cerrado (ET $($et.ToString('HH:mm')))"; exit 0
  }
  # Si ya hay un bucle vivo, no arrancar otro.
  $ya = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*gex_perfil.cjs*--loop*' }
  if ($ya) {
    Add-Content $log "$stamp  SKIP - ya hay un bucle corriendo (PID $($ya.ProcessId))"; exit 0
  }

  Add-Content $log "$stamp  LANZANDO bucle (ET $($et.ToString('HH:mm')))"
  $out = Join-Path $dir 'gex_perfil_salida.txt'
  Start-Process -FilePath 'node' -ArgumentList 'gex_perfil.cjs','--loop','--cada','5' `
    -WorkingDirectory $dir -WindowStyle Hidden -RedirectStandardOutput $out
  exit 0
}
catch {
  Add-Content $log "$stamp  FALLO - $($_.Exception.Message)"
  exit 1
}
