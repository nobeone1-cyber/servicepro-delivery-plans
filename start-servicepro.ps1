$ErrorActionPreference = 'Stop'
$bundledNode = 'C:\Users\JM505 Computers\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$node = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node -ErrorAction Stop).Source }
Set-Location -LiteralPath $PSScriptRoot
Write-Host 'Starting ServicePro at http://0.0.0.0:4173'
& $node (Join-Path $PSScriptRoot 'server.js')
