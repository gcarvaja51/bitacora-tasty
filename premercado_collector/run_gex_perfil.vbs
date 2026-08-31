' Wrapper silencioso de run_gex_perfil.ps1 (2026-08-31).
'
' POR QUE: la tarea Bitacora_GEX_Perfil ejecutaba powershell.exe
' DIRECTAMENTE, sin -WindowStyle Hidden siquiera, asi que el Programador de
' Windows le daba una consola propia y visible cada vez -- a las 08:00 y a las
' 09:00, en plena preparacion del premercado.
'
' Misma convencion que watchdog.vbs, run_informe_trade.vbs y oculto.vbs: el 0 del
' segundo parametro de Run() es "ventana oculta" y el True es "esperar y devolver
' el codigo de salida real", para que el Programador muestre un Last Result de
' verdad y no un 0 prematuro.
'
' OJO: -WindowStyle Hidden por si solo NO basta. PowerShell crea la consola y
' LUEGO la esconde, asi que igual parpadea. El unico que la evita del todo es
' este wrapper.
Set objShell = CreateObject("WScript.Shell")
exitCode = objShell.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""C:\Users\gcarv\bitacora-tasty\premercado_collector\run_gex_perfil.ps1""", 0, True)
WScript.Quit(exitCode)
