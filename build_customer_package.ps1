param(
  [string]$OutputDir = "",
  [string]$PackageName = "",
  [switch]$NoZip,
  [switch]$NoSecrets
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Version = (Get-Content -LiteralPath (Join-Path $Root "VERSION") -Raw).Trim()
if (-not $OutputDir) { $OutputDir = Join-Path $Root "dist-customer" }
if (-not $PackageName) { $PackageName = "AI-Lover-$Version-customer-win64" }

$PackageRoot = Join-Path $OutputDir $PackageName
$AppRoot = Join-Path $PackageRoot "app"
$RuntimeRoot = Join-Path $AppRoot "runtime"

function Invoke-RoboCopyChecked {
  param(
    [string]$Source,
    [string]$Destination,
    [string[]]$ExcludeDirs = @(),
    [string[]]$ExcludeFiles = @()
  )

  if (-not (Test-Path -LiteralPath $Source)) {
    Write-Host "Skip missing: $Source"
    return
  }

  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  $args = @($Source, $Destination, "/MIR", "/R:2", "/W:1", "/NFL", "/NDL", "/NP")
  if ($ExcludeDirs.Count) { $args += "/XD"; $args += $ExcludeDirs }
  if ($ExcludeFiles.Count) { $args += "/XF"; $args += $ExcludeFiles }
  & robocopy @args | Out-Host
  if ($LASTEXITCODE -gt 7) {
    throw "robocopy failed from $Source to $Destination with exit code $LASTEXITCODE"
  }
}

function Copy-FileIfExists {
  param([string]$Source, [string]$Destination)
  if (Test-Path -LiteralPath $Source) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
  }
}

function Assert-ReadableChineseDocs {
  $Utf8Strict = [System.Text.UTF8Encoding]::new($false, $true)
  $Targets = @(
    (Join-Path $Root "README.md"),
    (Join-Path $Root "hardware\README_HEAD_MOTION.md"),
    (Join-Path $Root "tools\customer-package\README_CUSTOMER.txt")
  )
  $Targets += Get-ChildItem -LiteralPath (Join-Path $Root "docs") -Recurse -File |
    Where-Object { $_.Extension -in @(".md", ".txt") } |
    Select-Object -ExpandProperty FullName

  $BadPatterns = @(
    "$([char]0x935A)", # mojibake often seen for Chinese text opened as GBK
    "$([char]0x9417)",
    "$([char]0x9225)",
    "$([char]0x951B)",
    "$([char]0x6D93)$([char]0x20AC)",
    "$([char]0x8133)"
  )
  foreach ($Target in $Targets) {
    if (-not (Test-Path -LiteralPath $Target)) { continue }
    try {
      $Text = $Utf8Strict.GetString([System.IO.File]::ReadAllBytes($Target))
    } catch {
      throw "Documentation is not valid UTF-8: $Target"
    }
    foreach ($Pattern in $BadPatterns) {
      if ($Text.Contains($Pattern)) {
        throw "Possible mojibake in documentation: $Target contains '$Pattern'"
      }
    }
    foreach ($Char in $Text.ToCharArray()) {
      $Code = [int][char]$Char
      if ($Code -ge 0xE000 -and $Code -le 0xF8FF) {
        throw "Possible mojibake/private-use character in documentation: $Target"
      }
    }
  }
}

Assert-ReadableChineseDocs

