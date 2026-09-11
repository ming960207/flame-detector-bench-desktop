[CmdletBinding()]
param(
    [string]$Commit,
    [switch]$StartAfterRollback
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    Write-Host "ROLLBACK ERROR: $Message" -ForegroundColor Red
    exit 1
}

function Invoke-Checked([string]$Label, [string]$Command, [string[]]$Arguments) {
    Write-Host "`n[ROLLBACK] $Label" -ForegroundColor Cyan
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE" }
}

function Test-CommandShim([string]$PathValue) {
    if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) { return $false }
    $file = Get-Item -LiteralPath $PathValue
    if ($file.Length -le 0 -or $file.Length -ge 64KB) { return $false }
    try {
        $text = [System.IO.File]::ReadAllText($PathValue)
        return -not $text.Contains([char]0) -and $text -match 'node|npm'
    } catch { return $false }
}

function ShanghaiNow {
    return [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8)).ToString('yyyy-MM-dd HH:mm:ss zzz')
}

function Read-JsonFile([string]$PathValue) {
    if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) { return $null }
    try {
        $text = [System.IO.File]::ReadAllText($PathValue)
        if ([string]::IsNullOrWhiteSpace($text)) { return $null }
        return $text | ConvertFrom-Json
    } catch { return $null }
}

function Write-JsonFile([string]$PathValue, $Value) {
    $directory = Split-Path -Parent $PathValue
    if ($directory) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    $json = $Value | ConvertTo-Json -Depth 8
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($PathValue, $json, $utf8)
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

$targetBranch = 'refactor/unified-backend'
$publicRemote = 'https://github.com/ming960207/flame-detector-bench-desktop.git'
$remoteRef = "refs/remotes/origin/$targetBranch"
$fetchRefspec = "+refs/heads/${targetBranch}:${remoteRef}"
$runtimeMarker = Join-Path $repoRoot 'logs\runtime-build.json'
$rollbackStatePath = Join-Path $repoRoot 'logs\rollback-state.json'
$preservedToolDir = Join-Path $repoRoot 'logs\rollback-tools'
$preservedRollbackScript = Join-Path $preservedToolDir 'rollback-last-update.ps1'
$preservedRollbackCmd = Join-Path $preservedToolDir 'rollback-last-update.cmd'
$scriptDestination = Join-Path $repoRoot 'scripts\rollback-last-update.ps1'
$cmdDestination = Join-Path $repoRoot 'scripts\rollback-last-update.cmd'

function Test-GitCommit([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    & git cat-file -e "$Value^{commit}" 2>$null
    return $LASTEXITCODE -eq 0
}

function Fetch-TargetBranch {
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        Write-Host "Fetching rollback history from GitHub (attempt $attempt/3)..."
        & git -c credential.helper= -c http.version=HTTP/1.1 fetch --no-tags origin $fetchRefspec
        if ($LASTEXITCODE -eq 0) { return }
        if ($attempt -lt 3) { Start-Sleep -Seconds ($attempt * 3) }
    }
    throw 'Unable to fetch target branch from GitHub after 3 attempts.'
}

function Ensure-RollbackCommitAvailable([string]$TargetCommit) {
    if (Test-GitCommit $TargetCommit) { return }
    $gitShallow = Join-Path $repoRoot '.git\shallow'
    if (Test-Path -LiteralPath $gitShallow) {
        Write-Host '[ROLLBACK] Local clone is shallow. Fetching full branch history...' -ForegroundColor Yellow
        & git -c credential.helper= -c http.version=HTTP/1.1 fetch --unshallow --no-tags origin $fetchRefspec
        if ($LASTEXITCODE -ne 0) { throw 'Unable to unshallow repository history.' }
    } else {
        Write-Host '[ROLLBACK] Target commit is not local. Fetching branch history again...' -ForegroundColor Yellow
        & git -c credential.helper= -c http.version=HTTP/1.1 fetch --no-tags origin $fetchRefspec
        if ($LASTEXITCODE -ne 0) { throw 'Unable to fetch rollback commit history.' }
    }
    if (-not (Test-GitCommit $TargetCommit)) { throw "Rollback commit is not available from the configured branch: $TargetCommit" }
}

function Assert-CommitBelongsToBranch([string]$TargetCommit) {
    & git merge-base --is-ancestor $TargetCommit $remoteRef 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Refusing rollback because target commit is not an ancestor of origin/$targetBranch: $TargetCommit" }
}

function Stop-ProjectRuntimeProcesses {
    Write-Host '[CHECK] Stopping running project Electron/Node processes...' -ForegroundColor Cyan
    try {
        $escapedRoot = [Regex]::Escape($repoRoot)
        $targets = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
            $_.ProcessId -ne $PID -and
            ($_.Name -ieq 'node.exe' -or $_.Name -ieq 'electron.exe') -and
            $_.CommandLine -and $_.CommandLine -match $escapedRoot
        })
        foreach ($process in $targets) { Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop }
        if ($targets.Count -gt 0) { Start-Sleep -Milliseconds 800 }
    } catch {
        Write-Host "WARN: Runtime process detection failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

function Restore-DependencySet(
    [string]$Label,
    [string]$RequiredShim,
    [string[]]$CiArguments,
    [string[]]$InstallArguments,
    [string]$LockPath
) {
    if (Test-CommandShim $RequiredShim) { return }
    Write-Host "[REPAIR] $Label toolchain missing. Trying npm ci..." -ForegroundColor Yellow
    & npm.cmd @CiArguments
    if ($LASTEXITCODE -eq 0 -and (Test-CommandShim $RequiredShim)) { return }
    Write-Host "WARN: npm ci failed for $Label; falling back to npm install." -ForegroundColor Yellow
    & npm.cmd @InstallArguments
    if ($LASTEXITCODE -ne 0 -or -not (Test-CommandShim $RequiredShim)) { throw "$Label dependency repair failed." }
    & git checkout -f -- $LockPath
    if ($LASTEXITCODE -ne 0) { throw "Unable to restore tracked lock file: $LockPath" }
}

function Ensure-Dependencies {
    Restore-DependencySet 'Root/web' (Join-Path $repoRoot 'node_modules\.bin\vite.cmd') @('ci') @('install') 'package-lock.json'
    Restore-DependencySet 'Server' (Join-Path $repoRoot 'server\node_modules\.bin\tsc.cmd') @('ci', '--prefix', 'server') @('install', '--prefix', 'server') 'server/package-lock.json'
}

function Remove-RuntimeOutput([string]$RelativePath) {
    $path = Join-Path $repoRoot $RelativePath
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
}

function Assert-RuntimeArtifact([string]$RelativePath, [datetime]$BuildStartedAt) {
    $path = Join-Path $repoRoot $RelativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required runtime artifact was not generated: $RelativePath" }
    $file = Get-Item -LiteralPath $path
    if ($file.Length -le 0) { throw "Generated runtime artifact is empty: $RelativePath" }
    if ($file.LastWriteTimeUtc -lt $BuildStartedAt.ToUniversalTime().AddSeconds(-2)) { throw "Runtime artifact was not freshly rebuilt: $RelativePath" }
}

function Write-RuntimeBuildMarker([string]$SoftwareCommit, [string]$RollbackFromCommit) {
    $serverMain = Join-Path $repoRoot 'server\dist\main.js'
    $webIndex = Join-Path $repoRoot 'dist\index.html'
    $marker = [ordered]@{
        branch = $targetBranch
        softwareCommit = $SoftwareCommit
        repositoryCommit = $SoftwareCommit
        builtAtShanghai = ShanghaiNow
        timezone = 'Asia/Shanghai (UTC+8)'
        operation = 'rollback'
        rollbackFromSoftwareCommit = $RollbackFromCommit
        nodeVersion = (& node.exe --version)
        npmVersion = (& npm.cmd --version)
        serverMainSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $serverMain).Hash
        webIndexSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $webIndex).Hash
    }
    Write-JsonFile $runtimeMarker $marker
    Write-JsonFile (Join-Path $repoRoot 'server\dist\runtime-build.json') $marker
    Write-JsonFile (Join-Path $repoRoot 'dist\runtime-build.json') $marker
}

