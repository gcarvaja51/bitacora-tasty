@echo off
cd /d %USERPROFILE%\bitacora-tasty
taskkill /f /im node.exe >nul 2>&1
timeout /t 2 /nobreak >nul
start "Bitacora Tasty" cmd /k node server.js
ping -n 5 localhost >nul
start "" "http://localhost:3000"
