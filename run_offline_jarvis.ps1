# Jarvis Offline Local AI Launcher (Stanford OpenJarvis + Ollama)
$Host.UI.RawUI.WindowTitle = "JARVIS // Offline Local AI"

$env:Path = "C:\Users\rgrak\.local\bin;$env:LOCALAPPDATA\Programs\Ollama;$env:Path"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "       JARVIS // OFFLINE LOCAL INTELLIGENCE ($0 API)       " -ForegroundColor White
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " [*] Framework : Stanford OpenJarvis" -ForegroundColor Green
Write-Host " [*] Engine    : Ollama (Llama 3.2 3B)" -ForegroundColor Green
Write-Host " [*] Privacy   : 100% Local / $0 API Fees / Offline" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

# Check if Ollama process is running
$ollamaProc = Get-Process -Name "ollama" -ErrorAction SilentlyContinue
if (-not $ollamaProc) {
    Write-Host " [*] Starting Ollama local engine in background..." -ForegroundColor Yellow
    Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
    Start-Sleep -Seconds 2
} else {
    Write-Host " [✓] Ollama local service is active." -ForegroundColor Green
}

Write-Host ""
Write-Host " Starting Interactive Jarvis Terminal..." -ForegroundColor Cyan
Write-Host " Type your message (or type 'exit' to quit):" -ForegroundColor White
Write-Host "----------------------------------------------------------" -ForegroundColor DarkGray
Write-Host ""

Set-Location "$PSScriptRoot\OpenJarvis"
uv run jarvis chat
