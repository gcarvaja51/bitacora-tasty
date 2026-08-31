' Wrapper silencioso de log_ventanas.ps1 (2026-08-31).
'
' Ironia necesaria: el vigilante que busca ventanas que se abren solas no puede
' abrir una ventana el mismo. Misma convencion que oculto.vbs y watchdog.vbs --
' el 0 es ventana oculta, el True espera y devuelve el codigo de salida real.
Set objShell = CreateObject("WScript.Shell")
exitCode = objShell.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""C:\Users\gcarv\bitacora-tasty\scripts\log_ventanas.ps1""", 0, True)
WScript.Quit(exitCode)
