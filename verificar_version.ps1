# ============================================================
#  BITÁCORA TASTY — Verificador de Versión v2
#  Ejecutar al INICIO de cada sesión antes de cualquier cambio
#  Uso: .\verificar_version.ps1
# ============================================================

$src     = "$HOME\bitacora-tasty"
$railway = "https://web-production-23473.up.railway.app"

$MIN_INDEX   = 5800
$MIN_SERVER  = 1670
$MIN_METRICS = 350

$FP_INDEX = @(
  'getCicloFactor',
  'aleHistFiltro',
  'ALE_PESOS',
  'consolidateStrategies'
)
$FP_SERVER  = @("Receive Deliver")
$FP_METRICS = @('FIFO por proximidad','buildMetrics')

$ok = $true

Write-Host ""
Write-Host "==========================================="  -ForegroundColor Cyan
Write-Host "  VERIFICADOR DE VERSION - Bitacora Tasty"   -ForegroundColor Cyan
Write-Host "==========================================="  -ForegroundColor Cyan
Write-Host ""

# ── 1. Railway vs Local ─────────────────────────────────────
Write-Host "[ 1 ] Railway vs Local..."  -ForegroundColor Yellow

try {
  $railwayBytes = (Invoke-WebRequest "$railway/" -UseBasicParsing).Content.Length
  $localBytes   = (Get-Item "$src\public\index.html").Length
  $diff         = [Math]::Abs($railwayBytes - $localBytes)

  # Diferencia aceptable hasta 20KB (diferencia de encoding UTF-16 vs UTF-8)
  if ($diff -gt 20000) {
    Write-Host "  DESINC - Railway:$railwayBytes Local:$localBytes Diff:$diff" -ForegroundColor Red
    $ok = $false
  } else {
    Write-Host "  OK - $railwayBytes bytes (diff $diff bytes dentro del rango aceptable)" -ForegroundColor Green
  }
} catch {
  Write-Host "  WARN - No se pudo conectar a Railway" -ForegroundColor Yellow
}

# ── 2. Lineas minimas ───────────────────────────────────────
Write-Host ""
Write-Host "[ 2 ] Lineas minimas..."  -ForegroundColor Yellow

$files = @(
  @{ path="$src\public\index.html"; min=$MIN_INDEX;   label="index.html"  },
  @{ path="$src\server.js";         min=$MIN_SERVER;  label="server.js"   },
  @{ path="$src\src\metrics.js";    min=$MIN_METRICS; label="metrics.js"  }
)

foreach ($f in $files) {
  if (Test-Path $f.path) {
    $lines = (Get-Content $f.path).Count
    if ($lines -lt $f.min) {
      Write-Host "  FALLO $($f.label): $lines < $($f.min)" -ForegroundColor Red
      $ok = $false
    } else {
      Write-Host "  OK    $($f.label): $lines lineas" -ForegroundColor Green
    }
  } else {
    Write-Host "  FALLO $($f.label): NO ENCONTRADO" -ForegroundColor Red
    $ok = $false
  }
}

# ── 3. Fingerprints ─────────────────────────────────────────
Write-Host ""
Write-Host "[ 3 ] Features clave..."  -ForegroundColor Yellow

function Check-Fingerprints($filePath, $label, $fps) {
  $content = Get-Content $filePath -Raw -ErrorAction SilentlyContinue
  if (-not $content) {
    Write-Host "  FALLO $label - no se pudo leer" -ForegroundColor Red
    return $false
  }
  $allOk = $true
  foreach ($fp in $fps) {
    if ($content -like "*$fp*") {
      Write-Host "  OK    $label - '$fp'" -ForegroundColor Green
    } else {
      Write-Host "  FALLO $label - FALTA '$fp'" -ForegroundColor Red
      $allOk = $false
    }
  }
  return $allOk
}

$r1 = Check-Fingerprints "$src\public\index.html" "index.html" $FP_INDEX
$r2 = Check-Fingerprints "$src\server.js"         "server.js"  $FP_SERVER
$r3 = Check-Fingerprints "$src\src\metrics.js"    "metrics.js" $FP_METRICS
if (-not ($r1 -and $r2 -and $r3)) { $ok = $false }

# ── 4. Resumen ──────────────────────────────────────────────
Write-Host ""
Write-Host "==========================================="  -ForegroundColor Cyan
if ($ok) {
  Write-Host "  TODO OK - puedes trabajar"  -ForegroundColor Green
} else {
  Write-Host "  PROBLEMAS - no edites aun"  -ForegroundColor Red
}
Write-Host "==========================================="  -ForegroundColor Cyan
Write-Host ""