if (Test-Path -LiteralPath $PackageRoot) {
  Remove-Item -LiteralPath $PackageRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $AppRoot -Force | Out-Null

Write-Host "Packaging app files..."

$RootFiles = @(
  "README.md",
  "CHANGELOG.md",
  "VERSION",
  "start_local_robot_agent.ps1",
  "setup_hand_gesture_bridge.ps1",
  "start_hand_gesture_bridge.ps1",
  "start_live2d_worker.ps1",
  "start_live2d_worker_cubism_open.ps1",
  "start_gpu_avatar_image_worker.ps1",
  "secrets.env.example"
)
foreach ($File in $RootFiles) {
  Copy-FileIfExists (Join-Path $Root $File) (Join-Path $AppRoot $File)
}
if (-not $NoSecrets) {
  Copy-FileIfExists (Join-Path $Root "secrets.env") (Join-Path $AppRoot "secrets.env")
}

Invoke-RoboCopyChecked (Join-Path $Root "frontend") (Join-Path $AppRoot "frontend") `
  -ExcludeDirs @(
    (Join-Path $Root "frontend\.next\cache")
  ) `
  -ExcludeFiles @(".local-dev-server.log", ".local-dev-server.err.log")
Invoke-RoboCopyChecked (Join-Path $Root "hardware") (Join-Path $AppRoot "hardware")
Invoke-RoboCopyChecked (Join-Path $Root "scripts") (Join-Path $AppRoot "scripts")
Invoke-RoboCopyChecked (Join-Path $Root "docs") (Join-Path $AppRoot "docs")
Invoke-RoboCopyChecked (Join-Path $Root "workers") (Join-Path $AppRoot "workers")

Write-Host "Packaging local HTTPS certificate if available..."
$CertRoot = Join-Path $Root "certs"
$CertOutput = Join-Path $AppRoot "certs"
if (-not (Test-Path -LiteralPath (Join-Path $CertRoot "ai-lover-local.pfx"))) {
  $CertScript = Join-Path $Root "tools\create-local-https-cert.ps1"
  if (Test-Path -LiteralPath $CertScript) {
    Write-Host "Local HTTPS certificate not found; creating one for the package..."
    & $CertScript -OutputDir $CertRoot | Out-Host
  }
}
Copy-FileIfExists (Join-Path $CertRoot "ai-lover-local.pfx") (Join-Path $CertOutput "ai-lover-local.pfx")
Copy-FileIfExists (Join-Path $CertRoot "ai-lover-local.cer") (Join-Path $CertOutput "ai-lover-local.cer")

Write-Host "Packaging runtimes..."
$NodeSource = "C:\Program Files\nodejs"
if (Test-Path -LiteralPath $NodeSource) {
  Invoke-RoboCopyChecked $NodeSource (Join-Path $RuntimeRoot "nodejs")
} else {
  Write-Warning "Node.js runtime not found at $NodeSource. Customer machine must install Node.js."
}

$Python311Source = Join-Path $env:LOCALAPPDATA "Programs\Python\Python311"
if (Test-Path -LiteralPath $Python311Source) {
  Invoke-RoboCopyChecked $Python311Source (Join-Path $RuntimeRoot "python311")
} else {
  $BundledPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python"
  Invoke-RoboCopyChecked $BundledPython (Join-Path $RuntimeRoot "python")
}

$AdbSource = Join-Path $env:USERPROFILE "xiaoling_local_dev\android-platform-tools\platform-tools"
Invoke-RoboCopyChecked $AdbSource (Join-Path $RuntimeRoot "platform-tools")

$HandPythonSource = Join-Path $Root ".venv-hand-gesture"
Invoke-RoboCopyChecked $HandPythonSource (Join-Path $RuntimeRoot "hand-python") `
  -ExcludeDirs @((Join-Path $HandPythonSource "__pycache__"))

$HandCfg = Join-Path $RuntimeRoot "hand-python\pyvenv.cfg"
$PythonHome = Join-Path $RuntimeRoot "python311"
$PythonExe = Join-Path $PythonHome "python.exe"
if ((Test-Path -LiteralPath $HandCfg) -and (Test-Path -LiteralPath $PythonExe)) {
  @(
    "home = $PythonHome"
    "include-system-site-packages = false"
    "version = 3.11.9"
    "executable = $PythonExe"
    "command = $PythonExe -m venv $((Join-Path $RuntimeRoot 'hand-python'))"
  ) | Set-Content -LiteralPath $HandCfg -Encoding UTF8
}

$RequiredRuntimeFiles = @(
  (Join-Path $RuntimeRoot "nodejs\node.exe"),
  (Join-Path $RuntimeRoot "platform-tools\adb.exe"),
  (Join-Path $RuntimeRoot "hand-python\Scripts\python.exe")
)
if (-not (Test-Path -LiteralPath (Join-Path $RuntimeRoot "python311\python.exe")) -and
    -not (Test-Path -LiteralPath (Join-Path $RuntimeRoot "python\python.exe"))) {
  throw "Packaged Python runtime is missing from $RuntimeRoot."
}
foreach ($RequiredFile in $RequiredRuntimeFiles) {
  if (-not (Test-Path -LiteralPath $RequiredFile)) {
    throw "Required packaged runtime file is missing: $RequiredFile"
  }
}

Write-Host "Packaging customer launcher files..."
$CustomerTools = Join-Path $Root "tools\customer-package"
Copy-FileIfExists (Join-Path $CustomerTools "customer_start.ps1") (Join-Path $AppRoot "customer_start.ps1")
Copy-FileIfExists (Join-Path $CustomerTools "customer_stop.ps1") (Join-Path $AppRoot "customer_stop.ps1")
Copy-FileIfExists (Join-Path $CustomerTools "customer_config.ps1") (Join-Path $AppRoot "customer_config.ps1")
Copy-FileIfExists (Join-Path $CustomerTools "README_CUSTOMER.txt") (Join-Path $PackageRoot "README_CUSTOMER.txt")
Copy-FileIfExists (Join-Path $CustomerTools "install_ai_lover.ps1") (Join-Path $PackageRoot "install_ai_lover.ps1")
Copy-FileIfExists (Join-Path $CustomerTools "uninstall_ai_lover.ps1") (Join-Path $PackageRoot "uninstall_ai_lover.ps1")

@'
@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_ai_lover.ps1"
if errorlevel 1 pause
'@ | Set-Content -LiteralPath (Join-Path $PackageRoot "Install_AI-Lover.bat") -Encoding OEM

@'
@echo off
chcp 65001 >nul
set "SCRIPT=%~dp0customer_start.ps1"
if not exist "%SCRIPT%" set "SCRIPT=%~dp0app\customer_start.ps1"
if not exist "%SCRIPT%" (
  echo Cannot find customer_start.ps1.
  echo Please run this file from the AI-Lover package root or installed app folder.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
if errorlevel 1 pause
'@ | Set-Content -LiteralPath (Join-Path $PackageRoot "Start_AI-Lover.bat") -Encoding OEM

@'
@echo off
chcp 65001 >nul
set "SCRIPT=%~dp0customer_stop.ps1"
if not exist "%SCRIPT%" set "SCRIPT=%~dp0app\customer_stop.ps1"
if not exist "%SCRIPT%" (
  echo Cannot find customer_stop.ps1.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
'@ | Set-Content -LiteralPath (Join-Path $PackageRoot "Stop_AI-Lover.bat") -Encoding OEM

@'
@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall_ai_lover.ps1"
if errorlevel 1 pause
'@ | Set-Content -LiteralPath (Join-Path $PackageRoot "Uninstall_AI-Lover.bat") -Encoding OEM

Copy-Item -LiteralPath (Join-Path $PackageRoot "Start_AI-Lover.bat") -Destination (Join-Path $AppRoot "Start_AI-Lover.bat") -Force

@'
@echo off
chcp 65001 >nul
set "SCRIPT=%~dp0customer_start.ps1"
if not exist "%SCRIPT%" set "SCRIPT=%~dp0app\customer_start.ps1"
if not exist "%SCRIPT%" (
  echo Cannot find customer_start.ps1.
  echo Please run this file from the AI-Lover package root or installed app folder.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
if errorlevel 1 pause
'@ | Set-Content -LiteralPath (Join-Path $AppRoot "Start_AI-Lover.bat") -Encoding OEM

@'
@echo off
chcp 65001 >nul
set "SCRIPT=%~dp0customer_stop.ps1"
if not exist "%SCRIPT%" set "SCRIPT=%~dp0app\customer_stop.ps1"
if not exist "%SCRIPT%" (
  echo Cannot find customer_stop.ps1.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
'@ | Set-Content -LiteralPath (Join-Path $AppRoot "Stop_AI-Lover.bat") -Encoding OEM

Write-Host "Building launcher exe..."
& (Join-Path $Root "build_windows_exe.ps1") -OutputPath (Join-Path $AppRoot "AI-Lover.exe")
Copy-Item -LiteralPath (Join-Path $AppRoot "AI-Lover.exe") -Destination (Join-Path $PackageRoot "AI-Lover.exe") -Force

$Manifest = [ordered]@{
  name = "AI-Lover"
  version = $Version
  builtAt = (Get-Date).ToString("s")
  includeSecrets = -not $NoSecrets
  defaultUrl = "http://127.0.0.1:3000/"
  installDir = "%LOCALAPPDATA%\AI-Lover"
}
$Manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $PackageRoot "package-manifest.json") -Encoding UTF8

if (-not $NoZip) {
  $ZipPath = Join-Path $OutputDir "$PackageName.zip"
  if (Test-Path -LiteralPath $ZipPath) {
    Remove-Item -LiteralPath $ZipPath -Force
  }
  Write-Host "Creating zip: $ZipPath"
  Compress-Archive -Path (Join-Path $PackageRoot "*") -DestinationPath $ZipPath -Force
}

Write-Host ""
Write-Host "Customer package ready:" -ForegroundColor Green
Write-Host $PackageRoot
if (-not $NoZip) { Write-Host (Join-Path $OutputDir "$PackageName.zip") }


