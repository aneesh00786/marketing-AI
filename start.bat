@echo off
title Roger - Executive AI Voice OS
cd /d "%~dp0"

echo =======================================================
echo   ROGER // Executive AI Voice OS ^& Multi-Business CRM
echo =======================================================
echo.

cd backend
if not exist node_modules (
    echo [1/3] Installing backend dependencies...
    call npm install
) else (
    echo [1/3] Backend dependencies already installed.
)

echo.
echo [2/3] Opening browser at http://localhost:8000 ...
timeout /t 2 >nul
start "" "http://localhost:8000"

echo.
echo [3/3] Starting Roger Executive Voice OS on port 8000...
node server.js

pause
