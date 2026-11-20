param(
  [string]$HeadIp = "192.168.110.63",
  [string]$AgentServerUrl = "https://ai.vituralmodel.com/api/agents",
  [string]$AgentWsProxyUrl = "wss://ai.vituralmodel.com",
  [string]$HeadAudioCard = "auto",
  [int]$GesturePort = 8791,
  [int]$HandCameraIndex = 0,
  [string]$HandArduinoPorts = "",
  [switch]$HandRealSerial,
  [switch]$HandOrca,
  [switch]$SkipGestureBridge,
  [switch]$EagerHeadBridge
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$SecretsLoader = Join-Path $Root "scripts\Import-SecretsEnv.ps1"
if (Test-Path -LiteralPath $SecretsLoader) {
  . $SecretsLoader -Path (Join-Path $Root "secrets.env")
}

$Frontend = Join-Path $Root "frontend"
if ($env:AI_LOVER_LOG_DIR) {
  $Logs = $env:AI_LOVER_LOG_DIR
} elseif ($env:LOCALAPPDATA) {
  $Logs = Join-Path $env:LOCALAPPDATA "AI-Lover\local_logs"
} else {
  $Logs = Join-Path $Root "local_logs"
}
$Bridge = Join-Path $Root "hardware\head_motion_bridge.py"
$GestureBridge = Join-Path $Root "hardware\gesture_arm_bridge.py"
$Runtime = Join-Path $Root "runtime"
$AdbCandidates = @(
  Join-Path $Runtime "platform-tools\adb.exe"
  Join-Path $Root "android-platform-tools\platform-tools\adb.exe"
  Join-Path $env:USERPROFILE "xiaoling_local_dev\android-platform-tools\platform-tools\adb.exe"
  Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
  "D:\android-platform-tools\platform-tools\adb.exe"
  "C:\android-platform-tools\platform-tools\adb.exe"
)
$Adb = $null
foreach ($Candidate in $AdbCandidates) {
  if (Test-Path -LiteralPath $Candidate) {
    $Adb = $Candidate
    break
  }
}
if (-not $Adb) {
  $FoundAdb = (Get-Command adb -ErrorAction SilentlyContinue).Source
  if ($FoundAdb) { $Adb = $FoundAdb }
}
$HasAdb = $Adb -and (Test-Path -LiteralPath $Adb)
$NodeCandidates = @(
  Join-Path $Runtime "nodejs\node.exe"
  Join-Path $Runtime "node\node.exe"
)
$Node = $null
foreach ($Candidate in $NodeCandidates) {
  if (Test-Path -LiteralPath $Candidate) {
    $Node = $Candidate
    break
  }
}
if (-not $Node) {
  $FoundNode = (Get-Command node -ErrorAction SilentlyContinue).Source
  if ($FoundNode) { $Node = $FoundNode }
}
$AdbSerial = "${HeadIp}:5555"
$BundledPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"

$PythonCandidates = @(
  Join-Path $Runtime "python\python.exe"
  Join-Path $Runtime "python311\python.exe"
  $BundledPython
)
$Python = $null
foreach ($Candidate in $PythonCandidates) {
  if (Test-Path -LiteralPath $Candidate) {
    $Python = $Candidate
    break
  }
}
if (-not $Python) {
  $FoundPython = (Get-Command python -ErrorAction SilentlyContinue).Source
  if ($FoundPython) { $Python = $FoundPython }
}

$HandVenvPython = Join-Path $Root ".venv-hand-gesture\Scripts\python.exe"
$PackagedHandPython = Join-Path $Runtime "hand-python\Scripts\python.exe"
if (Test-Path -LiteralPath $PackagedHandPython) {
  $HandPython = $PackagedHandPython
} elseif (Test-Path -LiteralPath $HandVenvPython) {
  $HandPython = $HandVenvPython
} elseif ((Get-Command python -ErrorAction SilentlyContinue).Source) {
  $HandPython = (Get-Command python).Source
} else {
  $HandPython = $Python
}

New-Item -ItemType Directory -Path $Logs -Force | Out-Null
$RunId = Get-Date -Format "yyyyMMdd-HHmmss-fff"

function Test-TcpPortOpen {
  param(
    [string]$HostName,
    [int]$Port,
    [int]$TimeoutMs = 500
  )

  $Client = [System.Net.Sockets.TcpClient]::new()
  try {
    $ConnectTask = $Client.ConnectAsync($HostName, $Port)
    if (-not $ConnectTask.Wait($TimeoutMs)) {
      return $false
    }
    return $Client.Connected
  } catch {
    return $false
  } finally {
    $Client.Dispose()
  }
}

foreach ($Port in 3000, 8787, $GesturePort) {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object {
      try {
        Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
      } catch {
        # The port owner may have exited between discovery and stop.
      }
    }
}

if (-not $Node -or -not (Test-Path -LiteralPath $Node)) {
  throw "node.exe not found. Use the customer package with runtime\nodejs, or install Node.js."
}
if (-not $Python -or -not (Test-Path -LiteralPath $Python)) {
  throw "python.exe not found. Use the customer package with runtime\python, or install Python."
}

if (-not $HasAdb) {
  Write-Warning "adb.exe not found. The web UI will still start, but robot-head control is disabled until runtime\platform-tools\adb.exe is present."
}

if ($HasAdb -and $EagerHeadBridge) {
  $BridgeOut = Join-Path $Logs "head_motion_bridge.$RunId.out.log"
  $BridgeErr = Join-Path $Logs "head_motion_bridge.$RunId.err.log"
  $BridgeCmd = @"
`$env:HEAD_MOTION_TRANSPORT='adb'
`$env:HEAD_MOTION_DRY_RUN='0'
`$env:HEAD_MOTION_ADB_SERIAL='$AdbSerial'
`$env:HEAD_MOTION_ADB_PATH='$Adb'
`$env:HEAD_MOTION_SERIAL_PORT='/dev/ttyS4'
`$env:HEAD_MOTION_BAUD='9600'
`$env:HEAD_MOTION_HOST='127.0.0.1'
`$env:HEAD_MOTION_PORT='8787'
`$env:HEAD_MOTION_ADB_ROOT='1'
`$env:HEAD_MOTION_ADB_USB_FALLBACK='1'
`$env:HEAD_MOTION_ADB_CONNECT_TIMEOUT_SEC='8'
`$env:HEAD_AUDIO_CARD='$HeadAudioCard'
`$env:HEAD_AUDIO_CARD_MATCH='realtek,rt5651,codec'
`$env:HEAD_AUDIO_CARD_FALLBACK='1'
`$env:HEAD_AUDIO_PLAYBACK_DEVICE='0'
`$env:HEAD_AUDIO_CAPTURE_DEVICE='0'
`$env:HEAD_AUDIO_PLAYBACK_VOLUME='31'
`$env:HEAD_AUDIO_PLAYBACK_SAMPLE_RATE='16000'
`$env:HEAD_AUDIO_PLAYBACK_SETUP='tinymix -D {card} ''OUT Playback Volume'' {volume} {volume}'
`$env:HEAD_AUDIO_CAPTURE_SETUP=''
`$env:HEAD_AUDIO_PLAYBACK_BATCH_WINDOW_MS='180'
`$env:HEAD_AUDIO_PLAYBACK_BATCH_MAX='10'
Set-Location '$Root'
& '$Python' -u '$Bridge' 1>> '$BridgeOut' 2>> '$BridgeErr'
"@
  Start-Process -FilePath powershell -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $BridgeCmd) -WindowStyle Hidden
}

