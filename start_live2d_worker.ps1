$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$SecretsLoader = Join-Path $Root "scripts\Import-SecretsEnv.ps1"
if (Test-Path -LiteralPath $SecretsLoader) {
  . $SecretsLoader -Path (Join-Path $Root "secrets.env")
}

$WorkerPath = Join-Path $Root "workers\live2d_worker"
$BundledPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
$VenvPython = Join-Path $Root ".venv-live2d-worker\Scripts\python.exe"

if (-not $env:LIVE2D_WORKER_PUBLIC_ROOT) {
  $WorkspaceRoot = Split-Path -Parent $Root
  $TenFrontendPublic = Join-Path $WorkspaceRoot "opt\xiaoling\ten-framework-main\ai_agents\agents\examples\websocket-example\frontend\public\generated-live2d"
  $RepoFrontendPublic = Join-Path $Root "frontend\public\generated-live2d"
  if (Test-Path (Split-Path -Parent $TenFrontendPublic)) {
    $env:LIVE2D_WORKER_PUBLIC_ROOT = $TenFrontendPublic
  } else {
    $env:LIVE2D_WORKER_PUBLIC_ROOT = $RepoFrontendPublic
  }
}

if (-not $env:LIVE2D_WORKER_PUBLIC_BASE) {
  $env:LIVE2D_WORKER_PUBLIC_BASE = "/generated-live2d"
}
if (-not $env:LIVE2D_WORKER_HOST) {
  $env:LIVE2D_WORKER_HOST = "127.0.0.1"
}
if (-not $env:LIVE2D_WORKER_PORT) {
  $env:LIVE2D_WORKER_PORT = "8790"
}

if (Test-Path $BundledPython) {
  $Python = $BundledPython
} else {
  if (-not (Test-Path $VenvPython)) {
    py -3.9 -m venv (Join-Path $Root ".venv-live2d-worker")
    & $VenvPython -m pip install --upgrade pip
    & $VenvPython -m pip install -r (Join-Path $WorkerPath "requirements.txt")
  }
  $Python = $VenvPython
}

$env:PYTHONPATH = $WorkerPath

Write-Host "Starting local Live2D worker..."
Write-Host "Python: $Python"
Write-Host "Endpoint: http://$($env:LIVE2D_WORKER_HOST):$($env:LIVE2D_WORKER_PORT)/live2d/generate"
Write-Host "Public root: $($env:LIVE2D_WORKER_PUBLIC_ROOT)"
Write-Host "Return template: $($env:LIVE2D_WORKER_RETURN_TEMPLATE)"

& $Python -m live2d_worker.server
