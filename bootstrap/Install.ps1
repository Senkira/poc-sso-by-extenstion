[CmdletBinding()]
param(
  [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'GeminiExtensionAgentPoc'),
  [string]$GoogleCredentialTarget = 'ESB.GeminiBroker.CodeAssist04',
  [string]$PocCredentialTarget = 'ESB.GeminiBroker.Poc.O1234567'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$hostName = 'com.senkira.gemini_extension_agent'
$extensionId = 'jeenmgigpkffleijbmfciffiodlcdafh'
$sourcePath = Join-Path $PSScriptRoot 'NativeHost.cs'
$hostPath = Join-Path $InstallDirectory 'GeminiCredentialHost.exe'
$buildPath = Join-Path $InstallDirectory 'GeminiCredentialHost.new.exe'
$manifestPath = Join-Path $InstallDirectory "$hostName.json"
$compilerTemp = Join-Path $InstallDirectory 'temp'

if (-not (Test-Path -LiteralPath $sourcePath)) {
  throw 'NativeHost.cs is missing.'
}
$credentialList = cmdkey.exe /list 2>$null | Out-String
foreach ($credentialTarget in @($GoogleCredentialTarget, $PocCredentialTarget)) {
  if ($credentialList -notmatch [regex]::Escape($credentialTarget)) {
    throw "Windows Credential Manager target '$credentialTarget' is missing."
  }
}

New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $compilerTemp -Force | Out-Null
$env:TEMP = $compilerTemp
$env:TMP = $compilerTemp

if (Test-Path -LiteralPath $buildPath) {
  Remove-Item -LiteralPath $buildPath -Force
}
Add-Type -Path $sourcePath `
  -OutputAssembly $buildPath `
  -OutputType ConsoleApplication `
  -ReferencedAssemblies @('System.dll', 'System.Core.dll', 'System.Web.Extensions.dll')
Move-Item -LiteralPath $buildPath -Destination $hostPath -Force

$manifest = [ordered]@{
  name = $hostName
  description = 'One-shot Windows Credential Manager bridge for Gemini Extension Agent POC'
  path = $hostPath
  type = 'stdio'
  allowed_origins = @("chrome-extension://$extensionId/")
} | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText($manifestPath, $manifest, [Text.UTF8Encoding]::new($false))

$registryPaths = @(
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName",
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
)
foreach ($registryPath in $registryPaths) {
  New-Item -Path $registryPath -Force | Out-Null
  Set-Item -LiteralPath $registryPath -Value $manifestPath -Force
}

Write-Output 'PASS native-host-compiled'
Write-Output 'PASS native-host-registered-edge'
Write-Output 'PASS native-host-registered-chrome'
Write-Output 'PASS google-credential-target-present'
Write-Output 'PASS poc-credential-target-present'
Write-Output "Host: $hostPath"
