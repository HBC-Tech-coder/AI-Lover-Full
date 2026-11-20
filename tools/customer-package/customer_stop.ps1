$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Ports = @(3000, 8787, 8791, 8810, 8790)
foreach ($Port in $Ports) {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -and
    $_.ProcessId -ne $PID -and
    (
      $_.CommandLine.Contains($Root) -or
      $_.CommandLine.Contains("customer_start.ps1") -or
      $_.CommandLine.Contains("start_local_robot_agent.ps1") -or
      $_.CommandLine.Contains("frontend\server.js") -or
      $_.CommandLine.Contains("frontend/server.js") -or
      $_.CommandLine.Contains("head_motion_bridge.py") -or
      $_.CommandLine.Contains("gesture_arm_bridge.py")
    )
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Start-Sleep -Seconds 1
Write-Host "AI-Lover stopped."
Start-Sleep -Seconds 2
