$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $projectRoot 'extension\manifest.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$worker = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'extension\service-worker.js')
$content = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'extension\content-script.js')
$app = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'public\app.js')
$html = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'public\index.html')
$nativeHost = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'bootstrap\NativeHost.cs')
$firebase = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'firebase.json') | ConvertFrom-Json
$expectedExtensionId = 'jeenmgigpkffleijbmfciffiodlcdafh'
$archiveName = "gemini-extension-agent-poc-v$($manifest.version).zip"
$archivePath = Join-Path $projectRoot "public\downloads\$archiveName"

if ($manifest.manifest_version -ne 3) { throw 'Manifest V3 is required.' }
if ($manifest.version -ne '0.9.2') { throw 'Unexpected extension version.' }
if ($manifest.incognito -ne 'spanning') { throw 'Spanning InPrivate execution is required.' }
if ($manifest.permissions -notcontains 'nativeMessaging') { throw 'Native Messaging is required for the one-shot credential bridge.' }
if ($manifest.permissions -notcontains 'storage') { throw 'Session-only state persistence is required for MV3 worker restarts.' }
if ($manifest.permissions -notcontains 'alarms') { throw 'A service-worker-safe authentication timeout is required.' }
if ($manifest.permissions -contains 'cookies' -or $manifest.permissions -contains 'debugger') { throw 'Cookie/debugger permissions are forbidden.' }
if ($manifest.host_permissions -contains 'http://127.0.0.1/*') { throw 'The retired loopback protocol bridge must not be present.' }
if ($manifest.host_permissions -notcontains 'https://identitytoolkit.googleapis.com/*') { throw 'Firebase Auth verification host is missing.' }
if ($manifest.externally_connectable.matches -notcontains 'https://poc-after-sso-login-gemini.web.app/*') { throw 'Production Firebase origin is not allowlisted.' }
if ($worker -notmatch 'PROTOCOL_VERSION = 9') { throw 'Worker protocol is stale.' }
if ($content -notmatch 'version: 9') { throw 'Content script protocol is stale.' }
if ($app -notmatch 'PROTOCOL_VERSION = 9') { throw 'Hosted app protocol is stale.' }
if ($app -notmatch [regex]::Escape($expectedExtensionId)) { throw 'Hosted app extension ID mismatch.' }
if ($worker -notmatch 'sendNativeMessage\(NATIVE_HOST') { throw 'Worker does not use the native bridge.' }
if ($worker -notmatch 'incognito: true' -or $worker -notmatch 'state: "minimized"') { throw 'Worker must hide the isolated login window.' }
if ($worker -notmatch 'GEMINI_TARGET_ACCOUNT_CONFIRMED') { throw 'Exact account confirmation gate is missing.' }
if ($worker -notmatch 'POST_PROMPT' -or $app -notmatch 'POST_PROMPT') { throw 'Prompt handoff is missing.' }
if ($app -match 'accounts:signInWithPassword' -or $html -match 'type=["'']password["'']') { throw 'Hosted POC exposes password authentication to the page.' }
if ($app -notmatch 'AUTHENTICATE_POC' -or $app -notmatch 'pocIdToken') { throw 'Hosted POC does not delegate Firebase authentication to the extension.' }
if ($html -notmatch 'value="O1234567"[^>]*readonly' -or $app -notmatch 'await launchGemini\(\)') { throw 'Single-click POC-to-Gemini flow is missing.' }
if ($worker -match 'accounts:signInWithPassword' -or $worker -notmatch 'authenticatePoc') { throw 'Extension does not delegate POC password authentication to the native host.' }
if ($app -match 'LOGIN_DIGEST|crypto\.subtle') { throw 'Client-side digest login is forbidden.' }
if ($worker -notmatch 'accounts:lookup' -or $worker -notmatch 'POC_AUTH_REQUIRED') { throw 'Extension does not verify Firebase authentication.' }
if ($worker -notmatch 'isAllowedIncognitoAccess' -or $app -notmatch 'incognitoAccessAllowed') { throw 'InPrivate permission gate is missing.' }
if ($nativeHost -notmatch 'CredReadW') { throw 'Native host does not read Windows Credential Manager.' }
if ($nativeHost -notmatch 'accounts:signInWithPassword' -or $nativeHost -notmatch 'PocFirebaseUid') { throw 'Native host does not pin and authenticate the POC Firebase identity.' }
if ($nativeHost -notmatch 'ExpectedCallerOrigin' -or $nativeHost -notmatch 'ProtocolVersion') { throw 'Native caller or strict protocol validation is missing.' }
if ($nativeHost -notmatch 'MaximumMessageBytes') { throw 'Native message bound is missing.' }
if ($nativeHost -match '(?i)@[s]{2}w0rd') { throw 'A password-like literal is present in native-host source.' }
if (($worker + $app + $html) -match '(?i)@[s]{2}w0rd') { throw 'A password-like literal is present in web/extension source.' }
if ($worker -match 'chrome\.storage\.(local|sync)') { throw 'Extension must not persist credentials.' }
if ($worker -notmatch 'chrome\.storage\.session') { throw 'MV3 run state must survive service-worker restarts in session storage.' }
if ($worker -notmatch 'AUTH_TIMEOUT' -or $worker -notmatch 'chrome\.alarms') { throw 'Stalled Google authentication must fail closed.' }
if ($firebase.hosting.site -ne 'poc-after-sso-login-gemini') { throw 'Wrong Firebase Hosting site.' }
if ($firebase.auth.providers.emailPassword -ne $true) { throw 'Firebase Email/Password authentication is not configured.' }
if (($firebase.hosting.headers | ConvertTo-Json -Depth 20) -match 'identitytoolkit\.googleapis\.com') { throw 'Hosted page must not connect directly to Firebase password authentication.' }
if ($firebase.hosting.PSObject.Properties.Name -contains 'functions') { throw 'Firebase Functions are outside this static POC.' }
if ($html -notmatch '/app.js\?v=0\.9\.2' -or $html -notmatch '/styles.css\?v=0\.9\.2') { throw 'Hosted assets are not cache-busted.' }
if ($worker -notmatch 'documentIds' -or $worker -notmatch 'webNavigation\.getFrame') { throw 'Exact-document reconciliation is missing.' }
if ($worker -notmatch 'windows\.getAll' -or $worker -notmatch 'INCOGNITO_SESSION_NOT_FRESH') { throw 'Fresh InPrivate session gate is missing.' }
if ($worker -notmatch 'credentialState' -or $worker -notmatch 'CREDENTIAL_ALREADY_CLAIMED') { throw 'Atomic one-shot credential state is missing.' }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'reference-agent\BrowserWorkerPool.cs'))) { throw 'Copied Agent reference is missing.' }
if (Test-Path -LiteralPath (Join-Path $projectRoot 'package.json')) { throw 'Node runtime dependency is forbidden.' }
if (-not (Test-Path -LiteralPath $archivePath)) { throw 'Packaged extension archive is missing.' }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  $expectedEntries = @(
    'bootstrap/Install.ps1',
    'bootstrap/NativeHost.cs',
    'extension/content-script.js',
    'extension/manifest.json',
    'extension/service-worker.js'
  )
  $actualEntries = @($archive.Entries |
    Where-Object { -not [string]::IsNullOrEmpty($_.Name) } |
    ForEach-Object { $_.FullName.Replace('\', '/') } |
    Sort-Object)
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
} finally {
  $archive.Dispose()
}

$publicKey = [Convert]::FromBase64String($manifest.key)
$sha256 = [Security.Cryptography.SHA256]::Create()
try { $hash = $sha256.ComputeHash($publicKey) } finally { $sha256.Dispose() }
$alphabet = 'abcdefghijklmnop'
$actualExtensionId = -join ($hash[0..15] | ForEach-Object { $alphabet[($_ -shr 4)] + $alphabet[($_ -band 15)] })
if ($actualExtensionId -ne $expectedExtensionId) { throw "Manifest key resolves to $actualExtensionId" }

Write-Output 'PASS isolated-new-project'
Write-Output 'PASS manifest-v3-fixed-id'
Write-Output 'PASS one-shot-native-credential-bridge'
Write-Output 'PASS no-password-in-source-or-extension-storage'
Write-Output 'PASS hidden-inprivate-login-window'
Write-Output 'PASS exact-account-confirmation-gate'
Write-Output 'PASS prompt-handoff-after-confirmation'
Write-Output 'PASS firebase-auth-gates-extension-agent'
Write-Output 'PASS hosted-page-never-handles-password'
Write-Output 'PASS single-click-poc-to-gemini-flow'
Write-Output 'PASS native-host-firebase-uid-and-caller-gate'
Write-Output 'PASS exact-document-reconciliation'
Write-Output 'PASS atomic-credential-and-fresh-incognito-gates'
Write-Output 'PASS inprivate-access-gate'
Write-Output 'PASS mv3-session-state-recovery'
Write-Output 'PASS stalled-authentication-timeout'
Write-Output 'PASS static-firebase-hosting-no-idle-compute'
Write-Output 'PASS no-node-runtime-dependency'
Write-Output 'PASS copied-agent-reference'
Write-Output 'PASS packaged-extension-current'
