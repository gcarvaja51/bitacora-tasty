# ============================================================
#  Respaldo diario del archivo permanente -> PC + MEGA
#  Pedido de Guillermo (2026-11-09): "manten un ejercicio de guardar esa data
#  en mi pc o en mega (nube) para que no perdamos informacion".
#
#  1. Baja de produccion (GET /api/archivo) cada dia de cada tipo que falte en
#     la PC, y vuelve a bajar los dos ultimos dias (el de hoy puede crecer).
#     Tipos: gamma (muros, flip, GEX/DEX cada ~2 min), estrategia (log de
#     decisiones del robot), gamma_descartada.
#  2. Foto diaria completa de las ejecuciones y de la cuenta demo.
#  3. Sube a MEGA (/Bitacora/archivo/...) lo nuevo o lo que cambio, con el
#     MEGAcmd instalado (sesion ya abierta). Si MEGA falla, la PC igual queda
#     al dia y se avisa.
#  Destino local: C:\Users\gcarv\bitacora-tasty\datos\archivo\<tipo>\<fecha>.jsonl
#  Tarea: Bitacora_RespaldoArchivo (lunes a viernes 17:30 ET).
# ============================================================
param([switch]$SinMega, [switch]$Prueba)

$BASE    = "https://web-production-23473.up.railway.app"
$LOCAL   = "C:\Users\gcarv\bitacora-tasty\datos\archivo"
$REMOTO  = "/Bitacora/archivo"
$MEGACMD = Join-Path $env:LOCALAPPDATA "MEGAcmd"
$ESTADO  = Join-Path $LOCAL "_subidos_mega.json"
$logPath = "C:\Users\gcarv\bitacora-tasty\datos\respaldo_archivo_log.txt"

New-Item -ItemType Directory -Force -Path $LOCAL | Out-Null
function Log($msg) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg" | Out-File -FilePath $logPath -Append -Encoding utf8 }
function Avisar($titulo, $texto, $prioridad = 3, $tag = 'floppy_disk') {
    if ($Prueba) { Log "[PRUEBA, no enviado] $titulo :: $texto"; return }
    $body = @{ topic = 'bitacora_gcarvaja51'; title = $titulo; message = $texto; priority = $prioridad; tags = @($tag) } | ConvertTo-Json -Depth 4
    try { Invoke-RestMethod -Uri "https://ntfy.sh/" -Method Post -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 20 | Out-Null }
    catch { Log "ntfy fallo: $($_.Exception.Message)" }
}
$utf8 = New-Object System.Text.UTF8Encoding($false)

# ── 1. Archivo permanente ───────────────────────────────────
$bajados = 0; $errores = @()
try { $inv = Invoke-RestMethod -Uri "$BASE/api/archivo" -TimeoutSec 60 }
catch { $inv = $null; $errores += "inventario: $($_.Exception.Message)" }
$recientes = @((Get-Date).ToString('yyyy-MM-dd'), (Get-Date).AddDays(-1).ToString('yyyy-MM-dd'), (Get-Date).AddDays(-3).ToString('yyyy-MM-dd'))
if ($inv -and $inv.tipos) {
    foreach ($tipo in $inv.tipos.PSObject.Properties.Name) {
        $dir = Join-Path $LOCAL $tipo
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $fechas = @($inv.tipos.$tipo | ForEach-Object { $_.fecha } | Select-Object -Unique)
        foreach ($f in $fechas) {
            $dest = Join-Path $dir "$f.jsonl"
            if ((Test-Path $dest) -and ($f -lt $recientes[2])) { continue }   # dia viejo ya respaldado
            try {
                $r = Invoke-WebRequest -Uri "$BASE/api/archivo/$tipo/$f" -UseBasicParsing -TimeoutSec 120
                $txt = [System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
                [System.IO.File]::WriteAllText($dest, $txt, $utf8)
                $bajados++
            } catch { $errores += "$tipo/$f : $($_.Exception.Message)" }
        }
    }
}

# ── 2. Fotos diarias ────────────────────────────────────────
$hoy = (Get-Date).ToString('yyyy-MM-dd')
foreach ($foto in @(@{ n = 'ejecuciones'; u = '/api/tradier/executions' }, @{ n = 'cuenta_demo'; u = '/api/tendencia-demo/cuenta' })) {
    $dir = Join-Path $LOCAL $foto.n
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    try {
        $r = Invoke-WebRequest -Uri "$BASE$($foto.u)" -UseBasicParsing -TimeoutSec 120
        [System.IO.File]::WriteAllText((Join-Path $dir "$hoy.json"), [System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray()), $utf8)
        $bajados++
    } catch { $errores += "$($foto.n): $($_.Exception.Message)" }
}

# ── 3. MEGA ─────────────────────────────────────────────────
$subidos = 0; $megaOk = $true
if (-not $SinMega) {
    $estado = @{}
    if (Test-Path $ESTADO) { (Get-Content $ESTADO -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $estado[$_.Name] = $_.Value } }
    $put = Join-Path $MEGACMD "mega-put.bat"
    if (-not (Test-Path $put)) { $megaOk = $false; $errores += "MEGAcmd no encontrado en $MEGACMD" }
    else {
        foreach ($a in Get-ChildItem $LOCAL -Recurse -File | Where-Object { $_.Name -notlike '_*' }) {
            $rel = $a.FullName.Substring($LOCAL.Length + 1).Replace('\', '/')
            $firma = "$($a.Length)|$($a.LastWriteTimeUtc.Ticks)"
            if ($estado[$rel] -eq $firma) { continue }
            $carpeta = "$REMOTO/" + (Split-Path $rel -Parent).Replace('\', '/')
            if ($Prueba) { Log "[PRUEBA] subiria $rel -> $carpeta/"; continue }
            $salida = & $put -c $a.FullName "$carpeta/" 2>&1
            if ($LASTEXITCODE -eq 0) { $estado[$rel] = $firma; $subidos++ }
            else { $megaOk = $false; $errores += "MEGA $rel : $($salida | Select-Object -First 1)" ; break }
        }
        if (-not $Prueba) { ($estado | ConvertTo-Json -Depth 3) | Out-File -FilePath $ESTADO -Encoding utf8 }
    }
}

$resumen = "PC: $bajados archivos al dia en datos\archivo. MEGA: " + $(if ($SinMega) { 'omitido' } elseif ($megaOk) { "$subidos subidos a $REMOTO" } else { 'FALLO' }) + "."
Log ($resumen + $(if ($errores.Count) { " Errores: " + ($errores -join ' | ') } else { '' }))
if ($errores.Count) {
    $detalle = (@($errores) | Select-Object -First 3) -join "`n"
    Avisar "⚠️ Respaldo de la bitácora con errores" ("$resumen`n" + $detalle) 4 'warning'
    exit 1
}
exit 0
