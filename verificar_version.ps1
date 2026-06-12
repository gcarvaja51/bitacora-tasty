$src = "$HOME\bitacora-tasty"
$railway = "https://web-production-23473.up.railway.app"
$MIN_INDEX = 5840; $MIN_SERVER = 1670; $MIN_METRICS = 350
$FP_INDEX = @('getCicloFactor','aleHistFiltro','ALE_PESOS','consolidateStrategies')
$FP_SERVER = @('Receive Deliver')
$FP_METRICS = @('FIFO por proximidad','buildMetrics')
$ok = $true
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "  VERIFICADOR DE VERSION - Bitacora Tasty" -ForegroundColor Cyan
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "[ 1 ] Railway vs Local..." -ForegroundColor Yellow
try {
  $rb = (Invoke-WebRequest "$railway/" -UseBasicParsing).Content.Length
  $lb = (Get-Item "$src\public\index.html").Length
  $d  = [Math]::Abs($rb - $lb)
  if ($d -gt 10000) { Write-Host "  DESINC - Railway:$rb Local:$lb Diff:$d" -ForegroundColor Red; $ok=$false }
  else { Write-Host "  OK - $rb bytes" -ForegroundColor Green }
} catch { Write-Host "  Sin conexion Railway" -ForegroundColor Red }
Write-Host ""
Write-Host "[ 2 ] Lineas minimas..." -ForegroundColor Yellow
@(
  @{p="$src\public\index.html";m=$MIN_INDEX;l="index.html"},
  @{p="$src\server.js";m=$MIN_SERVER;l="server.js"},
  @{p="$src\src\metrics.js";m=$MIN_METRICS;l="metrics.js"}
) | ForEach-Object {
  if (Test-Path $_.p) {
    $n = (Get-Content $_.p).Count
    if ($n -lt $_.m) { Write-Host "  FALLO $($_.l): $n < $($_.m)" -ForegroundColor Red; $ok=$false }
    else { Write-Host "  OK    $($_.l): $n lineas" -ForegroundColor Green }
  } else { Write-Host "  FALLO $($_.l): NO EXISTE" -ForegroundColor Red; $ok=$false }
}
Write-Host ""
Write-Host "[ 3 ] Features clave..." -ForegroundColor Yellow
@(
  @{f="$src\public\index.html";l="index.html";fps=$FP_INDEX},
  @{f="$src\server.js";l="server.js";fps=$FP_SERVER},
  @{f="$src\src\metrics.js";l="metrics.js";fps=$FP_METRICS}
) | ForEach-Object {
  $c = Get-Content $_.f -Raw -EA SilentlyContinue
  foreach ($fp in $_.fps) {
    if ($c -like "*$fp*") { Write-Host "  OK    $($_.l) - '$fp'" -ForegroundColor Green }
    else { Write-Host "  FALLO $($_.l) - FALTA '$fp'" -ForegroundColor Red; $ok=$false }
  }
}
Write-Host ""
Write-Host "===========================================" -ForegroundColor Cyan
if ($ok) { Write-Host "  TODO OK - puedes trabajar" -ForegroundColor Green }
else { Write-Host "  PROBLEMAS - no edites aun" -ForegroundColor Red }
Write-Host "===========================================" -ForegroundColor Cyan


