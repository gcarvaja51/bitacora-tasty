# Registra QUE proceso con consola nace y QUIEN lo lanza (2026-08-31).
#
# POR QUE: Guillermo reporta una ventana de cmd/powershell cada 2-3 minutos. Una
# vigilancia manual de 200 s solo pillo dos lanzamientos del host nativo de Adobe
# Acrobat (via cmd.exe desde chrome) y una segunda de 180 s no pillo nada, asi que
# no hay cadencia probada y adivinar ya fallo una vez. Esto lo mide sin depender de
# que alguien este delante.
#
# Sospechosos ya identificados, para contrastar contra lo que salga:
#   1. com.adobe.acrobat.chrome_webcapture  -> WCChromeNativeMessagingHost.exe
#   2. com.anthropic.claude_code_browser_extension -> chrome-native-host.BAT
#      Es el UNICO host nativo de Chrome que es un .bat: Chrome esta obligado a
#      abrir cmd.exe para ejecutarlo, y eso da consola siempre. Los otros cinco
#      hosts son .exe y no la necesitan.
#
# Escribe una linea por proceso nuevo. Solo apunta; no mata ni cambia nada.

$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'ventanas_espias.log'
$horas = if ($env:LOG_VENTANAS_HORAS) { [double]$env:LOG_VENTANAS_HORAS } else { 5 }
$fin = (Get-Date).AddHours($horas)

$filtro = "Name='cmd.exe' OR Name='powershell.exe' OR Name='pwsh.exe' OR Name='wscript.exe' OR Name='cscript.exe'"

function Escribe($txt) {
  "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))  $txt" | Out-File -FilePath $log -Append -Encoding utf8
}

Escribe "=== inicio de la vigilancia, $horas h ==="

# Los que ya existen no interesan: solo los que NACEN.
$vistos = @{}
Get-CimInstance Win32_Process -Filter $filtro | ForEach-Object { $vistos[$_.ProcessId] = $true }
Escribe "procesos con consola ya presentes al arrancar: $($vistos.Count)"

$conteo = @{}

while ((Get-Date) -lt $fin) {
  try {
    Get-CimInstance Win32_Process -Filter $filtro -ErrorAction Stop | ForEach-Object {
      if (-not $vistos.ContainsKey($_.ProcessId)) {
        $vistos[$_.ProcessId] = $true
        $padre = try { (Get-Process -Id $_.ParentProcessId -ErrorAction Stop).Name } catch { '?' }
        $cl = if ($_.CommandLine) { ($_.CommandLine -replace '\s+', ' ') } else { '(sin cmdline)' }
        if ($cl.Length -gt 220) { $cl = $cl.Substring(0, 220) }
        # La clave de agrupacion ignora los PID, para poder contar repeticiones.
        $clave = "$padre -> $($_.Name) :: " + ($cl -replace '\d{3,}', 'N')
        $conteo[$clave] = 1 + ($(if ($conteo.ContainsKey($clave)) { $conteo[$clave] } else { 0 }))
        Escribe "NUEVO padre=$padre  $($_.Name) pid=$($_.ProcessId)  |  $cl"
      }
    }
  } catch {
    # Un fallo puntual de WMI no debe matar la vigilancia.
  }
  Start-Sleep -Milliseconds 700
}

Escribe "=== fin. Resumen por frecuencia (lo de arriba del todo es el culpable) ==="
$conteo.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
  Escribe ("  {0,4} x  {1}" -f $_.Value, $_.Key)
}
