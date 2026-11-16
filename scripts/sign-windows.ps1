# LOT 10 — Signature des installateurs Windows (à exécuter SUR WINDOWS, en CI de release).
# Aucun secret n'est stocké dans le dépôt : le certificat est fourni par la CI.
#
# Prérequis :
#   - Windows SDK (signtool.exe dans le PATH)
#   - $env:DEPOTPRO_WIN_PFX        : chemin du certificat code signing (.pfx)
#   - $env:DEPOTPRO_WIN_PFX_PASSWORD : mot de passe du certificat
#   - $env:DEPOTPRO_TIMESTAMP_URL  : serveur TSA (horodatage SHA-256), facultatif
#
# Usage : powershell -ExecutionPolicy Bypass -File scripts/sign-windows.ps1

$ErrorActionPreference = 'Stop'

function Assert-Env($name) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Variable d'environnement manquante : $name"
  }
  return $value
}

$pfx = Assert-Env 'DEPOTPRO_WIN_PFX'
$password = Assert-Env 'DEPOTPRO_WIN_PFX_PASSWORD'
if (-not (Test-Path $pfx)) { throw "Certificat introuvable : $pfx" }

$timestamp = [Environment]::GetEnvironmentVariable('DEPOTPRO_TIMESTAMP_URL')
if ([string]::IsNullOrWhiteSpace($timestamp)) {
  $timestamp = 'http://timestamp.digicert.com'
}

$bundleRoot = Join-Path $PSScriptRoot '..\src-tauri\target\release\bundle'
if (-not (Test-Path $bundleRoot)) {
  throw "Aucun bundle Tauri trouvé dans $bundleRoot. Exécutez d'abord : npm run tauri:build"
}

$artifacts = Get-ChildItem -Path $bundleRoot -Recurse -File |
  Where-Object { $_.Extension -in @('.msi', '.exe') }

if ($artifacts.Count -eq 0) {
  throw 'Aucun installateur MSI/EXE à signer.'
}

foreach ($artifact in $artifacts) {
  Write-Host "Signature de $($artifact.FullName) ..."
  & signtool sign /f $pfx /p $password /fd SHA256 /td SHA256 /tr $timestamp $artifact.FullName
  if ($LASTEXITCODE -ne 0) { throw "Échec de signature : $($artifact.Name)" }
  & signtool verify /pa /fd SHA256 $artifact.FullName
  if ($LASTEXITCODE -ne 0) { throw "Vérification de signature impossible : $($artifact.Name)" }
}

Write-Host "OK — $($artifacts.Count) installateur(s) signé(s) et vérifié(s)."
Write-Host 'Rappel : ne jamais committer le .pfx ni son mot de passe.'
