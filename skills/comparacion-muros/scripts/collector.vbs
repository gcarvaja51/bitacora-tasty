Set objShell = CreateObject("WScript.Shell")
objShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""C:\Users\gcarv\.claude\skills\comparacion-muros\scripts\collector.ps1""", 0, True
