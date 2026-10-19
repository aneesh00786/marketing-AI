# Jarvis AI Business Voice OS Launcher
$Host.UI.RawUI.WindowTitle = "JARVIS // Voice Operating System"

$env:Path = "C:\Users\rgrak\.local\bin;$env:Path"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "     JARVIS // AI VOICE ASSISTANT & BUSINESS OS          " -ForegroundColor White
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " [✓] Voice Engine : ElevenLabs Conversational AI" -ForegroundColor Green
Write-Host " [✓] Agent ID     : agent_0101m51y56p2er5tny5gxe8sha5x" -ForegroundColor Green
Write-Host " [✓] Backend      : FastAPI + SQLite (jarvis.db)" -ForegroundColor Green
Write-Host ""
Write-Host " Starting Server at: http://127.0.0.1:8000" -ForegroundColor Yellow
Write-Host " Open the URL in your browser to speak with Jarvis!" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

uv run --with fastapi,uvicorn,requests,psutil uvicorn server.main:app --host 0.0.0.0 --port 8000 --reload
