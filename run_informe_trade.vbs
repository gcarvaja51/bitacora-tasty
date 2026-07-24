Set objShell = CreateObject("WScript.Shell")
objShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""C:\Users\gcarv\bitacora-tasty\run_informe_trade.ps1""", 0, True