function Preserve-RollbackTool {
    New-Item -ItemType Directory -Path $preservedToolDir -Force | Out-Null
    Copy-Item -LiteralPath $PSCommandPath -Destination $preservedRollbackScript -Force
    $cmdText = '@echo off' + "`r`n" + 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0rollback-last-update.ps1" %*' + "`r`n"
    [System.IO.File]::WriteAllText($preservedRollbackCmd, $cmdText, (New-Object System.Text.ASCIIEncoding))
}

function Restore-RollbackTool {
    New-Item -ItemType Directory -Path (Split-Path -Parent $scriptDestination) -Force | Out-Null
    Copy-Item -LiteralPath $preservedRollbackScript -Destination $scriptDestination -Force
    Copy-Item -LiteralPath $preservedRollbackCmd -Destination $cmdDestination -Force
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'Git is not installed or not available in PATH.' }
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { Fail 'Node.js is not installed or node.exe is not available in PATH.' }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { Fail 'npm is not installed or npm.cmd is not available in PATH.' }

try { $insideRepo = (& git rev-parse --is-inside-work-tree 2>$null).Trim() } catch { Fail 'This script must be run from a Git working tree.' }
if ($insideRepo -ne 'true') { Fail 'This script must be run from a Git working tree.' }

$state = Read-JsonFile $rollbackStatePath
if (-not $Commit) {
    if (-not $state -or -not $state.previousSoftwareCommit) {
        Fail "No recorded rollback point was found at $rollbackStatePath. Run the new updater once before using automatic rollback."
    }
    $Commit = [string]$state.previousSoftwareCommit
}

