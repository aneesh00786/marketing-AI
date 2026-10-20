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
echo [2/3] Verifying database schema, foundational records and migrations...
call node seed.js
call node db\migrate.js
if errorlevel 1 (
    echo Migration failed - fix the error above before starting.
    pause
    exit /b 1
)

echo Starting the social publishing worker in a separate window...
start "Roger Social Worker" cmd /k node workers\socialWorker.js

echo.
echo [3/3] Opening browser at http://localhost:8000 ...
timeout /t 2 >nul
start "" "http://localhost:8000"

echo.
echo Starting Roger Executive Platform on port 8000...
node server.js

pause
