param(
  [string]$Path
)

if (-not $Path) {
  $Path = Join-Path (Split-Path -Parent $PSScriptRoot) "secrets.env"
}

if (-not (Test-Path -LiteralPath $Path)) {
  return
}

$Loaded = 0
foreach ($RawLine in Get-Content -LiteralPath $Path) {
  $Line = $RawLine.Trim()
  if (-not $Line -or $Line.StartsWith("#")) {
    continue
  }
  if ($Line.StartsWith("export ")) {
    $Line = $Line.Substring(7).Trim()
  }

  $Index = $Line.IndexOf("=")
  if ($Index -le 0) {
    continue
  }

  $Key = $Line.Substring(0, $Index).Trim()
  $Value = $Line.Substring($Index + 1).Trim()
  if (-not $Key) {
    continue
  }

  if (
    ($Value.StartsWith('"') -and $Value.EndsWith('"')) -or
    ($Value.StartsWith("'") -and $Value.EndsWith("'"))
  ) {
    $Value = $Value.Substring(1, $Value.Length - 2)
  }

  [Environment]::SetEnvironmentVariable($Key, $Value, "Process")
  $Loaded += 1
}

Write-Host "Loaded $Loaded local secret environment variables from $Path"