& git remote set-url origin $publicRemote
if ($LASTEXITCODE -ne 0) { Fail 'Unable to configure the public GitHub remote.' }

$oldPrompt = $env:GIT_TERMINAL_PROMPT
$env:GIT_TERMINAL_PROMPT = '0'
try {
    $rollbackFrom = (& git rev-parse HEAD).Trim()
    $runtimeBefore = Read-JsonFile $runtimeMarker
    if ($runtimeBefore -and $runtimeBefore.softwareCommit) { $rollbackFrom = [string]$runtimeBefore.softwareCommit }

    Write-Host "Repository: $repoRoot"
    Write-Host "Rollback target: $Commit"
    Write-Host 'WARNING: Local source changes and local-only commits will be discarded.' -ForegroundColor Yellow
    Write-Host 'Ignored logs, diagnostic archives, and rollback history are preserved.'

    Preserve-RollbackTool
    Stop-ProjectRuntimeProcesses
    Fetch-TargetBranch
    Ensure-RollbackCommitAvailable $Commit
    Assert-CommitBelongsToBranch $Commit

    if ($rollbackFrom -eq $Commit) {
        Write-Host 'Current runtime is already at the recorded rollback target; no rollback is required.' -ForegroundColor Green
        Restore-RollbackTool
        exit 0
    }

    Write-Host "[ROLLBACK] Switching source to $Commit..." -ForegroundColor Cyan
    & git checkout -f -B $targetBranch $Commit
    if ($LASTEXITCODE -ne 0) { throw "Unable to checkout rollback commit $Commit." }
    & git branch --set-upstream-to="origin/$targetBranch" $targetBranch *> $null

    & git clean -fd
    if ($LASTEXITCODE -ne 0) { throw 'git clean -fd failed.' }

    Invoke-Checked 'Validate Electron main process syntax' 'node.exe' @('--check', 'desktop\main.cjs')
    Ensure-Dependencies
    Remove-RuntimeOutput 'dist'
    Remove-RuntimeOutput 'server\dist'

    $buildStartedAt = Get-Date
    Invoke-Checked 'Build rollback backend runtime' 'npm.cmd' @('run', 'build:server')
    Invoke-Checked 'Build rollback frontend runtime' 'npm.cmd' @('run', 'build:web')
    Assert-RuntimeArtifact 'server\dist\main.js' $buildStartedAt
    Assert-RuntimeArtifact 'dist\index.html' $buildStartedAt
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'dist\assets') -PathType Container)) { throw 'Desktop frontend assets directory was not generated: dist\assets' }

    $rolledBackCommit = (& git rev-parse HEAD).Trim()
    if ($rolledBackCommit -ne $Commit) { throw 'Rollback verification failed: HEAD does not match requested commit.' }
    Write-RuntimeBuildMarker $rolledBackCommit $rollbackFrom

    if ($state) {
        $state.status = 'rolled-back'
        $state | Add-Member -NotePropertyName rolledBackAtShanghai -NotePropertyValue (ShanghaiNow) -Force
        $state | Add-Member -NotePropertyName rolledBackFromSoftwareCommit -NotePropertyValue $rollbackFrom -Force
        $state | Add-Member -NotePropertyName rolledBackToSoftwareCommit -NotePropertyValue $rolledBackCommit -Force
        Write-JsonFile $rollbackStatePath $state
    }

    Restore-RollbackTool

    Write-Host ''
    Write-Host 'SUCCESS: SOURCE + BACKEND + FRONTEND WERE ROLLED BACK.' -ForegroundColor Green
    Write-Host "Rollback from: $($rollbackFrom.Substring(0, [Math]::Min(12, $rollbackFrom.Length)))"
    Write-Host "Rollback to:   $((& git rev-parse --short HEAD).Trim())"
    Write-Host "Runtime marker: $runtimeMarker"
    Write-Host "Rollback state: $rollbackStatePath"
    Write-Host 'To return to the newest version later, run scripts\update-current-branch.ps1.' -ForegroundColor Cyan

    if ($StartAfterRollback) {
        Write-Host 'Starting desktop application...' -ForegroundColor Cyan
        Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'desktop') -WorkingDirectory $repoRoot
    }
    exit 0
} catch {
    Write-Host ''
    Write-Host "ROLLBACK FAILED: $($_.Exception.Message)" -ForegroundColor Red
    try { Restore-RollbackTool } catch { }
    Write-Host 'The rollback record remains in logs\rollback-state.json. Fix the reported error and run the rollback script again.' -ForegroundColor Yellow
    exit 1
} finally {
    $env:GIT_TERMINAL_PROMPT = $oldPrompt
}
