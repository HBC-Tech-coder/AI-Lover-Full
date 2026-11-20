param(
  [string]$ImagePath = "$PSScriptRoot\local_runtime\gpu_avatar\avatar.jpg",
  [string]$AvatarId = "default",
  [string]$AvatarName = "本地图片数字人",
  [int]$Port = 8810
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $ImagePath)) {
  throw "Avatar image not found: $ImagePath"
}

$WorkerScript = Join-Path $PSScriptRoot "workers\gpu_avatar_worker\local_image_worker.js"
if (-not (Test-Path -LiteralPath $WorkerScript)) {
  throw "Worker script not found: $WorkerScript"
}

$env:GPU_AVATAR_IMAGE_PATH = (Resolve-Path -LiteralPath $ImagePath).Path
$env:GPU_AVATAR_ID = $AvatarId
$env:GPU_AVATAR_NAME = $AvatarName
$env:GPU_AVATAR_WORKER_PORT = [string]$Port

Write-Host "Starting GPU avatar image worker..."
Write-Host "Endpoint: http://127.0.0.1:$Port"
Write-Host "Avatar: $AvatarName"
Write-Host "Image: $env:GPU_AVATAR_IMAGE_PATH"

node $WorkerScript
