$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $projectRoot 'extension\manifest.json'
$firebasePath = Join-Path $projectRoot 'firebase.json'
$appPath = Join-Path $projectRoot 'public\app.js'
$htmlPath = Join-Path $projectRoot 'public\index.html'
$workerPath = Join-Path $projectRoot 'extension\service-worker.js'
$loginPath = Join-Path $projectRoot 'extension\login.js'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$firebase = Get-Content -Raw -LiteralPath $firebasePath | ConvertFrom-Json
$app = Get-Content -Raw -LiteralPath $appPath
$html = Get-Content -Raw -LiteralPath $htmlPath
$worker = Get-Content -Raw -LiteralPath $workerPath
$login = Get-Content -Raw -LiteralPath $loginPath
$archiveName = "gemini-sso-launcher-extension-v$($manifest.version).zip"
$archivePath = Join-Path $projectRoot "public\downloads\$archiveName"

$expectedOrigin = 'https://poc-after-sso-login-gemini.web.app/*'
$expectedExtensionId = 'jeenmgigpkffleijbmfciffiodlcdafh'

if ($manifest.manifest_version -ne 3) { throw 'Manifest V3 is required.' }
if ($manifest.externally_connectable.matches -notcontains $expectedOrigin) { throw 'Hosted origin is not allowlisted.' }
if ($manifest.permissions -contains 'nativeMessaging') { throw 'nativeMessaging is forbidden in extension-only POC.' }
if ($manifest.permissions -contains 'downloads') { throw 'downloads permission is unnecessary.' }
if ($manifest.permissions -notcontains 'scripting') { throw 'scripting permission is required for the explicit Google page automation.' }
if ($app -notmatch [regex]::Escape($expectedExtensionId)) { throw 'Hosted app extension ID does not match the fixed manifest key.' }
if ($app -notmatch [regex]::Escape("REQUIRED_EXTENSION_VERSION = `"$($manifest.version)`"")) { throw 'Hosted app does not require the packaged extension version.' }
if ($firebase.hosting.site -ne 'poc-after-sso-login-gemini') { throw 'Wrong Firebase Hosting site.' }
if (-not ($firebase.hosting.headers | Where-Object { $_.source -eq '/' -and $_.headers.key -contains 'Cache-Control' -and $_.headers.value -contains 'no-cache' })) { throw 'Root HTML route must disable cache.' }
if (-not ($firebase.hosting.headers | Where-Object { $_.source -eq '**/*.@(js|css)' -and $_.headers.key -contains 'Cache-Control' -and $_.headers.value -contains 'no-cache' })) { throw 'Launcher assets must disable cache.' }
if ($html -notmatch [regex]::Escape("/app.js?v=$($manifest.version)")) { throw 'Hosted page must cache-bust app.js with the packaged extension version.' }
if ($html -match '(?i)(https?://)?(localhost|127\.0\.0\.1)(:\d+)?') { throw 'Hosted page references a local runtime endpoint.' }
if ($worker -match '(?s)storage\.session\.set\s*\([^\)]*password') { throw 'Password must never be written to extension storage.' }
if ($login -match 'chrome\.storage') { throw 'Credential page must not access extension storage.' }
if (-not (Test-Path -LiteralPath $archivePath)) { throw 'Hosted extension archive is missing.' }
if ($html -notmatch [regex]::Escape("/downloads/$archiveName")) { throw 'Hosted page does not link the extension archive.' }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  $expectedEntries = @('content-script.js', 'login.css', 'login.html', 'login.js', 'manifest.json', 'service-worker.js')
  $actualEntries = @($archive.Entries | ForEach-Object FullName | Sort-Object)
  if (($actualEntries -join '|') -ne (($expectedEntries | Sort-Object) -join '|')) { throw 'Hosted extension archive has unexpected entries.' }
  foreach ($entryName in $expectedEntries) {
    $entry = $archive.GetEntry($entryName)
    $memory = New-Object System.IO.MemoryStream
    $entryStream = $entry.Open()
    try { $entryStream.CopyTo($memory) } finally { $entryStream.Dispose() }
    $archiveBytes = $memory.ToArray()
    $memory.Dispose()
    $sourceBytes = [System.IO.File]::ReadAllBytes((Join-Path $projectRoot "extension\$entryName"))
    if ($archiveBytes.Length -ne $sourceBytes.Length) { throw "Hosted archive entry is stale: $entryName" }
    for ($index = 0; $index -lt $sourceBytes.Length; $index += 1) {
      if ($archiveBytes[$index] -ne $sourceBytes[$index]) { throw "Hosted archive entry is stale: $entryName" }
    }
  }
} finally {
  $archive.Dispose()
}

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
Write-Output 'PASS credential-pass-through-no-extension-storage'
