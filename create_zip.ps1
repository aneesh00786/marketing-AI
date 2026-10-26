# Builds a release archive of the committed code and checks it contains no secrets or runtime data
# (.env, uploaded media, logs, databases, archives). See backend/scripts/packageRelease.js.
# The previous version copied the whole backend folder (including backend\.env and runtime storage)
# and a database file into the archive.
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot
node backend/scripts/packageRelease.js @args
if ($LASTEXITCODE -ne 0) { Write-Host "Packaging failed - see the message above." -ForegroundColor Red; exit 1 }
