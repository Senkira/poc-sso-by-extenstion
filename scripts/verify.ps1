$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'extension\manifest.json') | ConvertFrom-Json
$worker = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'extension\service-worker.js')
$content = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'extension\content-script.js')
$app = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'frontend-web\app.js')
$html = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'frontend-web\index.html')
$broker = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'backend-api\index.js')
$brokerCore = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'backend-api\broker-core.js')
$firebase = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'firebase.json') | ConvertFrom-Json
$functionsPackage = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'backend-api\package.json') | ConvertFrom-Json
$expectedExtensionId = 'jeenmgigpkffleijbmfciffiodlcdafh'
$brokerHostPermission = 'https://us-central1-poc-after-sso-login-gemini.cloudfunctions.net/*'
$archiveName = "gemini-extension-agent-poc-v$($manifest.version).zip"
$archivePath = Join-Path $projectRoot "frontend-web\downloads\$archiveName"

if ($manifest.manifest_version -ne 3) { throw 'Manifest V3 is required.' }
if ($manifest.version -ne '0.13.3') { throw 'Unexpected extension version.' }
if ($manifest.incognito -ne 'spanning') { throw 'Spanning InPrivate execution is required.' }
if ($manifest.permissions -contains 'nativeMessaging') { throw 'Endpoint Native Messaging is forbidden.' }
if ($manifest.permissions -notcontains 'storage' -or $manifest.permissions -notcontains 'alarms') { throw 'Session state and authentication alarms are required.' }
if ($manifest.permissions -contains 'cookies' -or $manifest.permissions -contains 'debugger') { throw 'Cookie/debugger permissions are forbidden.' }
if ($manifest.host_permissions -notcontains $brokerHostPermission) { throw 'HTTPS broker host permission is missing.' }
if ($manifest.host_permissions -notcontains 'https://identitytoolkit.googleapis.com/*') { throw 'Firebase Auth verification host is missing.' }
if ($manifest.externally_connectable.matches -notcontains 'https://poc-after-sso-login-gemini.web.app/*') { throw 'Production Firebase origin is not allowlisted.' }
if ($worker -notmatch 'PROTOCOL_VERSION = 10' -or $content -notmatch 'version: 10' -or $app -notmatch 'PROTOCOL_VERSION = 10') { throw 'Protocol version mismatch.' }
if ($app -notmatch [regex]::Escape($expectedExtensionId)) { throw 'Hosted app extension ID mismatch.' }
if ($worker -match 'sendNativeMessage|NATIVE_HOST') { throw 'Retired native bridge remains in endpoint runtime.' }
if ($worker -notmatch 'fetch\(CREDENTIAL_BROKER_URL' -or $worker -notmatch 'getGoogleCredential') { throw 'Worker does not use the one-shot HTTPS broker.' }
if ($worker -notmatch 'incognito: true' -or $worker -notmatch 'state: "minimized"') { throw 'Worker must hide the isolated login window.' }
if ($worker -notmatch 'GEMINI_TARGET_ACCOUNT_CONFIRMED') { throw 'Exact account confirmation gate is missing.' }
if ($app -match 'POST_PROMPT' -or $html -match 'prompt-button|Gemini Prompt') { throw 'Hosted prompt controls must be absent.' }
if ($app -match 'accounts:signInWithPassword' -or $html -match 'type=["'']password["'']') { throw 'Hosted POC must not handle passwords.' }
if ($app -notmatch 'AUTHENTICATE_POC' -or $app -notmatch 'pocIdToken') { throw 'Hosted POC authentication gate is missing.' }
if ($html -notmatch 'value="O1234567"[^>]*readonly' -or $app -notmatch 'await launchGemini\(\)') { throw 'Single-click POC-to-Gemini flow is missing.' }
if ($worker -notmatch 'accounts:lookup' -or $worker -notmatch 'POC_AUTH_REQUIRED') { throw 'Extension does not verify Firebase authentication.' }
if ($worker -notmatch 'isAllowedIncognitoAccess' -or $app -notmatch 'incognitoAccessAllowed') { throw 'InPrivate permission gate is missing.' }
if ($worker -match 'chrome\.storage\.(local|sync)' -or $worker -notmatch 'chrome\.storage\.session') { throw 'Only session storage is allowed.' }
if (($worker + $app + $html + $broker + $brokerCore) -match '(?i)@[s]{2}w0rd') { throw 'A password-like literal is present in source.' }
if ($broker -notmatch 'defineSecret\("GEMINI_TARGET_PASSWORD"\)' -or $broker -notmatch 'defineSecret\("POC_FIREBASE_PASSWORD"\)' -or $broker -notmatch 'verifyIdToken' -or $broker -notmatch 'accounts:signInWithPassword') { throw 'Backend secrets or Firebase authorization gate is missing.' }
if ($broker -notmatch 'minInstances: 0' -or $brokerCore -notmatch [regex]::Escape("chrome-extension://$expectedExtensionId")) { throw 'Broker scaling or exact extension-origin gate is missing.' }
if ($firebase.functions.source -ne 'backend-api' -or $firebase.functions.runtime -ne 'nodejs22') { throw 'Firebase Functions runtime is not configured.' }
if ($functionsPackage.engines.node -ne '22') { throw 'Backend Node runtime mismatch.' }
if ($firebase.hosting.site -ne 'poc-after-sso-login-gemini') { throw 'Wrong Firebase Hosting site.' }
if ($firebase.auth.providers.emailPassword -ne $true) { throw 'Firebase Email/Password provider configuration is missing.' }
if ($html -notmatch '/app.js\?v=0\.13\.3' -or $html -notmatch '/styles.css\?v=0\.13\.3') { throw 'Hosted assets are not cache-busted.' }
if ($worker -notmatch 'documentIds' -or $worker -notmatch 'webNavigation\.getFrame') { throw 'Exact-document reconciliation is missing.' }
if ($worker -notmatch 'windows\.getAll' -or $worker -notmatch 'INCOGNITO_SESSION_NOT_FRESH') { throw 'Fresh InPrivate session gate is missing.' }
if ($worker -notmatch 'credentialState' -or $worker -notmatch 'CREDENTIAL_ALREADY_CLAIMED') { throw 'Atomic one-shot credential state is missing.' }
if ($worker -notmatch 'credentialSubmitted' -or $worker -notmatch 'INJECTING_PASSWORD' -or $app -notmatch 'Submitted once') { throw 'Password receive/submit status separation is missing.' }
if ($worker -notmatch 'OPENING_ISOLATED_GEMINI_TAB' -or $worker -notmatch 'tabs\.reload' -or $worker -notmatch 'tabs\.remove') { throw 'Isolated Gemini handoff is missing.' }
if ($worker -notmatch 'startAgentTail' -or $worker -notmatch 'startAgentUnlocked') { throw 'Concurrent agent starts are not serialized.' }
if (Test-Path -LiteralPath (Join-Path $projectRoot 'bootstrap')) { throw 'Endpoint bootstrap directory must not ship.' }
if (Test-Path -LiteralPath (Join-Path $projectRoot 'package.json')) { throw 'Endpoint/root Node runtime dependency is forbidden.' }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'backend-api\package-lock.json'))) { throw 'Backend dependency lock is missing.' }
if (-not (Test-Path -LiteralPath $archivePath)) { throw 'Packaged extension archive is missing.' }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  $expectedEntries = @('extension/content-script.js', 'extension/manifest.json', 'extension/service-worker.js')
  $actualEntries = @($archive.Entries | Where-Object { -not [string]::IsNullOrEmpty($_.Name) } | ForEach-Object { $_.FullName.Replace('\', '/') } | Sort-Object)
  if (($actualEntries -join '|') -ne (($expectedEntries | Sort-Object) -join '|')) { throw 'Extension archive contains unexpected files.' }
  foreach ($entryName in $expectedEntries) {
    $entry = $archive.Entries | Where-Object { $_.FullName.Replace('\', '/') -eq $entryName } | Select-Object -First 1
    if ($null -eq $entry) { throw "Archive entry is missing: $entryName" }
    $memory = New-Object IO.MemoryStream
    $entryStream = $entry.Open()
    try { $entryStream.CopyTo($memory) } finally { $entryStream.Dispose() }
    $archiveBytes = $memory.ToArray()
    $memory.Dispose()
    $sourceBytes = [IO.File]::ReadAllBytes((Join-Path $projectRoot ($entryName -replace '/', '\')))
    if ($archiveBytes.Length -ne $sourceBytes.Length) { throw "Archive entry is stale: $entryName" }
    for ($index = 0; $index -lt $sourceBytes.Length; $index += 1) {
      if ($archiveBytes[$index] -ne $sourceBytes[$index]) { throw "Archive entry is stale: $entryName" }
    }
  }
} finally { $archive.Dispose() }

$publicKey = [Convert]::FromBase64String($manifest.key)
$sha256 = [Security.Cryptography.SHA256]::Create()
try { $hash = $sha256.ComputeHash($publicKey) } finally { $sha256.Dispose() }
$alphabet = 'abcdefghijklmnop'
$actualExtensionId = -join ($hash[0..15] | ForEach-Object { $alphabet[($_ -shr 4)] + $alphabet[($_ -band 15)] })
if ($actualExtensionId -ne $expectedExtensionId) { throw "Manifest key resolves to $actualExtensionId" }

Write-Output 'PASS extension-only-endpoint-package'
Write-Output 'PASS manifest-v3-fixed-id-and-https-broker'
Write-Output 'PASS one-shot-credential-and-no-password-persistence'
Write-Output 'PASS hidden-inprivate-login-window'
Write-Output 'PASS exact-account-and-document-gates'
Write-Output 'PASS firebase-id-token-authorization'
Write-Output 'PASS backend-secret-and-origin-gates'
Write-Output 'PASS serverless-scale-to-zero'
Write-Output 'PASS backend-node22-is-cloud-only'
Write-Output 'PASS packaged-extension-current'
