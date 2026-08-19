' Wrapper silencioso del vigilante (2026-08-19). Misma convencion que
' launch_premercado_gate.vbs: el 0 del segundo argumento de Run() es lo unico
' que evita que parpadee una consola cada 10 minutos. El True espera al proceso
' y WScript.Quit propaga el codigo de salida, para que el Task Scheduler muestre
' un "Last Result" real y no un 0 permanente.
Set objShell = CreateObject("WScript.Shell")
exitCode = objShell.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""C:\Users\gcarv\bitacora-tasty\gamma_daemon\watchdog.ps1""", 0, True)
WScript.Quit(exitCode)
