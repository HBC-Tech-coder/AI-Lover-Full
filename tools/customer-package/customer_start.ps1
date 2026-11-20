param(
  [string]$HeadIp,
  [string]$AgentServerUrl,
  [string]$AgentWsProxyUrl,
  [string]$HeadAudioCard,
  [int]$GesturePort = 0,
  [int]$HandCameraIndex = -1,
  [string]$HandArduinoPorts,
  [switch]$HandRealSerial,
  [switch]$HandOrca,
  [switch]$SkipGestureBridge
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $Root "customer_config.ps1"
$HeadIpFromCommand = $PSBoundParameters.ContainsKey("HeadIp") -and $HeadIp
if (Test-Path -LiteralPath $ConfigPath) {
  . $ConfigPath
}

function Use-Default([object]$Value, [object]$Default) {
  if ($null -eq $Value) { return $Default }
  if ($Value -is [string] -and -not $Value.Trim()) { return $Default }
  if ($Value -is [int] -and $Value -lt 0) { return $Default }
  return $Value
}

function Get-SavedHeadIp {
  param([string]$AppRoot)

  $ConfigFile = Join-Path $AppRoot "local_hardware_config.json"
  if (-not (Test-Path -LiteralPath $ConfigFile)) {
    return ""
  }

  try {
    $Saved = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
    foreach ($Name in @("robotHeadIp", "headIp", "HEAD_IP")) {
      $Value = $Saved.$Name
      if ($Value -and "$Value".Trim()) {
        return "$Value".Trim()
      }
    }
  } catch {
    Write-Warning "Cannot read saved hardware config: $($_.Exception.Message)"
  }

  return ""
}

function Repair-HandPythonConfig {
  param([string]$AppRoot)

  $HandCfg = Join-Path $AppRoot "runtime\hand-python\pyvenv.cfg"
  $PythonHome = Join-Path $AppRoot "runtime\python311"
  $PythonExe = Join-Path $PythonHome "python.exe"
  if (-not (Test-Path -LiteralPath $HandCfg) -or -not (Test-Path -LiteralPath $PythonExe)) {
    return
  }

  @(
    "home = $PythonHome"
    "include-system-site-packages = false"
    "version = 3.11.9"
    "executable = $PythonExe"
    "command = $PythonExe -m venv $((Join-Path $AppRoot 'runtime\hand-python'))"
  ) | Set-Content -LiteralPath $HandCfg -Encoding UTF8
}

function Ensure-HandPythonDependencies {
  param([string]$AppRoot)

  $HandPython = Join-Path $AppRoot "runtime\hand-python\Scripts\python.exe"
  if (-not (Test-Path -LiteralPath $HandPython)) {
    return
  }

  $VendorRoot = Join-Path $AppRoot "hardware\gesture_vendor\CoDexterousHand"
  $VendorTeleop = Join-Path $VendorRoot "orca_teleop\src"
  $OldPythonPath = $env:PYTHONPATH
  $env:PYTHONPATH = @($VendorRoot, $VendorTeleop, $OldPythonPath) -join ";"
  $CheckCode = @'
import importlib, json
mods = {
  "opencv-python": "cv2",
  "mediapipe": "mediapipe",
  "pyserial": "serial",
  "pyyaml": "yaml",
  "dynamixel-sdk": "dynamixel_sdk",
}
missing = []
for package, module in mods.items():
  try:
    importlib.import_module(module)
  except Exception:
    missing.append(package)
print(json.dumps(missing))
'@
  try {
    $MissingJson = & $HandPython -c $CheckCode 2>$null
    $Missing = @()
    if ($MissingJson) {
      $Missing = @($MissingJson | ConvertFrom-Json)
    }
    if ($Missing.Count -gt 0) {
      Write-Host "Installing missing hand dependencies: $($Missing -join ', ')" -ForegroundColor Yellow
      & $HandPython -m ensurepip --upgrade | Out-Host
      & $HandPython -m pip install --upgrade pip | Out-Host
      & $HandPython -m pip install @Missing | Out-Host
    }
  } catch {
    Write-Warning "Hand dependency self-check failed: $($_.Exception.Message)"
  } finally {
    $env:PYTHONPATH = $OldPythonPath
  }
}

function Ensure-TenOptionalPythonDependencies {
  param([string]$AppRoot)

  $PythonCandidates = @(
    (Join-Path $AppRoot "runtime\python311\python.exe"),
    (Join-Path $AppRoot "runtime\hand-python\Scripts\python.exe")
  )
  $PythonExe = $PythonCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $PythonExe) {
    return
  }

  $CheckCode = @'
import importlib, json
mods = {
  "speechmatics-python==3.0.2": "speechmatics",
  "aiofiles": "aiofiles",
  "pydantic": "pydantic",
}
missing = []
for package, module in mods.items():
  try:
    importlib.import_module(module)
  except Exception:
    missing.append(package)
print(json.dumps(missing))
'@
  try {
    $MissingJson = & $PythonExe -c $CheckCode 2>$null
    $Missing = @()
    if ($MissingJson) {
      $Missing = @($MissingJson | ConvertFrom-Json)
    }
    if ($Missing.Count -gt 0) {
      Write-Host "Installing optional TEN diarization dependencies: $($Missing -join ', ')" -ForegroundColor Yellow
      & $PythonExe -m ensurepip --upgrade | Out-Host
      & $PythonExe -m pip install --upgrade pip | Out-Host
      & $PythonExe -m pip install @Missing | Out-Host
    }
  } catch {
    Write-Warning "TEN optional dependency self-check failed: $($_.Exception.Message)"
  }
}

