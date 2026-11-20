param(
  [switch]$WithOrca
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Venv = Join-Path $Root ".venv-hand-gesture"
$Requirements = Join-Path $Root "hardware\gesture_arm_requirements.txt"

$Python = (Get-Command py -ErrorAction SilentlyContinue).Source
if ($Python) {
  & $Python -3.11 -m venv $Venv
} else {
  $Python = (Get-Command python -ErrorAction Stop).Source
  & $Python -m venv $Venv
}

$VenvPython = Join-Path $Venv "Scripts\python.exe"
& $VenvPython -m pip install --upgrade pip wheel setuptools
& $VenvPython -m pip install -r $Requirements
& $VenvPython -m pip install torch --index-url https://download.pytorch.org/whl/cpu
& $VenvPython -m pip install dynamixel-sdk pytorch-kinematics

if ($WithOrca) {
  Write-Host "-WithOrca is now the default dependency set; nothing extra to install."
}

Write-Host "Hand gesture bridge environment ready: $VenvPython"
Write-Host "Start it with: .\start_hand_gesture_bridge.ps1"
