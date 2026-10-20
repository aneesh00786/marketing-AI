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

Write-Host "`n[2/3] Verifying database schema, foundational records and migrations..." -ForegroundColor Yellow
node seed.js
node db/migrate.js
if ($LASTEXITCODE -ne 0) { Write-Host "Migration failed - fix the error above before starting." -ForegroundColor Red; exit 1 }

Write-Host "Starting the social publishing worker in a separate window..." -ForegroundColor Yellow
Start-Process node -ArgumentList "workers/socialWorker.js" -WorkingDirectory (Get-Location)

Write-Host "`n[3/3] Opening browser at http://localhost:8000 ..." -ForegroundColor Cyan
Start-Process "http://localhost:8000"

Write-Host "`nStarting Roger Executive Platform on port 8000..." -ForegroundColor Green
node server.js
