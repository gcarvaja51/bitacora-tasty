# ============================================================
#  Rutina de inicio de sesion (2026-07-29, a pedido del usuario)
#  Abre las apps/paginas de trabajo diario. Corre via Tarea
#  Programada con trigger de inicio de sesion (no carpeta de
#  Inicio clasica), orquestador oculto -- cada app se abre en
#  su propia ventana VISIBLE normal, solo el lanzador en si no
#  muestra ventana.
#
#  Limite de seguridad explicito: esta rutina NUNCA escribe ni
#  autocompleta ninguna contrasena (TastyTrade u otra). Abre
#  Notepad y la pantalla de login para que el usuario la tipee
#  el mismo -- no hay atajo automatico para eso, a proposito.
# ============================================================

Start-Sleep -Seconds 5  # margen para que la red/perfil terminen de cargar

function Try-Start($desc, $scriptBlock) {
    try {
        & $scriptBlock
        Write-Output "OK: $desc"
    } catch {
        Write-Output "FALLO: $desc -- $($_.Exception.Message)"
    }
}

# 1. TastyTrade (app de escritorio) -- se abre en su pantalla de login normal
Try-Start "TastyTrade" { Start-Process "C:\Program Files\tastytrade\tastytrade.exe" }
Start-Sleep -Seconds 2

# 2. Notepad en blanco, maximizado -- para que el usuario lea su nota de
#    password y la tipee el mismo en TastyTrade. Sin ruta fija a proposito
#    (el usuario no tiene un archivo unico de notas todavia).
Try-Start "Notepad" { Start-Process "notepad.exe" -WindowStyle Maximized }
Start-Sleep -Seconds 1

# 3. Telegram Desktop
Try-Start "Telegram" { Start-Process "$env:APPDATA\Telegram Desktop\Telegram.exe" }
Start-Sleep -Seconds 1

# 4. Claude Desktop (app de Anthropic, distinta de Claude Code)
Try-Start "Claude Desktop" { Start-Process "$env:LOCALAPPDATA\AnthropicClaude\Claude.exe" }
Start-Sleep -Seconds 1

# 5. WhatsApp Desktop (app de Microsoft Store -- se lanza por AUMID, no por .exe)
Try-Start "WhatsApp Desktop" { Start-Process "explorer.exe" -ArgumentList "shell:AppsFolder\5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App" }
Start-Sleep -Seconds 1

# 6. TradingView Desktop -- restaura su ultimo workspace guardado (hoy ya
#    incluye charts de SPX). Para que SIEMPRE abra exactamente SPX/SPY/SPX500
#    de forma confiable hace falta que el usuario arme esos 3 tabs una vez a
#    mano y los deje como el layout activo -- TradingView los va a recordar
#    solo en cada arranque futuro (confirmado en vivo hoy, restaura lo que
#    haya quedado abierto). No se automatiza la apertura de simbolos
#    especificos aca -- requeriria abrir una sesion de Claude Code dentro del
#    propio arranque de Windows via el MCP de TradingView, agregando una
#    dependencia fragil (ya vimos hoy varios cuelgues de esa conexion) a algo
#    que deberia ser simple y rapido.
Try-Start "TradingView" {
    $pkg = Get-AppxPackage -Name "*TradingView*"
    if ($pkg) {
        Start-Process -FilePath ($pkg.InstallLocation + "\TradingView.exe") -ArgumentList "--remote-debugging-port=9222"
    }
}
Start-Sleep -Seconds 2

# 7. PowerShell visible, ya parado en bitacora-tasty, con Claude Code corriendo
Try-Start "PowerShell + Claude Code" {
    Start-Process "powershell.exe" -ArgumentList '-NoExit', '-Command', "cd '$env:USERPROFILE\bitacora-tasty'; claude"
}
Start-Sleep -Seconds 1

# 8. NotebookLM -- app de escritorio (PWA de Chrome instalada, no una pestana
#    mas de Chrome). Comando exacto tomado del acceso directo real instalado
#    en el usuario ("Aplicaciones de Chrome\NotebookLM.lnk") -- usa
#    chrome_proxy.exe + --app-id, NO chrome.exe con una URL comun, para que
#    abra como ventana propia sin barra de pestanas/direccion.
Try-Start "NotebookLM (app)" {
    Start-Process "C:\Program Files\Google\Chrome\Application\chrome_proxy.exe" -ArgumentList '--profile-directory=Default', '--app-id=gjcmcplpgihbecacndmmbaenpfgimlec'
}
Start-Sleep -Seconds 1

# 9. Chrome con el set de pestanas de trabajo diario, todas en UNA ventana nueva
$urls = @(
    "https://web.sigma.trade/terminal/?tab=greeks",
    "https://web-production-23473.up.railway.app/tradier.html",
    "https://web-production-23473.up.railway.app/",
    "https://www.investing.com",
    "https://finviz.com",
    "https://web.whatsapp.com",
    "https://mail.google.com/mail/"
)
Try-Start "Chrome (set de pestañas de trabajo)" {
    Start-Process "chrome.exe" -ArgumentList (@('--new-window') + $urls)
}
