@echo off
title JARVIS Voice Operating System
cd /d "%~dp0"
echo Starting JARVIS Core on Port 8000...
start "" "http://127.0.0.1:8000"
powershell -ExecutionPolicy Bypass -File "%~dp0run_jarvis.ps1"
