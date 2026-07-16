@echo off
title Serveur Pokemon Vinted
cd /d "%~dp0"
echo ========================================
echo   Demarrage du serveur Pokemon Vinted
echo ========================================
echo.

REM Tuer toute ancienne instance qui occuperait le port 3000 (evite l'erreur EADDRINUSE)
taskkill /F /IM node.exe >nul 2>&1
if not errorlevel 1 echo Ancienne instance fermee.

echo Lancement du serveur...
echo.
node index.js

REM Si le serveur s'arrete ou plante, la fenetre reste ouverte pour lire l'erreur
echo.
echo ========================================
echo   Le serveur s'est arrete.
echo ========================================
pause