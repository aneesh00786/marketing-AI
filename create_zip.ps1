$ErrorActionPreference = 'Stop'
$destZip = 'c:\Users\rgrak\ai_product\TradeSage_Executive_Voice_OS.zip'
if (Test-Path $destZip) {
    Remove-Item $destZip -Force
}

$tempFolder = 'c:\Users\rgrak\ai_product\temp_zip_staging'
if (Test-Path $tempFolder) {
    Remove-Item $tempFolder -Recurse -Force
}
New-Item -ItemType Directory -Path $tempFolder | Out-Null

Write-Host "Copying backend files..."
New-Item -ItemType Directory -Path "$tempFolder\backend" | Out-Null
robocopy "c:\Users\rgrak\ai_product\backend" "$tempFolder\backend" /E /XD node_modules /XF *.log | Out-Null

Write-Host "Copying frontend files (including pre-built dist)..."
New-Item -ItemType Directory -Path "$tempFolder\frontend" | Out-Null
robocopy "c:\Users\rgrak\ai_product\frontend" "$tempFolder\frontend" /E /XD node_modules .angular | Out-Null

Write-Host "Copying root files..."
Copy-Item "c:\Users\rgrak\ai_product\tradesage.db" "$tempFolder\tradesage.db"
Copy-Item "c:\Users\rgrak\ai_product\start.bat" "$tempFolder\start.bat"
Copy-Item "c:\Users\rgrak\ai_product\HOW_TO_RUN.md" "$tempFolder\HOW_TO_RUN.md"
Copy-Item "c:\Users\rgrak\ai_product\README.md" "$tempFolder\README.md"

Write-Host "Compressing into zip archive: $destZip ..."
Compress-Archive -Path "$tempFolder\*" -DestinationPath $destZip -CompressionLevel Optimal

Write-Host "Cleaning up temp folder..."
Remove-Item $tempFolder -Recurse -Force

$zipItem = Get-Item $destZip
Write-Host "SUCCESS: ZIP file created at $($zipItem.FullName) ($([math]::Round($zipItem.Length / 1MB, 2)) MB)"
