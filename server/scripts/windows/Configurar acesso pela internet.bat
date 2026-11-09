@echo off
title Nexo - acesso pela internet
cd /d "%~dp0"
"%~dp0node\node.exe" "%~dp0configurar-internet.mjs"
echo.
pause