$DefaultHeadIp = "192.168.110.63"
$ConfiguredHeadIp = $HeadIp
$SavedHeadIp = Get-SavedHeadIp -AppRoot $Root
if (
  -not $HeadIpFromCommand -and
  $SavedHeadIp -and
  (
    -not $ConfiguredHeadIp -or
    "$ConfiguredHeadIp".Trim() -eq $DefaultHeadIp -or
    $SavedHeadIp -ne $DefaultHeadIp
  )
) {
  $HeadIp = $SavedHeadIp
}
$HeadIp = Use-Default $HeadIp $DefaultHeadIp
$AgentServerUrl = Use-Default $AgentServerUrl "http://47.95.119.182:8080"
$AgentWsProxyUrl = Use-Default $AgentWsProxyUrl "wss://ai.vituralmodel.com"
$HeadAudioCard = Use-Default $HeadAudioCard "auto"
$GesturePort = Use-Default $GesturePort 8791
$HandCameraIndex = Use-Default $HandCameraIndex 0
$HandArduinoPorts = Use-Default $HandArduinoPorts ""

Repair-HandPythonConfig -AppRoot $Root
Ensure-HandPythonDependencies -AppRoot $Root
Ensure-TenOptionalPythonDependencies -AppRoot $Root

$StartScript = Join-Path $Root "start_local_robot_agent.ps1"
if (-not (Test-Path -LiteralPath $StartScript)) {
  throw "Cannot find start_local_robot_agent.ps1 in $Root"
}

Write-Host ""
Write-Host "AI-Lover is starting. Please wait..." -ForegroundColor Cyan
Write-Host "Robot head IP: $HeadIp"
Write-Host "Service endpoint: $AgentServerUrl"
Write-Host ""

$Params = @{
  HeadIp = $HeadIp
  AgentServerUrl = $AgentServerUrl
  AgentWsProxyUrl = $AgentWsProxyUrl
  HeadAudioCard = $HeadAudioCard
  GesturePort = $GesturePort
  HandCameraIndex = $HandCameraIndex
  HandArduinoPorts = $HandArduinoPorts
}
if ($HandRealSerial) { $Params.HandRealSerial = $true }
if ($HandOrca) { $Params.HandOrca = $true }
if ($SkipGestureBridge) { $Params.SkipGestureBridge = $true }

try {
  & $StartScript @Params
  Start-Process "http://127.0.0.1:3000/"
  Write-Host ""
  Write-Host "Started. The browser should open automatically. If it does not, visit http://127.0.0.1:3000/" -ForegroundColor Green
  Start-Sleep -Seconds 5
} catch {
  Write-Host ""
  Write-Host "Start failed:" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host ""
  Write-Host "Please send a screenshot of this window to support." -ForegroundColor Yellow
  Read-Host "Press Enter to exit"
  exit 1
}
