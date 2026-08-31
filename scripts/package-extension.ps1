$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$extensionDirectory = Join-Path $projectRoot 'extension'
$downloads = Join-Path $projectRoot 'public\downloads'
$manifest = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'extension\manifest.json') | ConvertFrom-Json
$archive = Join-Path $downloads "gemini-extension-agent-poc-v$($manifest.version).zip"

New-Item -ItemType Directory -Path $downloads -Force | Out-Null
Compress-Archive -Path $extensionDirectory -DestinationPath $archive -CompressionLevel Optimal -Force

$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Output "Created $archive"
Write-Output "SHA256 $hash"
