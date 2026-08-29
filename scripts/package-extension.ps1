$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $projectRoot 'extension\*'
$downloads = Join-Path $projectRoot 'public\downloads'
$archive = Join-Path $downloads 'gemini-sso-launcher-extension-v0.1.0.zip'

New-Item -ItemType Directory -Path $downloads -Force | Out-Null
Compress-Archive -Path $source -DestinationPath $archive -CompressionLevel Optimal -Force

$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Output "Created $archive"
Write-Output "SHA256 $hash"

