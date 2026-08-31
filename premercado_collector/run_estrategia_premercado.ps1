# Disparo diario de la ESTRATEGIA PREMERCADO.
#
# Dos triggers a proposito (09:30 y 10:30 hora Colombia): cubren las dos
# temporadas de horario de verano de EE.UU. sin editar la Tarea dos veces al
# anio. El que cae fuera de la ventana 10:00-11:00 ET se auto-descarta -- el
# propio motor devuelve FUERA_DE_VENTANA -- y el registro deduplica por fecha,
# asi que de los dos disparos exactamente uno hace algo.
#
# Se apunta a las 10:30 ET (no a las 10:00) para que ya haya cuatro velas de 15m
# cerradas: la estrategia exige un minimo de dos y no debe decidir con la vela
# en curso.
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $dir 'estrategia_premercado_run.log'
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

try {
  $et = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId(
          (Get-Date), 'Eastern Standard Time')
  $h = $et.Hour + $et.Minute / 60.0

  if ($et.DayOfWeek -eq 'Saturday' -or $et.DayOfWeek -eq 'Sunday') {
    Add-Content $log "$stamp  SKIP - fin de semana (ET $($et.ToString('HH:mm')))"
    exit 0
  }
  if ($h -lt 10.0 -or $h -ge 11.0) {
    Add-Content $log "$stamp  SKIP - fuera de ventana (ET $($et.ToString('HH:mm')), se espera 10:00-11:00). Trigger de la temporada equivocada: es normal."
    exit 0
  }

  Add-Content $log "$stamp  LANZANDO (ET $($et.ToString('HH:mm')))"
  $out = Join-Path $dir 'estrategia_premercado_ultima_salida.txt'
  $err = Join-Path $dir 'estrategia_premercado_stderr.txt'
  $p = Start-Process -FilePath 'node' `
        -ArgumentList 'estrategia_ejecutar.cjs' `
        -WorkingDirectory $dir -NoNewWindow -PassThru `
        -RedirectStandardOutput $out -RedirectStandardError $err
  if (-not $p.WaitForExit(300000)) {   # 5 min de techo
    try { $p.Kill() } catch {}
    Add-Content $log "$stamp  FALLO - se paso de 5 min, proceso terminado"
    exit 2
  }
  $txt = if (Test-Path $out) { Get-Content $out -Raw } else { '' }
  $resumen = ($txt -split "`r?`n" | Where-Object { $_ -match '\[decision\]|\[Tradier\]|\[skip\]' }) -join ' | '
  Add-Content $log "$stamp  FIN (exit $($p.ExitCode)) $resumen"

  # ── MONITOR DE SALIDA ───────────────────────────────────────────────────
  # Sin esto NO HAY STOP: la posicion se queda hasta vencimiento. En un debit
  # spread la perdida esta acotada al debito y se aguanta, pero en el butterfly
  # el stop existe solo si alguien lo vigila. Por eso el monitor arranca en la
  # MISMA tarea que la apertura -- una tarea que abre sin vigilar es peor que no
  # abrir.
  # Solo se lanza si de verdad se abrio algo; si la decision fue no operar, no
  # hay nada que mirar.
  if ($txt -match '\[Tradier\] orden enviada') {
    $yaVive = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
              Where-Object { $_.CommandLine -like '*estrategia_monitor.cjs*' }
    if ($yaVive) {
      Add-Content $log "$stamp  monitor ya estaba corriendo (PID $($yaVive.ProcessId))"
    } else {
      $mout = Join-Path $dir 'estrategia_monitor_salida.txt'
      Start-Process -FilePath 'node' -ArgumentList 'estrategia_monitor.cjs','--loop' `
        -WorkingDirectory $dir -WindowStyle Hidden -RedirectStandardOutput $mout
      Add-Content $log "$stamp  monitor de TP/SL lanzado"
    }
  } else {
    Add-Content $log "$stamp  sin posicion abierta: no se lanza monitor"
  }

  exit $p.ExitCode
}
catch {
  Add-Content $log "$stamp  FALLO - $($_.Exception.Message)"
  exit 1
}
