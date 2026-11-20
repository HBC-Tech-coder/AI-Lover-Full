param(
  [string]$InstallDir = ""
)

$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not $InstallDir) {
  $InstallDir = Join-Path $env:LOCALAPPDATA "AI-Lover"
}

$StopScript = Join-Path $InstallDir "customer_stop.ps1"
if (Test-Path -LiteralPath $StopScript) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $StopScript
}

$Desktop = [Environment]::GetFolderPath("Desktop")
Remove-Item -LiteralPath (Join-Path $Desktop "AI-Lover.lnk") -Force
Remove-Item -LiteralPath $InstallDir -Recurse -Force

Write-Host "AI-Lover uninstalled."
Start-Sleep -Seconds 3
