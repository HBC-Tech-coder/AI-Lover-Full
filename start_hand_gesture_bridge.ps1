param(
  [int]$Port = 8791,
  [int]$CameraIndex = 0,
  [string]$ArduinoPorts = "",
  [int]$Baud = 9600,
  [switch]$RealSerial,
  [switch]$Orca
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Bridge = Join-Path $Root "hardware\gesture_arm_bridge.py"
$VenvPython = Join-Path $Root ".venv-hand-gesture\Scripts\python.exe"
$BundledPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"

if (Test-Path -LiteralPath $VenvPython) {
  $Python = $VenvPython
} elseif ((Get-Command python -ErrorAction SilentlyContinue).Source) {
  $Python = (Get-Command python).Source
} elseif (Test-Path -LiteralPath $BundledPython) {
  $Python = $BundledPython
} else {
  throw "Python not found. Run setup_hand_gesture_bridge.ps1 after installing Python 3.11."
}

$env:HAND_GESTURE_HOST = "127.0.0.1"
$env:HAND_GESTURE_PORT = [string]$Port
$env:HAND_GESTURE_CAMERA_INDEX = [string]$CameraIndex
$env:HAND_GESTURE_ARDUINO_PORTS = $ArduinoPorts
$env:HAND_GESTURE_BAUD = [string]$Baud
$env:HAND_GESTURE_DRY_RUN = if ($RealSerial) { "0" } else { "1" }
$env:HAND_GESTURE_ARDUINO_ENABLED = "1"
$env:HAND_GESTURE_ORCA_ENABLED = if ($Orca) { "1" } else { "0" }
$env:HAND_GESTURE_PACKAGE_ROOT = Join-Path $Root "hardware\gesture_vendor\CoDexterousHand"

Set-Location $Root
& $Python -u $Bridge
