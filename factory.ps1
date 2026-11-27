#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Install Node.js 22 or newer to run the factory.'
}

Push-Location $PSScriptRoot
try {
    & node (Join-Path $PSScriptRoot 'factory/run.mjs') @args
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
