param(
  [string]$Version = "2.0.4",
  [switch]$Minimal,
  [switch]$IncludeNodeModules,
  [switch]$SkipPythonRuntime,
  [string]$PublicDownloadsDir = ""
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$releaseRoot = Join-Path $root "release"
$packageRoot = Join-Path $releaseRoot "AI-Lover-Local-Connector-$Version"

function Remove-DirectoryInsideRelease([string]$PathToRemove) {
  $resolvedRelease = [System.IO.Path]::GetFullPath($releaseRoot)
  $resolvedTarget = [System.IO.Path]::GetFullPath($PathToRemove)
  if (-not $resolvedTarget.StartsWith($resolvedRelease, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove outside release directory: $resolvedTarget"
  }
  if (Test-Path $resolvedTarget) {
    Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
  }
}

function Copy-TreeIfExists([string]$Source, [string]$Destination) {
  if (-not (Test-Path $Source)) { return $false }
  New-Item -ItemType Directory -Force -Path (Split-Path $Destination -Parent) | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
  return $true
}

function Read-VenvHome([string]$VenvPath) {
  $cfg = Join-Path $VenvPath "pyvenv.cfg"
  if (-not (Test-Path $cfg)) { return "" }
  $line = Get-Content -LiteralPath $cfg | Where-Object { $_ -match "^\s*home\s*=\s*(.+?)\s*$" } | Select-Object -First 1
  if (-not $line) { return "" }
  return ($line -replace "^\s*home\s*=\s*", "").Trim()
}

function Copy-PackagedNodeRuntime() {
  $nodeSourceCandidates = @(
    (Join-Path $root "runtime\nodejs"),
    "C:\Program Files\nodejs",
    "C:\Program Files (x86)\nodejs",
    (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin")
  )
  $nodeSource = $nodeSourceCandidates | Where-Object { Test-Path (Join-Path $_ "node.exe") } | Select-Object -First 1
  if ($nodeSource) {
    Write-Host "Copying bundled Node.js runtime from $nodeSource..."
    Copy-TreeIfExists $nodeSource (Join-Path $packageRoot "runtime\nodejs") | Out-Null
  } else {
    Write-Warning "Node.js runtime was not found. Customer machine will need Node.js installed."
  }
}

function Copy-PackagedPythonRuntime() {
  if ($SkipPythonRuntime -or $Minimal) {
    Write-Host "Skipping packaged Python runtime."
    return
  }

  $venvPath = Join-Path $root ".venv-hand-gesture"
  $venvHome = Read-VenvHome $venvPath
  $pythonSourceCandidates = @(
    (Join-Path $root "runtime\python311"),
    (Join-Path $root "local_runtime\python311"),
    $venvHome,
    (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python")
  ) | Where-Object { $_ -and (Test-Path (Join-Path $_ "python.exe")) }

  $pythonSource = $pythonSourceCandidates | Select-Object -First 1
  if (-not $pythonSource) {
    throw "Python runtime was not found. Install Python 3.11 or run setup_hand_gesture_bridge.ps1 first."
  }

  Write-Host "Copying Python runtime from $pythonSource..."
  Copy-TreeIfExists $pythonSource (Join-Path $packageRoot "runtime\python311") | Out-Null

  if (-not (Test-Path (Join-Path $venvPath "Scripts\python.exe"))) {
    throw ".venv-hand-gesture was not found. Run setup_hand_gesture_bridge.ps1 before building the customer connector package."
  }

  Write-Host "Copying hand gesture Python environment. This can take a while..."
  $handPythonTarget = Join-Path $packageRoot "runtime\hand-python"
  Copy-TreeIfExists $venvPath $handPythonTarget | Out-Null

  $runtimePythonHome = Join-Path $packageRoot "runtime\python311"
  $runtimePythonExe = Join-Path $runtimePythonHome "python.exe"
  @(
    "home = $runtimePythonHome",
    "include-system-site-packages = false",
    "version = 3.11",
    "executable = $runtimePythonExe",
    "command = $runtimePythonExe -m venv $handPythonTarget",
    ""
  ) | Set-Content -LiteralPath (Join-Path $handPythonTarget "pyvenv.cfg") -Encoding UTF8
}

function Copy-PackagedAdb() {
  $adbCandidates = @(
    (Join-Path $root "runtime\platform-tools"),
    (Join-Path (Split-Path $root -Parent) "android-platform-tools\platform-tools"),
    "C:\android-platform-tools\platform-tools",
    "D:\android-platform-tools\platform-tools",
    (Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools")
  )
  $adbSource = $adbCandidates | Where-Object { Test-Path (Join-Path $_ "adb.exe") } | Select-Object -First 1
  if ($adbSource) {
    Write-Host "Copying Android platform-tools from $adbSource..."
    Copy-TreeIfExists $adbSource (Join-Path $packageRoot "runtime\platform-tools") | Out-Null
  } else {
    Write-Warning "adb.exe was not found. Robot-head network/USB ADB control may require Android platform-tools."
  }
}

function Write-Manuals() {
  $manualHtmlSource = Join-Path $root "docs\local-connector-user-guide-zh.html"
  $manualTextSource = Join-Path $root "docs\local-connector-user-guide-zh.txt"
  if (-not (Test-Path $manualHtmlSource)) {
    throw "Missing manual template: $manualHtmlSource"
  }
  if (-not (Test-Path $manualTextSource)) {
    throw "Missing manual template: $manualTextSource"
  }
  Copy-Item -LiteralPath $manualHtmlSource -Destination (Join-Path $packageRoot "AI-Lover-Local-Connector-User-Guide-zh.html") -Force
  Copy-Item -LiteralPath $manualTextSource -Destination (Join-Path $packageRoot "AI-Lover-Local-Connector-User-Guide-zh.txt") -Force
}

function Write-StartScripts() {
  @(
    "@echo off",
    "chcp 65001 >nul",
    "cd /d ""%~dp0""",
    "echo AI-Lover Local Connector",
    "echo.",
    "echo Paste the pairing code from the AI-Lover web settings, then press Enter.",
    "echo Keep this window open after the connector is online.",
    "echo.",
    "call ""tools\local-connector\start_local_connector_windows.cmd"""
  ) | Set-Content -LiteralPath (Join-Path $packageRoot "START-HERE.bat") -Encoding ASCII

  @(
    "@echo off",
    "chcp 65001 >nul",
    "cd /d ""%~dp0""",
    "call ""START-HERE.bat"""
  ) | Set-Content -LiteralPath (Join-Path $packageRoot "Start Local Connector.bat") -Encoding ASCII

  @(
    "#!/bin/bash",
    'cd "$(dirname "$0")"',
    "echo ""AI-Lover Local Connector""",
    "echo ""Please paste the pairing code shown on the AI-Lover web page.""",
    "echo ""After the connector is online, keep this window open.""",
    "exec tools/local-connector/start_local_connector_macos.command"
  ) | Set-Content -LiteralPath (Join-Path $packageRoot "Start Local Connector.command") -Encoding ASCII
}

function Write-Readme() {
  @(
    "AI-Lover Local Connector $Version",
    "",
    "Purpose:",
    "Cloud pages cannot directly reach private LAN robot heads, ADB, serial ports, or local hand bridges.",
    "Run this Local Connector on the customer's computer, then pair it from https://ai.vituralmodel.com.",
    "",
    "Quick start:",
    "1. Unzip the whole package.",
    "2. Double click START-HERE.bat.",
    "3. Paste the pairing code from the web page.",
    "4. Keep the black window open.",
    "5. Return to the web page and click Detect Local Connector.",
    "6. If the Internet is unavailable or cloud control feels delayed, open http://127.0.0.1:3000/local-control after START-HERE.bat is running.",
    "",
    "Chinese manuals:",
    "- AI-Lover-Local-Connector-User-Guide-zh.html",
    "- AI-Lover-Local-Connector-User-Guide-zh.txt",
    "- tools\local-connector\README-LOCAL-CONNECTOR-zh.txt",
    "",
    "Offline local console:",
    "- http://127.0.0.1:3000/local-control",
    "- Use it for head/hand/camera/gesture testing without cloud AI conversation.",
    "- Multiple Arduino hands are supported by entering ports like COM5,COM6."
  ) | Set-Content -LiteralPath (Join-Path $packageRoot "README-LOCAL-CONNECTOR.txt") -Encoding ASCII
}

New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null
Remove-DirectoryInsideRelease $packageRoot
New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null

Write-Host "Building frontend..."
Push-Location (Join-Path $root "frontend")
npm run build
Pop-Location

$copyItems = @(
  "frontend\.next",
  "frontend\public",
  "frontend\server.js",
  "frontend\package.json",
  "frontend\package-lock.json",
  "hardware",
  "workers\gpu_avatar_worker",
  "tools\local-connector",
  "local_hardware_config.json"
)

foreach ($item in $copyItems) {
  $source = Join-Path $root $item
  $target = Join-Path $packageRoot $item
  Copy-TreeIfExists $source $target | Out-Null
}

Copy-PackagedNodeRuntime
Copy-PackagedAdb
Copy-PackagedPythonRuntime

$copyFullNodeModules = $IncludeNodeModules -or (-not $Minimal)
if ($copyFullNodeModules) {
  $nodeModules = Join-Path $root "frontend\node_modules"
  if (-not (Test-Path $nodeModules)) {
    throw "frontend/node_modules was not found. Run npm install in frontend first."
  }
  Write-Host "Copying complete frontend node_modules. This can take a while..."
  Copy-TreeIfExists $nodeModules (Join-Path $packageRoot "frontend\node_modules") | Out-Null
} else {
  $wsModule = Join-Path $root "frontend\node_modules\ws"
  if (-not (Test-Path $wsModule)) {
    throw "frontend/node_modules/ws was not found. Run npm install in frontend first."
  }
  Write-Host "Copying minimal Local Connector dependency: ws..."
  Copy-TreeIfExists $wsModule (Join-Path $packageRoot "frontend\node_modules\ws") | Out-Null
  @(
    "This is a minimal development package.",
    "It can connect to the cloud bridge, but it cannot start the local Next.js hardware API server.",
    "For customer delivery, build without -Minimal so frontend/node_modules and Python runtimes are included."
  ) | Set-Content -LiteralPath (Join-Path $packageRoot "INSTALL_NOTE.txt") -Encoding ASCII
}

Write-Manuals
Write-Readme
Write-StartScripts

$zipPath = Join-Path $releaseRoot "AI-Lover-Local-Connector-$Version.zip"
if (Test-Path $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}
$tarExe = Get-Command tar.exe -ErrorAction SilentlyContinue
if ($tarExe) {
  Push-Location $releaseRoot
  & $tarExe.Source -a -cf (Split-Path $zipPath -Leaf) (Split-Path $packageRoot -Leaf)
  Pop-Location
  if ($LASTEXITCODE -ne 0) {
    throw "tar.exe failed to create $zipPath"
  }
} else {
  Compress-Archive -LiteralPath $packageRoot -DestinationPath $zipPath -Force
}
Write-Host "Package written: $zipPath"

if (-not [string]::IsNullOrWhiteSpace($PublicDownloadsDir)) {
  $downloadsPath = if ([System.IO.Path]::IsPathRooted($PublicDownloadsDir)) {
    $PublicDownloadsDir
  } else {
    Join-Path $root $PublicDownloadsDir
  }
  New-Item -ItemType Directory -Force -Path $downloadsPath | Out-Null
  $publicZipPath = Join-Path $downloadsPath (Split-Path $zipPath -Leaf)
  Copy-Item -LiteralPath $zipPath -Destination $publicZipPath -Force
  Write-Host "Public download copied: $publicZipPath"
}
