$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $projectRoot 'extension\manifest.json'
$firebasePath = Join-Path $projectRoot 'firebase.json'
$appPath = Join-Path $projectRoot 'public\app.js'
$htmlPath = Join-Path $projectRoot 'public\index.html'
$workerPath = Join-Path $projectRoot 'extension\service-worker.js'
$contentScriptPath = Join-Path $projectRoot 'extension\content-script.js'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$firebase = Get-Content -Raw -LiteralPath $firebasePath | ConvertFrom-Json
$app = Get-Content -Raw -LiteralPath $appPath
$html = Get-Content -Raw -LiteralPath $htmlPath
$worker = Get-Content -Raw -LiteralPath $workerPath
$contentScript = Get-Content -Raw -LiteralPath $contentScriptPath
$archiveName = "gemini-sso-launcher-extension-v$($manifest.version).zip"
$archivePath = Join-Path $projectRoot "public\downloads\$archiveName"

$expectedOrigin = 'https://poc-after-sso-login-gemini.web.app/*'
$expectedExtensionId = 'jeenmgigpkffleijbmfciffiodlcdafh'

if ($manifest.manifest_version -ne 3) { throw 'Manifest V3 is required.' }
if ($manifest.externally_connectable.matches -notcontains $expectedOrigin) { throw 'Hosted origin is not allowlisted.' }
if ($manifest.permissions -contains 'nativeMessaging') { throw 'nativeMessaging is forbidden.' }
if ($manifest.permissions -contains 'cookies') { throw 'cookies permission is forbidden.' }
if ($manifest.permissions -notcontains 'scripting') { throw 'scripting is required for non-secret Google page controls.' }
if ($app -notmatch [regex]::Escape($expectedExtensionId)) { throw 'Hosted app extension ID does not match the fixed manifest key.' }
if ($app -notmatch [regex]::Escape("REQUIRED_EXTENSION_VERSION = `"$($manifest.version)`"")) { throw 'Hosted app does not require the packaged extension version.' }
if ($app -notmatch 'PROTOCOL_VERSION = 4') { throw 'Hosted app must use InPrivate protocol 4.' }
if ($manifest.incognito -ne 'spanning') { throw 'Extension must support the ephemeral InPrivate flow.' }
if ($firebase.hosting.site -ne 'poc-after-sso-login-gemini') { throw 'Wrong Firebase Hosting site.' }
if (-not ($firebase.hosting.headers | Where-Object { $_.source -eq '/' -and $_.headers.key -contains 'Cache-Control' -and $_.headers.value -contains 'no-cache' })) { throw 'Root HTML route must disable cache.' }
if (-not ($firebase.hosting.headers | Where-Object { $_.source -eq '**/*.@(js|css)' -and $_.headers.key -contains 'Cache-Control' -and $_.headers.value -contains 'no-cache' })) { throw 'Launcher assets must disable cache.' }
if ($html -notmatch [regex]::Escape("/app.js?v=$($manifest.version)")) { throw 'Hosted page must cache-bust app.js with the packaged extension version.' }
if ($html -notmatch [regex]::Escape("/styles.css?v=$($manifest.version)")) { throw 'Hosted page must cache-bust styles.css with the packaged extension version.' }
if ($html -match '(?i)(https?://)?(localhost|127\.0\.0\.1)(:\d+)?') { throw 'Hosted page references a local runtime endpoint.' }
if ($worker -match 'PASS_PASSWORD|submitGooglePassword|openCredentialPassThrough|login\.html|credentialChallengeId') { throw 'Credential bridge code is forbidden.' }
if ($worker -match "input\[type=['`"]password|input\[name=['`"]Passwd") { throw 'Extension must not query credential inputs.' }
if ($worker -match 'chrome\.cookies|chrome\.identity') { throw 'Cookie and OAuth token shortcuts are forbidden.' }
$forbiddenPasswordGate = "[data-profile-identifier],[data-email],[data-identifier],[role='link']"
if ($worker.Contains($forbiddenPasswordGate)) { throw 'Generic role-link text must not authorize a password submission.' }
if ($contentScript -match [regex]::Escape('[aria-label],[title],[data-email],[data-identifier]')) { throw 'Gemini identity detection must not scan every labelled element.' }
if ($contentScript -match 'candidate\.toLowerCase\(\)\.includes\(normalized\)') { throw 'Substring email matches must not confirm the Gemini account.' }

$retiredCredentialFiles = @('login.html', 'login.js', 'login.css')
foreach ($name in $retiredCredentialFiles) {
  if (Test-Path -LiteralPath (Join-Path $projectRoot "extension\$name")) { throw "Retired credential file still exists: $name" }
}

if (-not (Test-Path -LiteralPath $archivePath)) { throw 'Hosted extension archive is missing.' }
if ($html -notmatch [regex]::Escape("/downloads/$archiveName")) { throw 'Hosted page does not link the extension archive.' }
$hostedArchives = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'public\downloads') -Filter '*.zip' -File)
if ($hostedArchives.Count -ne 1 -or $hostedArchives[0].Name -ne $archiveName) { throw 'Only the current secretless extension archive may be hosted.' }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  $expectedEntries = @('content-script.js', 'manifest.json', 'service-worker.js')
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
Write-Output 'PASS ephemeral-inprivate-mode'
Write-Output 'PASS extension-only-no-native-host'
Write-Output 'PASS fixed-extension-id'
Write-Output 'PASS static-firebase-hosting'
Write-Output 'PASS hosted-extension-archive'
Write-Output 'PASS no-retired-extension-archives'
Write-Output 'PASS no-node-project-dependency'
Write-Output 'PASS no-credential-page-or-message-path'
Write-Output 'PASS no-password-input-query'
Write-Output 'PASS no-cookie-or-oauth-shortcut'
Write-Output 'PASS strict-account-control-provenance'
