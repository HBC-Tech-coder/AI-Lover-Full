$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$SecretsLoader = Join-Path $Root "scripts\Import-SecretsEnv.ps1"
if (Test-Path -LiteralPath $SecretsLoader) {
  . $SecretsLoader -Path (Join-Path $Root "secrets.env")
}

$WorkerPath = Join-Path $Root "workers\live2d_worker"
$BundledPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
$Editor = "C:\Program Files\Live2D Cubism 5.3\CubismEditor5.exe"

if (-not (Test-Path -LiteralPath $BundledPython)) {
  throw "Bundled Python not found: $BundledPython"
}
if (-not (Test-Path -LiteralPath $Editor)) {
  throw "Live2D Cubism Editor not found: $Editor"
}

$WorkspaceRoot = Split-Path -Parent $Root
$TenFrontendPublic = Join-Path $WorkspaceRoot "opt\xiaoling\ten-framework-main\ai_agents\agents\examples\websocket-example\frontend\public\generated-live2d"
$RepoFrontendPublic = Join-Path $Root "frontend\public\generated-live2d"

# The browser currently serves generated files from the TEN frontend copy.
# Fall back to the repo frontend public folder when this script is used in a
# standalone checkout.
if (Test-Path (Split-Path -Parent $TenFrontendPublic)) {
  $env:LIVE2D_WORKER_PUBLIC_ROOT = $TenFrontendPublic
} else {
  $env:LIVE2D_WORKER_PUBLIC_ROOT = $RepoFrontendPublic
}

$env:PYTHONPATH = $WorkerPath
$env:LIVE2D_WORKER_PUBLIC_BASE = "/generated-live2d"
$env:LIVE2D_WORKER_HOST = "127.0.0.1"
$env:LIVE2D_WORKER_PORT = "8790"
$env:LIVE2D_WORKER_RETURN_TEMPLATE = "0"
$env:LIVE2D_CUBISM_BRIDGE_TIMEOUT_SEC = "900"

# Open mode is intentionally conservative: it proves the worker can create a
# Cubism-ready PSD and hand it to Cubism Editor, but it does not claim to export
# a real .moc3 until GUI automation or a rigging provider is connected.
$env:LIVE2D_CUBISM_BRIDGE_COMMAND = "`"$BundledPython`" -m live2d_worker.cubism_bridge_cli --mode open --editor-path `"$Editor`""

Write-Host "Starting local Live2D worker with Cubism open bridge..."
Write-Host "Python: $BundledPython"
Write-Host "Cubism: $Editor"
Write-Host "Endpoint: http://$($env:LIVE2D_WORKER_HOST):$($env:LIVE2D_WORKER_PORT)/live2d/generate"
Write-Host "Public root: $($env:LIVE2D_WORKER_PUBLIC_ROOT)"
Write-Host "Bridge: $($env:LIVE2D_CUBISM_BRIDGE_COMMAND)"

& $BundledPython -u -m live2d_worker.server
