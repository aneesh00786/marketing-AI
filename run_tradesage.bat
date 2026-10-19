@echo off
title TradeSage AI - Enterprise Workforce SaaS
color 0b
echo ==========================================================
echo    TradeSage AI: Multi-Tenant Enterprise Workforce SaaS
echo    Frontend: Angular 17
echo    Backend:  Express / Node.js
echo    Telephony: Telnyx All-In-One Voice AI
echo    Database: SQLite / MySQL Dual Driver
echo    Budget:   Strict under $10/month cap
echo ==========================================================
cd /d "%~dp0backend"
node server.js
pause
