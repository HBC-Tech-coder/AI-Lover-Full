param(
  [string]$InstallDir = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$PackageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$SourceApp = Join-Path $PackageRoot "app"
if (-not (Test-Path -LiteralPath $SourceApp)) {
  throw "Cannot find the app folder. Please extract the full package first."
}

if (-not $InstallDir) {
  $InstallDir = Join-Path $env:LOCALAPPDATA "AI-Lover"
}

Write-Host "Installing AI-Lover to: $InstallDir" -ForegroundColor Cyan
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

robocopy $SourceApp $InstallDir /MIR /R:2 /W:1 /XD local_logs | Out-Host
if ($LASTEXITCODE -gt 7) {
  throw "File copy failed. Robocopy exit code: $LASTEXITCODE"
}

$Desktop = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $Desktop "AI-Lover.lnk"
$Target = Join-Path $InstallDir "AI-Lover.exe"
if (-not (Test-Path -LiteralPath $Target)) {
  $Target = Join-Path $InstallDir "Start_AI-Lover.bat"
}

$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $Target
$Shortcut.WorkingDirectory = $InstallDir
$Shortcut.IconLocation = $Target
$Shortcut.Description = "AI-Lover launcher"
$Shortcut.Save()

Write-Host ""
Write-Host "Install complete. A desktop shortcut named AI-Lover has been created." -ForegroundColor Green
Write-Host "Double-click AI-Lover on the desktop to start."
Start-Sleep -Seconds 5
