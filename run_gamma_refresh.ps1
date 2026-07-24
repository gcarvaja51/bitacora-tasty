Set-Location -Path 'C:\Users\gcarv\bitacora-tasty'

$prompt = @'
Ciclo unico de refresco de niveles de Gamma (Sigma Terminal -> TradingView CIARG_V1), Paso 3 del skill premercado-spx.
Esta es una invocacion nueva y aislada -- no tenes historial de conversacion ni tabId previos, conseguilos de cero.

IMPORTANTE: las herramientas mcp__tradingview__* y mcp__claude-in-chrome__* pueden aparecer
"deferred" (solo el nombre, sin schema todavia) al arrancar esta sesion, aunque esten en tu
lista de allowedTools. Si al intentar llamar cualquiera de ellas te encontras con que no la
tenes disponible o no aparece en tu lista de tools, tu PRIMER paso antes de concluir que no
existe es llamar ToolSearch con query "select:mcp__tradingview__tv_health_check,mcp__tradingview__chart_get_state,mcp__tradingview__pane_list,mcp__tradingview__pane_focus,mcp__tradingview__indicator_set_inputs,mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__tabs_create_mcp"
para cargar sus definiciones -- recien despues de intentar eso, si siguen sin aparecer, das por
no disponible la herramienta.

Pasos:
1. Guard de horario: si estamos fuera de 09:30-16:05 ET o es sabado/domingo, no hagas nada mas y termina (una linea: "fuera de horario").
2. mcp__tradingview__tv_health_check -- si falla, termina sin reintentar ni relanzar TradingView (puede estar en uso manual, no lo interrumpas). Responde: "TradingView no conectado". Si conecta pero chart_symbol NO es SPCFD:SPX (puede haber quedado pegado a otra pestana, ej SPY -- gotcha conocido del skill), llama mcp__tradingview__tab_list, busca la entrada cuyo chart_id/url corresponda a SPX (si no sabes cual es, proba la que NO se llama "Wk609vJL", ese chart_id es SPY), tab_switch a ese indice, y repite tv_health_check UNA vez para confirmar chart_symbol SPCFD:SPX antes de seguir. Si sigue sin quedar en SPX tras un intento, termina: "no se pudo fijar el chart correcto (SPY en vez de SPX)".
3. mcp__claude-in-chrome__tabs_context_mcp con createIfEmpty true -- si alguna pestana ya tiene web.sigma.trade en la url, navega esa (mcp__claude-in-chrome__navigate con su tabId) a https://web.sigma.trade/terminal/?tab=greeks. Si ninguna la tiene, crea una nueva con tabs_create_mcp y navega ahi. NUNCA crees una pestana nueva si ya existe una de sigma.trade (evita acumular pestanas cada 2 min).
4. Sigma Terminal es una app JS que tarda unos segundos en renderizar despues de navigate -- justo despues de navegar, ejecuta PowerShell "Start-Sleep -Seconds 3" (o equivalente) ANTES de leer la pagina, nunca leas inmediatamente despues de navigate. Luego mcp__claude-in-chrome__read_page en esa pestana. Si el resultado tiene muy pocos elementos (menos de 10, senal de que la SPA todavia no cargo), espera 3 segundos mas y reintenta read_page una vez mas antes de concluir que algo esta mal. Confirma que el boton de simbolo dice SPX (si no, termina: "simbolo incorrecto en Sigma Terminal"). Extrae: Spot SPX (precio), Net GEX (con signo -- ej "$-165.09M" es negativo, "$10.53B" es positivo; convertilo a un numero en dolares, B=x1e9, M=x1e6), Call Wall, Put Wall, Gamma Flip, y MVS (el valor "Neto" de la tarjeta principal, no el toggle Abs).
5. mcp__tradingview__pane_list, y para cada pane (0 y 1): pane_focus(index), chart_get_state para encontrar el entity_id vigente del estudio cuyo nombre contiene "CIARG_V1" (cambia de sesion a sesion), luego indicator_set_inputs con ese entity_id e inputs siendo el JSON con claves in_20 (true), in_21 (call wall), in_22 (put wall), in_23 (gamma flip), in_24 (mvs). NUNCA llames chart_set_timeframe ni chart_set_symbol. Si el estudio no aparece con ese id, reintenta pane_focus+chart_get_state una vez antes de saltear ese pane.
6. Ademas de empujarlo a TradingView, manda estos mismos datos al servidor de produccion via PowerShell (Invoke-RestMethod), para que el servidor use la MISMA fuente que ve el usuario en vez de (o ademas de) su propio calculo interno: `Invoke-RestMethod -Uri "https://web-production-23473.up.railway.app/api/spx/sigma-levels" -Method Post -ContentType "application/json" -Body (@{netGex=<numero con signo>; regime=(<numero> -gt 0 ? "POSITIVO" : "NEGATIVO"); callWall=<call_wall>; putWall=<put_wall>; gammaFlip=<gamma_flip>; mvs=<mvs>; spxPrice=<spot>} | ConvertTo-Json)`. Si este POST falla, no es fatal -- registralo pero segui (el paso 5 a TradingView ya se hizo, es lo mas importante visualmente).
7. Responde con una sola linea confirmando los valores empujados a TradingView y si el POST al servidor funciono.
'@

$allowedTools = 'ToolSearch PowerShell mcp__tradingview__tv_health_check mcp__tradingview__chart_get_state mcp__tradingview__pane_list mcp__tradingview__pane_focus mcp__tradingview__indicator_set_inputs mcp__tradingview__tab_list mcp__tradingview__tab_switch mcp__claude-in-chrome__tabs_context_mcp mcp__claude-in-chrome__navigate mcp__claude-in-chrome__read_page mcp__claude-in-chrome__tabs_create_mcp'

$claudeArgs = @(
    '-p', $prompt,
    '--chrome',
    '--allowedTools', $allowedTools,
    '--permission-mode', 'dontAsk',
    '--output-format', 'stream-json',
    '--verbose'
)

& 'C:\Users\gcarv\AppData\Roaming\npm\claude.cmd' @claudeArgs 2>&1 | Out-File -FilePath 'C:\Users\gcarv\bitacora-tasty\gamma_refresh_log.txt' -Encoding utf8

# Deteccion de limite de gasto mensual agotado (2026-07-22, a pedido del usuario) --
# esto no se puede arreglar desde el script (es un limite de cuenta en claude.ai,
# solo el usuario puede subirlo), pero antes fallaba en silencio -- el usuario
# recien se enteraba horas despues al notar los muros desactualizados. Ahora se
# escribe un archivo bien visible en el Escritorio (sin popup/toast, para no
# reintroducir el flasheo de ventanas que ya se pidio evitar) cada vez que se
# detecta el error, con la hora del ultimo fallo -- se sobreescribe en cada
# corrida fallida, asi que la fecha/hora del archivo siempre refleja el ultimo
# intento bloqueado, no el primero.
$logContent = Get-Content -Path 'C:\Users\gcarv\bitacora-tasty\gamma_refresh_log.txt' -Raw -ErrorAction SilentlyContinue
if ($logContent -match 'monthly spend limit') {
    $msg = "BitacoraGammaRefresh bloqueada por limite de gasto mensual de Claude Code.`r`nSubilo en https://claude.ai/settings/usage`r`nUltimo intento fallido: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    Set-Content -Path "$env:USERPROFILE\Desktop\AUTOMATIZACION_BLOQUEADA.txt" -Value $msg -Encoding utf8
} else {
    Remove-Item -Path "$env:USERPROFILE\Desktop\AUTOMATIZACION_BLOQUEADA.txt" -ErrorAction SilentlyContinue
}
