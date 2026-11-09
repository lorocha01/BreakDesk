@echo off
title Servidor Nexo
cd /d "%~dp0"
"%~dp0node\node.exe" "%~dp0iniciar.mjs"
echo.
echo O servidor parou. Pressione uma tecla para fechar.
pause >nul
