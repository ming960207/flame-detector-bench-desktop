$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'update-current-branch.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Updater syntax invalid' }
$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Ensure-Dependencies' }, $true)
if (-not $definition) { throw 'Ensure-Dependencies missing' }
Invoke-Expression $definition.Extent.Text
function Restore-DependencySet { }
function Invoke-Checked { }
function npm.cmd {
    if ($args[0] -eq '--version') { return 'test' }
    $script:repaired = $true
    if (-not $script:simulateMissing) { $env:NODE_PATH = $env:FLAME_TEST_NODE_MODULES }
    $global:LASTEXITCODE = 0
}
$env:NODE_PATH = ''
$script:repaired = $false
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('flame-dependency-test-' + [guid]::NewGuid().ToString('N'))
try {
    $moduleDir = Join-Path $tempRoot 'exceljs'
    New-Item -ItemType Directory -Path $moduleDir -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $moduleDir 'index.js'), 'module.exports = {};')
    $env:FLAME_TEST_NODE_MODULES = $tempRoot
    $script:simulateMissing = $false
    Ensure-Dependencies
    if (-not $script:repaired) { throw 'Missing dependency did not trigger repair' }
    $script:repaired = $false
    Ensure-Dependencies
    if ($script:repaired) { throw 'Installed dependency triggered unnecessary repair' }
    $env:NODE_PATH = ''
    $script:simulateMissing = $true
    $failed = $false
    try { Ensure-Dependencies } catch { $failed = $_.Exception.Message -match 'still unavailable' }
    if (-not $failed) { throw 'Unsuccessful repair did not fail the update' }
    Write-Host 'PASS: missing ExcelJS triggers repair under Windows PowerShell'
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
