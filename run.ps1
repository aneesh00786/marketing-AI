# Roger - Marketing AI Platform PowerShell Launcher
Set-Location -Path $PSScriptRoot

Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host "  ROGER // Marketing AI Platform & Executive Voice OS" -ForegroundColor White
Write-Host "=======================================================" -ForegroundColor Cyan

Set-Location -Path (Join-Path $PSScriptRoot "backend")

if (-not (Test-Path "node_modules")) {
    Write-Host "`n[1/3] Installing backend dependencies..." -ForegroundColor Yellow
    npm install
} else {
    Write-Host "`n[1/3] Backend dependencies verified." -ForegroundColor Green
}

Write-Host "`n[2/3] Verifying database schema and foundational records..." -ForegroundColor Yellow
node seed.js

Write-Host "`n[3/3] Opening browser at http://localhost:8000 ..." -ForegroundColor Cyan
Start-Process "http://localhost:8000"

Write-Host "`nStarting Roger Executive Platform on port 8000..." -ForegroundColor Green
node server.js
