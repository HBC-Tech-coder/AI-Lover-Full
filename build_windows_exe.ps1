param(
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Source = Join-Path $Root "tools\windows-launcher\AI-LoverLauncher.cs"
$Dist = Join-Path $Root "dist-windows"
New-Item -ItemType Directory -Path $Dist -Force | Out-Null

if (-not $OutputPath) {
  $OutputPath = Join-Path $Dist "AI-Lover.exe"
}

$CscCandidates = @(
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)

$Csc = $null
foreach ($Candidate in $CscCandidates) {
  if (Test-Path -LiteralPath $Candidate) {
    $Csc = $Candidate
    break
  }
}

if (-not $Csc) {
  throw "csc.exe not found. Install .NET Framework Developer Pack or Visual Studio Build Tools."
}

& $Csc `
  /nologo `
  /target:winexe `
  /platform:anycpu `
  /out:$OutputPath `
  /reference:System.dll `
  /reference:System.Windows.Forms.dll `
  $Source

Write-Host "Built Windows launcher: $OutputPath"
Write-Host "Run it from this project folder so it can find start_local_robot_agent.ps1."
