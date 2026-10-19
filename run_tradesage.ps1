# TradeSage AI Launch Script (Angular 17 + Express/Node.js)
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   TradeSage AI: Multi-Tenant Enterprise Workforce SaaS" -ForegroundColor Yellow
Write-Host "   Frontend: Angular 17" -ForegroundColor Green
Write-Host "   Backend:  Express / Node.js" -ForegroundColor Green
Write-Host "   Telephony: Telnyx All-In-One Voice AI" -ForegroundColor Green
Write-Host "   Database: SQLite / MySQL Dual Driver" -ForegroundColor Green
Write-Host "   Budget:   Strict <$10.00 / month cap" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan

$BackendDir = Join-Path $PSScriptRoot "backend"

Set-Location $BackendDir

Write-Host "`n[1/2] Starting Express API Server on http://localhost:8000..." -ForegroundColor Cyan
node server.js
