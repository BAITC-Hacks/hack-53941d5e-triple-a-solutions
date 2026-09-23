$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (!(Test-Path -LiteralPath $nodePath)) { throw 'Install Node.js 24 or newer, then run npm start.' }
& $nodePath --env-file-if-exists=.env.local src/backend/server.mjs
exit $LASTEXITCODE
