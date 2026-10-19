@echo off
title JARVIS // Stanford Offline Local AI (Ollama $0)
color 0B
echo ==========================================================
echo       JARVIS // OFFLINE LOCAL INTELLIGENCE ($0 API)       
echo ==========================================================
echo  [*] Framework : Stanford OpenJarvis
echo  [*] Engine    : Ollama (Llama 3.2)
echo  [*] Privacy   : 100%% Local / $0 API Fees / Offline
echo ==========================================================
echo.

cd /d "%~dp0OpenJarvis"
set "PATH=%USERPROFILE%\.local\bin;%LOCALAPPDATA%\Programs\Ollama;%PATH%"

REM Check if Ollama background service is running
tasklist /FI "IMAGENAME eq ollama.exe" 2>NUL | find /I /N "ollama.exe">NUL
if "%ERRORLEVEL%"=="0" (
    echo  [v] Ollama local service is running.
) else (
    echo  [*] Starting Ollama background engine...
    start /B "" "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" serve
    timeout /t 2 /nobreak >nul
)

echo.
echo  Starting Interactive Jarvis Session...
echo  Type your message below (or type 'exit' or Ctrl+C to quit):
echo ----------------------------------------------------------
echo.

uv run jarvis chat
pause
