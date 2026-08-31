$ErrorActionPreference = 'Stop'

$hostPath = Join-Path $env:LOCALAPPDATA 'GeminiExtensionAgentPoc\GeminiCredentialHost.exe'
$expectedOrigin = 'chrome-extension://jeenmgigpkffleijbmfciffiodlcdafh/'

if (-not (Test-Path -LiteralPath $hostPath)) {
  throw 'Installed native host is missing. Run bootstrap\Install.ps1 first.'
}

function Invoke-NativeHostFrame {
  param(
    [Parameter(Mandatory)] [string]$Action,
    [Parameter(Mandatory)] [string]$CallerOrigin,
    [switch]$AddUnexpectedField
  )

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $hostPath
  $startInfo.Arguments = $CallerOrigin
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.CreateNoWindow = $true
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw 'Native host did not start.' }

  $request = [ordered]@{
    version = 9
    action = $Action
    requestId = [Guid]::NewGuid().ToString()
  }
  if ($AddUnexpectedField) { $request.unexpected = $true }
  $requestBytes = [Text.UTF8Encoding]::new($false).GetBytes(($request | ConvertTo-Json -Compress))
  try {
    $lengthBytes = [BitConverter]::GetBytes([int]$requestBytes.Length)
    try {
      $process.StandardInput.BaseStream.Write($lengthBytes, 0, $lengthBytes.Length)
      $process.StandardInput.BaseStream.Write($requestBytes, 0, $requestBytes.Length)
      $process.StandardInput.BaseStream.Flush()
    } catch {
      # An invalid caller can be rejected before the process reads stdin.
    } finally {
      $process.StandardInput.Close()
    }

    $responseLengthBytes = New-Object byte[] 4
    if ($process.StandardOutput.BaseStream.Read($responseLengthBytes, 0, 4) -ne 4) {
      throw 'Native host response length is missing.'
    }
    $responseLength = [BitConverter]::ToInt32($responseLengthBytes, 0)
    $responseBytes = New-Object byte[] $responseLength
    $offset = 0
    while ($offset -lt $responseLength) {
      $read = $process.StandardOutput.BaseStream.Read($responseBytes, $offset, $responseLength - $offset)
      if ($read -le 0) { throw 'Native host response ended early.' }
      $offset += $read
    }
    $process.WaitForExit()
    $response = [Text.Encoding]::UTF8.GetString($responseBytes) | ConvertFrom-Json
    [Array]::Clear($responseBytes, 0, $responseBytes.Length)
    return [pscustomobject]@{ ExitCode = $process.ExitCode; Response = $response }
  } finally {
    [Array]::Clear($requestBytes, 0, $requestBytes.Length)
    $process.Dispose()
  }
}

$poc = Invoke-NativeHostFrame -Action 'authenticatePoc' -CallerOrigin $expectedOrigin
if ($poc.ExitCode -ne 0 -or $poc.Response.ok -ne $true) { throw 'POC native authentication failed.' }
if ($poc.Response.username -ne 'O1234567' -or [string]::IsNullOrWhiteSpace($poc.Response.idToken)) {
  throw 'POC native authentication returned an invalid identity.'
}
if ($null -ne $poc.Response.password) { throw 'POC password escaped the native host.' }
$poc.Response.idToken = $null

$google = Invoke-NativeHostFrame -Action 'getGoogleCredential' -CallerOrigin $expectedOrigin
if ($google.ExitCode -ne 0 -or $google.Response.ok -ne $true) { throw 'Google credential request failed.' }
if ($google.Response.email -ne 'codeassist.04@easybuy.co.th' -or [string]::IsNullOrEmpty($google.Response.password)) {
  throw 'Google credential response was invalid.'
}
$google.Response.password = $null

$badCaller = Invoke-NativeHostFrame -Action 'authenticatePoc' -CallerOrigin 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'
if ($badCaller.ExitCode -eq 0 -or $badCaller.Response.ok -ne $false) { throw 'Invalid native caller was accepted.' }

$badSchema = Invoke-NativeHostFrame -Action 'authenticatePoc' -CallerOrigin $expectedOrigin -AddUnexpectedField
if ($badSchema.ExitCode -eq 0 -or $badSchema.Response.ok -ne $false) { throw 'Unexpected native request fields were accepted.' }

Write-Output 'PASS native-host-authenticates-poc-without-returning-password'
Write-Output 'PASS native-host-gates-google-credential-through-firebase'
Write-Output 'PASS native-host-rejects-wrong-caller-origin'
Write-Output 'PASS native-host-rejects-unknown-request-fields'
