param(
  [string]$OutputDir = "",
  [string]$PackageName = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Version = (Get-Content -LiteralPath (Join-Path $Root "VERSION") -Raw).Trim()
if (-not $OutputDir) { $OutputDir = Join-Path $Root "dist-customer" }
if (-not $PackageName) { $PackageName = "AI-Lover-$Version-hot-update" }

$PackageRoot = Join-Path $OutputDir $PackageName
$AppRoot = Join-Path $PackageRoot "app"

function Copy-FileIfExists {
  param([string]$Source, [string]$Destination)
  if (Test-Path -LiteralPath $Source) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
  }
}

function Copy-DirIfExists {
  param([string]$Source, [string]$Destination)
  if (Test-Path -LiteralPath $Source) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    robocopy $Source $Destination /MIR /R:2 /W:1 /NFL /NDL /NP | Out-Host
    if ($LASTEXITCODE -gt 7) {
      throw "robocopy failed from $Source to $Destination with exit code $LASTEXITCODE"
    }
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

Write-Host "Building frontend before hot update..."
Push-Location (Join-Path $Root "frontend")
try {
  npm run build | Out-Host
} finally {
  Pop-Location
}

Write-Host "Copying hot update files..."
Copy-FileIfExists (Join-Path $Root "VERSION") (Join-Path $AppRoot "VERSION")
Copy-FileIfExists (Join-Path $Root "CHANGELOG.md") (Join-Path $AppRoot "CHANGELOG.md")
Copy-FileIfExists (Join-Path $Root "start_local_robot_agent.ps1") (Join-Path $AppRoot "start_local_robot_agent.ps1")
Copy-FileIfExists (Join-Path $Root "tools\customer-package\customer_start.ps1") (Join-Path $AppRoot "customer_start.ps1")
Copy-FileIfExists (Join-Path $Root "tools\customer-package\customer_stop.ps1") (Join-Path $AppRoot "customer_stop.ps1")
Copy-FileIfExists (Join-Path $Root "tools\customer-package\customer_config.ps1") (Join-Path $AppRoot "customer_config.ps1")

Copy-FileIfExists (Join-Path $Root "hardware\head_motion_bridge.py") (Join-Path $AppRoot "hardware\head_motion_bridge.py")
Copy-FileIfExists (Join-Path $Root "hardware\head_motion_protocol.py") (Join-Path $AppRoot "hardware\head_motion_protocol.py")
Copy-FileIfExists (Join-Path $Root "hardware\gesture_arm_bridge.py") (Join-Path $AppRoot "hardware\gesture_arm_bridge.py")

Copy-FileIfExists (Join-Path $Root "frontend\server.js") (Join-Path $AppRoot "frontend\server.js")
Copy-FileIfExists (Join-Path $Root "frontend\package.json") (Join-Path $AppRoot "frontend\package.json")
Copy-DirIfExists (Join-Path $Root "frontend\.next") (Join-Path $AppRoot "frontend\.next")
Copy-DirIfExists (Join-Path $Root "frontend\public") (Join-Path $AppRoot "frontend\public")

Copy-DirIfExists (Join-Path $Root "docs") (Join-Path $AppRoot "docs")

@"
AI-Lover hot update $Version

Use:
1. Close AI-Lover.
2. Copy the app folder in this package over the existing AI-Lover app folder.
3. Start AI-Lover again.

This package does not include Python/Node runtimes. Use the full customer package
when installing on a new computer.
"@ | Set-Content -LiteralPath (Join-Path $PackageRoot "README_HOT_UPDATE.txt") -Encoding UTF8

$ZipPath = Join-Path $OutputDir "$PackageName.zip"
if (Test-Path -LiteralPath $ZipPath) {
  Remove-Item -LiteralPath $ZipPath -Force
}
Compress-Archive -Path (Join-Path $PackageRoot "*") -DestinationPath $ZipPath -Force

Write-Host "Hot update package ready:" -ForegroundColor Green
Write-Host $PackageRoot
Write-Host $ZipPath
