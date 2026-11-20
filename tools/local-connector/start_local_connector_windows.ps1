param(
  [string]$Code = $env:AI_LOVER_PAIRING_CODE,
  [string]$Bridge = $(if ($env:AI_LOVER_DEVICE_BRIDGE_URL) { $env:AI_LOVER_DEVICE_BRIDGE_URL } else { "wss://ai.vituralmodel.com/device-bridge" }),
  [string]$Name = $(if ($env:AI_LOVER_DEVICE_NAME) { $env:AI_LOVER_DEVICE_NAME } else { "$env:COMPUTERNAME Local Connector" })
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $root

if ([string]::IsNullOrWhiteSpace($Code)) {
  $Code = Read-Host "Enter the pairing code from the web page"
}

$bundledNode = Join-Path $root "runtime\nodejs\node.exe"
$nodeExe = if (Test-Path $bundledNode) { $bundledNode } else { "node" }

Write-Host "AI-Lover Local Connector"
Write-Host "Pairing code: $Code"
Write-Host "Cloud bridge: $Bridge"
Write-Host "Node: $nodeExe"
Write-Host ""

& $nodeExe ".\tools\local-connector\ai-lover-local-connector.js" --bridge $Bridge --code $Code --name $Name
