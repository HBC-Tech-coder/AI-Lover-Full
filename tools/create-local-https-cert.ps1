param(
  [string]$OutputDir = "",
  [string]$Passphrase = "ai-lover-local",
  [switch]$TrustOnThisPc
)

$ErrorActionPreference = "Stop"
if (-not $Passphrase) {
  $Passphrase = "ai-lover-local"
}

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $OutputDir) {
  $OutputDir = Join-Path $Root "certs"
}
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

$addresses = @("127.0.0.1")
try {
  $addresses += Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object {
      $_.IPAddress -and
      $_.IPAddress -notlike "169.254.*" -and
      $_.IPAddress -ne "127.0.0.1"
    } |
    Select-Object -ExpandProperty IPAddress
} catch {
  Write-Warning "Could not enumerate LAN IP addresses: $($_.Exception.Message)"
}
$addresses = $addresses | Sort-Object -Unique

$dnsNames = @("localhost")
if ($env:COMPUTERNAME) {
  $dnsNames += $env:COMPUTERNAME
}

$san = @()
foreach ($name in ($dnsNames | Sort-Object -Unique)) {
  $san += "dns=$name"
}
foreach ($address in $addresses) {
  $san += "ipaddress=$address"
}

$cert = New-SelfSignedCertificate `
  -Subject "CN=AI-Lover Local HTTPS" `
  -FriendlyName "AI-Lover Local HTTPS" `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -KeyExportPolicy Exportable `
  -HashAlgorithm SHA256 `
  -NotAfter (Get-Date).AddYears(3) `
  -TextExtension @("2.5.29.17={text}$($san -join '&')")

$password = ConvertTo-SecureString -String $Passphrase -Force -AsPlainText
$pfxPath = Join-Path $OutputDir "ai-lover-local.pfx"
$cerPath = Join-Path $OutputDir "ai-lover-local.cer"

Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $password | Out-Null
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null

if ($TrustOnThisPc) {
  Import-Certificate -FilePath $cerPath -CertStoreLocation "Cert:\CurrentUser\Root" | Out-Null
}

Write-Host "Created: $pfxPath"
Write-Host "Created: $cerPath"
Write-Host "Restart AI-Lover, then open https://<this computer LAN IP>:3443/ on Mac/iPhone."
Write-Host "For other devices, install/trust the .cer file or use a real HTTPS domain certificate."
