Set-Location -Path 'C:\Users\gcarv\bitacora-tasty'

$allowedTools = 'Bash PowerShell ToolSearch mcp__tradingview__tv_health_check mcp__tradingview__tv_launch mcp__tradingview__chart_get_state mcp__tradingview__chart_set_symbol mcp__tradingview__chart_set_timeframe mcp__tradingview__chart_set_visible_range mcp__tradingview__data_get_ohlcv mcp__tradingview__data_get_study_values mcp__tradingview__quote_get mcp__tradingview__capture_screenshot mcp__tradingview__pane_list mcp__tradingview__pane_focus mcp__tradingview__indicator_set_inputs mcp__tradingview__tab_list mcp__tradingview__tab_switch mcp__tradingview__ui_open_panel mcp__tradingview__ui_find_element mcp__claude-in-chrome__tabs_context_mcp mcp__claude-in-chrome__navigate mcp__claude-in-chrome__read_page mcp__claude-in-chrome__tabs_create_mcp mcp__claude-in-chrome__computer'

$claudeArgs = @(
    '-p', '/premercado-spx',
    '--chrome',
    '--allowedTools', $allowedTools,
    '--permission-mode', 'dontAsk',
    '--output-format', 'stream-json',
    '--verbose'
)

& 'C:\Users\gcarv\AppData\Roaming\npm\claude.cmd' @claudeArgs 2>&1 | Out-File -FilePath 'C:\Users\gcarv\bitacora-tasty\premercado_auto_log.txt' -Encoding utf8

# Deteccion de limite de gasto mensual (mismo mecanismo que las otras 2
# automatizaciones -- flag compartido en el Escritorio).
$logContent = Get-Content -Path 'C:\Users\gcarv\bitacora-tasty\premercado_auto_log.txt' -Raw -ErrorAction SilentlyContinue
if ($logContent -match 'monthly spend limit') {
    $msg = "BitacoraPremercadoSPX bloqueada por limite de gasto mensual de Claude Code.`r`nSubilo en https://claude.ai/settings/usage`r`nUltimo intento fallido: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    Set-Content -Path "$env:USERPROFILE\Desktop\AUTOMATIZACION_BLOQUEADA.txt" -Value $msg -Encoding utf8
} else {
    Remove-Item -Path "$env:USERPROFILE\Desktop\AUTOMATIZACION_BLOQUEADA.txt" -ErrorAction SilentlyContinue
}
