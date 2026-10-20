@echo off
title Roger - Marketing AI & Executive Voice OS
cd /d "%~dp0"

echo =======================================================
echo   ROGER // Marketing AI Platform & Executive Voice OS
echo =======================================================
echo.

cd backend

if not exist node_modules (
    echo [1/3] Installing backend dependencies...
    call npm install
) else (
    echo [1/3] Backend dependencies verified.
)

echo.
echo [2/3] Verifying database schema and foundational records...
call node seed.js

echo.
echo [3/3] Opening browser at http://localhost:8000 ...
timeout /t 2 >nul
start "" "http://localhost:8000"

echo.
echo Starting Roger Executive Platform on port 8000...
node server.js

pause
