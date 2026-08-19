' Wrapper silencioso — identico al de watchdog.vbs, que lleva dias funcionando.
' El 0 del segundo argumento de Run() evita el parpadeo de consola; True espera
' y WScript.Quit propaga el codigo real al Task Scheduler.
Set sh = CreateObject("WScript.Shell")
WScript.Quit(sh.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""C:\Users\gcarv\bitacora-tasty\scripts\revision_reversion.ps1""", 0, True))
