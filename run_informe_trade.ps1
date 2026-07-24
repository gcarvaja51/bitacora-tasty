Set-Location -Path 'C:\Users\gcarv\bitacora-tasty'

$allowedTools = 'ToolSearch Bash'

$claudeArgs = @(
    '-p', '/informe-trade',
    '--allowedTools', $allowedTools,
    '--permission-mode', 'dontAsk',
    '--output-format', 'stream-json',
    '--verbose'
)

& 'C:\Users\gcarv\AppData\Roaming\npm\claude.cmd' @claudeArgs 2>&1 | Out-File -FilePath 'C:\Users\gcarv\bitacora-tasty\informe_trade_log.txt' -Encoding utf8

# Deteccion de limite de gasto mensual (mismo mecanismo que run_gamma_refresh.ps1,
# ver ese archivo para el porque -- flag compartido, cualquiera de las 3
# automatizaciones lo escribe/limpia segun su propio ultimo resultado).
$logContent = Get-Content -Path 'C:\Users\gcarv\bitacora-tasty\informe_trade_log.txt' -Raw -ErrorAction SilentlyContinue
if ($logContent -match 'monthly spend limit') {
    $msg = "BitacoraInformeTrade bloqueada por limite de gasto mensual de Claude Code.`r`nSubilo en https://claude.ai/settings/usage`r`nUltimo intento fallido: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    Set-Content -Path "$env:USERPROFILE\Desktop\AUTOMATIZACION_BLOQUEADA.txt" -Value $msg -Encoding utf8
} else {
    Remove-Item -Path "$env:USERPROFILE\Desktop\AUTOMATIZACION_BLOQUEADA.txt" -ErrorAction SilentlyContinue
}
