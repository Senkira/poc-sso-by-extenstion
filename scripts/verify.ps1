$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $projectRoot 'extension\manifest.json'
$firebasePath = Join-Path $projectRoot 'firebase.json'
$appPath = Join-Path $projectRoot 'public\app.js'
$htmlPath = Join-Path $projectRoot 'public\index.html'
$archivePath = Join-Path $projectRoot 'public\downloads\gemini-sso-launcher-extension-v0.1.0.zip'

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$firebase = Get-Content -Raw -LiteralPath $firebasePath | ConvertFrom-Json
$app = Get-Content -Raw -LiteralPath $appPath
$html = Get-Content -Raw -LiteralPath $htmlPath

$expectedOrigin = 'https://poc-after-sso-login-gemini.web.app/*'
$expectedExtensionId = 'jeenmgigpkffleijbmfciffiodlcdafh'

if ($manifest.manifest_version -ne 3) { throw 'Manifest V3 is required.' }
if ($manifest.externally_connectable.matches -notcontains $expectedOrigin) { throw 'Hosted origin is not allowlisted.' }
if ($manifest.permissions -contains 'nativeMessaging') { throw 'nativeMessaging is forbidden in extension-only POC.' }
if ($manifest.permissions -contains 'downloads') { throw 'downloads permission is unnecessary.' }
if ($app -notmatch [regex]::Escape($expectedExtensionId)) { throw 'Hosted app extension ID does not match the fixed manifest key.' }
if ($firebase.hosting.site -ne 'poc-after-sso-login-gemini') { throw 'Wrong Firebase Hosting site.' }
if ($html -match '(?i)(https?://)?(localhost|127\.0\.0\.1)(:\d+)?') { throw 'Hosted page references a local runtime endpoint.' }
if (-not (Test-Path -LiteralPath $archivePath)) { throw 'Hosted extension archive is missing.' }
if ($html -notmatch '/downloads/gemini-sso-launcher-extension-v0\.1\.0\.zip') { throw 'Hosted page does not link the extension archive.' }

$publicKey = [Convert]::FromBase64String($manifest.key)
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $hash = $sha256.ComputeHash($publicKey)
} finally {
  $sha256.Dispose()
}
$alphabet = 'abcdefghijklmnop'
$actualExtensionId = -join ($hash[0..15] | ForEach-Object { $alphabet[($_ -shr 4)] + $alphabet[($_ -band 15)] })
if ($actualExtensionId -ne $expectedExtensionId) { throw "Manifest key resolves to unexpected extension ID: $actualExtensionId" }

$forbidden = @('node_modules', 'package.json', 'package-lock.json')
foreach ($name in $forbidden) {
  if (Test-Path -LiteralPath (Join-Path $projectRoot $name)) { throw "Unexpected runtime/build dependency: $name" }
}

Write-Output 'PASS manifest-v3'
Write-Output 'PASS exact-hosted-origin'
Write-Output 'PASS extension-only-no-native-host'
Write-Output 'PASS fixed-extension-id'
Write-Output 'PASS static-firebase-hosting'
Write-Output 'PASS hosted-extension-archive'
Write-Output 'PASS no-node-project-dependency'