if (-not $SkipGestureBridge) {
  $GestureOut = Join-Path $Logs "gesture_arm_bridge.$RunId.out.log"
  $GestureErr = Join-Path $Logs "gesture_arm_bridge.$RunId.err.log"
  $HandDryRunValue = if ($HandRealSerial) { "0" } else { "1" }
  $HandOrcaValue = if ($HandOrca) { "1" } else { "0" }
  $HandPackageRoot = Join-Path $Root "hardware\gesture_vendor\CoDexterousHand"
  $GestureCmd = @"
`$env:HAND_GESTURE_HOST='127.0.0.1'
`$env:HAND_GESTURE_PORT='$GesturePort'
`$env:HAND_GESTURE_CAMERA_INDEX='$HandCameraIndex'
`$env:HAND_GESTURE_ARDUINO_PORTS='$HandArduinoPorts'
`$env:HAND_GESTURE_BAUD='9600'
`$env:HAND_GESTURE_DRY_RUN='$HandDryRunValue'
`$env:HAND_GESTURE_ARDUINO_ENABLED='1'
`$env:HAND_GESTURE_ORCA_ENABLED='$HandOrcaValue'
`$env:HAND_GESTURE_PACKAGE_ROOT='$HandPackageRoot'
Set-Location '$Root'
& '$HandPython' -u '$GestureBridge' 1>> '$GestureOut' 2>> '$GestureErr'
"@
  Start-Process -FilePath powershell -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $GestureCmd) -WindowStyle Hidden
}

$FrontendOut = Join-Path $Logs "frontend.$RunId.out.log"
$FrontendErr = Join-Path $Logs "frontend.$RunId.err.log"
$FrontendAdbPath = if ($HasAdb) { $Adb } else { "" }
$AutoStartHead = if ($HasAdb -and -not $EagerHeadBridge) { "true" } else { "false" }
$HttpsPfx = Join-Path $Root "certs\ai-lover-local.pfx"
$HttpsEnabled = if (Test-Path -LiteralPath $HttpsPfx) { "true" } else { "false" }
$FrontendCmd = @"
`$env:NODE_ENV='production'
`$env:PORT='3000'
`$env:BIND_HOST='0.0.0.0'
`$env:AGENT_SERVER_URL='$AgentServerUrl'
`$env:AGENT_WS_PROXY_URL='$AgentWsProxyUrl'
`$env:AI_LOVER_LOG_DIR='$Logs'
`$env:AI_LOVER_HTTPS='$HttpsEnabled'
`$env:AI_LOVER_HTTPS_PORT='3443'
`$env:SSL_PFX_FILE='$HttpsPfx'
`$env:SSL_PFX_PASSPHRASE='ai-lover-local'
`$env:HEAD_MOTION_ADB_PATH='$FrontendAdbPath'
`$env:HEAD_MOTION_PYTHON='$Python'
`$env:HEAD_MOTION_HEAD_IP='$HeadIp'
`$env:HEAD_MOTION_ADB_CONNECT_TIMEOUT_SEC='8'
`$env:HAND_GESTURE_PYTHON='$HandPython'
`$env:AUTO_START_LOCAL_HARDWARE='$AutoStartHead'
`$env:NEXT_PUBLIC_HEAD_MOTION_ENABLED='true'
`$env:NEXT_PUBLIC_HEAD_MOTION_ENDPOINT='http://127.0.0.1:8787'
`$env:NEXT_PUBLIC_HAND_GESTURE_ENDPOINT='http://127.0.0.1:$GesturePort'
Set-Location '$Frontend'
& '$Node' 'server.js' 1>> '$FrontendOut' 2>> '$FrontendErr'
"@
Start-Process -FilePath powershell -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $FrontendCmd) -WindowStyle Hidden

for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-TcpPortOpen -HostName "127.0.0.1" -Port 3000 -TimeoutMs 500) {
    break
  }
  if ($i -eq 119) {
    throw "Web UI did not open port 3000 within 60 seconds. Check logs: $FrontendOut and $FrontendErr"
  }
}

Write-Host "Robot agent local UI: http://localhost:3000/"
Write-Host "Head control panel:    http://localhost:3000/head-control"
Write-Host "Head bridge health:   http://127.0.0.1:8787/health"
if (-not $SkipGestureBridge) {
  Write-Host "Gesture bridge health: http://127.0.0.1:$GesturePort/health"
}
