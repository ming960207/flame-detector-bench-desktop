[CmdletBinding()]
param(
    [switch]$StartAfterUpdate
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

function Invoke-Checked([string]$Label, [string]$Command, [string[]]$Arguments) {
    Write-Host "`n[UPDATE] $Label" -ForegroundColor Cyan
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
$updateHistoryPath = Join-Path $repoRoot 'logs\update-history.json'
$initialUpdaterHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $PSCommandPath).Hash

function Test-GitCommit([string]$Commit) {
    if ([string]::IsNullOrWhiteSpace($Commit)) { return $false }
    & git cat-file -e "$Commit^{commit}" 2>$null
    return $LASTEXITCODE -eq 0
}

function Get-InstalledRuntimeInfo {
    $marker = Read-JsonFile $runtimeMarker
    $softwareCommit = if ($marker -and $marker.softwareCommit) { [string]$marker.softwareCommit } else { '' }
    $repositoryCommit = if ($marker -and $marker.repositoryCommit) { [string]$marker.repositoryCommit } else { '' }
    $builtAt = if ($marker -and $marker.builtAtShanghai) { [string]$marker.builtAtShanghai } else { '' }

    if (-not (Test-GitCommit $softwareCommit)) {
        if ($env:FLAME_UPDATER_PREVIOUS_COMMIT -and (Test-GitCommit $env:FLAME_UPDATER_PREVIOUS_COMMIT)) {
            $softwareCommit = $env:FLAME_UPDATER_PREVIOUS_COMMIT
        } elseif ($env:FLAME_UPDATER_REEXEC -eq '1') {
            try {
                $reflogPrevious = (& git rev-parse 'HEAD@{1}' 2>$null).Trim()
                if (Test-GitCommit $reflogPrevious) { $softwareCommit = $reflogPrevious }
            } catch { }
        }
    }
    if (-not (Test-GitCommit $softwareCommit)) { $softwareCommit = (& git rev-parse HEAD).Trim() }
    if (-not (Test-GitCommit $repositoryCommit)) { $repositoryCommit = $softwareCommit }

    return [ordered]@{
        softwareCommit = $softwareCommit
        repositoryCommit = $repositoryCommit
        builtAtShanghai = $builtAt
    }
}

function Get-SoftwareChanges([string]$BaseCommit, [string]$HeadCommit) {
    if ($BaseCommit -eq $HeadCommit) { return @() }
    $names = @(& git diff --name-only $BaseCommit $HeadCommit --)
    if ($LASTEXITCODE -ne 0) { throw "Unable to compare $BaseCommit with $HeadCommit." }
    return @($names | Where-Object {
        $name = ($_ -replace '\\', '/')
        $name -and -not $name.StartsWith('diagnostic-logs/') -and -not $name.StartsWith('logs/')
    })
}

function Prepare-RollbackState([string]$TargetCommit) {
    if ($env:FLAME_UPDATER_ROLLBACK_PREPARED -eq '1') { return }
    $installed = Get-InstalledRuntimeInfo
    $previousSoftware = [string]$installed.softwareCommit
    $previousRepository = [string]$installed.repositoryCommit
    $changes = @(Get-SoftwareChanges $previousSoftware $TargetCommit)

    if ($changes.Count -eq 0) {
        Write-Host '[ROLLBACK] No software change detected; existing rollback point is preserved.' -ForegroundColor DarkGray
        $env:FLAME_UPDATER_ROLLBACK_PREPARED = '1'
        $env:FLAME_UPDATER_PREVIOUS_COMMIT = $previousSoftware
        return
    }

    $state = [ordered]@{
        schemaVersion = 1
        branch = $targetBranch
        status = 'prepared'
        previousSoftwareCommit = $previousSoftware
        previousRepositoryCommit = $previousRepository
        previousRuntimeBuiltAtShanghai = [string]$installed.builtAtShanghai
        updateTargetCommit = $TargetCommit
        recordedAtShanghai = ShanghaiNow
        timezone = 'Asia/Shanghai (UTC+8)'
        changedSoftwareFiles = $changes
    }
    Write-JsonFile $rollbackStatePath $state

    $history = @()
    $existingHistory = Read-JsonFile $updateHistoryPath
    if ($existingHistory) { $history = @($existingHistory) }
    $history += [pscustomobject]$state
    if ($history.Count -gt 20) { $history = @($history | Select-Object -Last 20) }
    Write-JsonFile $updateHistoryPath $history

    $env:FLAME_UPDATER_ROLLBACK_PREPARED = '1'
    $env:FLAME_UPDATER_PREVIOUS_COMMIT = $previousSoftware
    Write-Host "[ROLLBACK] Previous working runtime recorded: $($previousSoftware.Substring(0, [Math]::Min(12, $previousSoftware.Length)))" -ForegroundColor Green
    Write-Host "[ROLLBACK] State file: $rollbackStatePath" -ForegroundColor Green
}

function Complete-RollbackState([string]$SoftwareCommit, [string]$RepositoryCommit) {
    $state = Read-JsonFile $rollbackStatePath
    if (-not $state -or $state.status -ne 'prepared') { return }
    $state.status = 'ready'
    $state | Add-Member -NotePropertyName updatedToSoftwareCommit -NotePropertyValue $SoftwareCommit -Force
    $state | Add-Member -NotePropertyName updatedToRepositoryCommit -NotePropertyValue $RepositoryCommit -Force
    $state | Add-Member -NotePropertyName updateCompletedAtShanghai -NotePropertyValue (ShanghaiNow) -Force
    Write-JsonFile $rollbackStatePath $state
}

function Test-GitHubAccess([int]$Attempts = 3) {
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        Write-Host "Checking GitHub repository access (attempt $attempt/$Attempts)..."
        & git -c credential.helper= -c http.version=HTTP/1.1 ls-remote --exit-code $publicRemote "refs/heads/$targetBranch" *> $null
        if ($LASTEXITCODE -eq 0) {
            Write-Host 'GitHub access: OK' -ForegroundColor Green
            return $true
        }
        if ($attempt -lt $Attempts) {
            $delay = $attempt * 3
            Write-Host "WARN: GitHub access check failed. Retrying in $delay seconds..." -ForegroundColor Yellow
            Start-Sleep -Seconds $delay
        }
    }
    return $false
}

function Fetch-TargetBranch([switch]$BestEffort) {
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        Write-Host "Fetching target branch (attempt $attempt/3)..."
        & git -c credential.helper= -c http.version=HTTP/1.1 fetch --no-tags origin $fetchRefspec
        if ($LASTEXITCODE -eq 0) {
            & git rev-parse --verify $remoteRef *> $null
            if ($LASTEXITCODE -eq 0) { return $true }
        }
        if ($attempt -lt 3) {
            $delay = $attempt * 3
            Write-Host "WARN: Fetch failed. Retrying in $delay seconds..." -ForegroundColor Yellow
            Start-Sleep -Seconds $delay
        }
    }
    if ($BestEffort) {
        Write-Host 'WARN: GitHub became unavailable after source synchronization; the freshly rebuilt pinned runtime remains valid.' -ForegroundColor Yellow
        return $false
    }
    throw 'git fetch failed after 3 attempts. Retry after checking network stability.'
}

function Restart-WithUpdatedUpdaterIfNeeded([string]$PinnedCommit) {
    if ($env:FLAME_UPDATER_REEXEC -eq '1') { return }
    $diskHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $PSCommandPath).Hash
    if ($diskHash -eq $initialUpdaterHash) { return }

    Write-Host ''
    Write-Host '[UPDATE] Updater changed during synchronization.' -ForegroundColor Yellow
    Write-Host '[UPDATE] Restarting with the newly downloaded updater at the synchronized commit...' -ForegroundColor Yellow
    $env:FLAME_UPDATER_REEXEC = '1'
    $env:FLAME_UPDATER_PINNED_COMMIT = $PinnedCommit
    $childArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
    if ($StartAfterUpdate) { $childArgs += '-StartAfterUpdate' }
    & powershell.exe @childArgs
    exit $LASTEXITCODE
}

function Stop-ProjectRuntimeProcesses {
    Write-Host '[CHECK] Stopping running project Electron/Node processes before rebuilding...' -ForegroundColor Cyan
    try {
        $escapedRoot = [Regex]::Escape($repoRoot)
        $targets = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
            $_.ProcessId -ne $PID -and
            ($_.Name -ieq 'node.exe' -or $_.Name -ieq 'electron.exe') -and
            $_.CommandLine -and $_.CommandLine -match $escapedRoot
        })
        foreach ($process in $targets) {
            Write-Host "Stopping $($process.Name) PID=$($process.ProcessId)"
            Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
        }
        if ($targets.Count -gt 0) { Start-Sleep -Milliseconds 800 }
    } catch {
        Write-Host "WARN: Runtime process detection failed: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host 'Build will continue and will fail if runtime files are locked.' -ForegroundColor Yellow
    }
}

function Restore-DependencySet(
    [string]$Label,
    [string]$RequiredShim,
    [string[]]$CiArguments,
    [string[]]$InstallArguments,
    [string]$LockPath
) {
    if (Test-CommandShim $RequiredShim) {
        Write-Host "[OK] $Label toolchain already present; preserving the working field dependency set." -ForegroundColor Green
        return
    }
    Write-Host "[REPAIR] $Label toolchain missing. Trying npm ci..." -ForegroundColor Yellow
    & npm.cmd @CiArguments
    if ($LASTEXITCODE -eq 0 -and (Test-CommandShim $RequiredShim)) { return }

    Write-Host "WARN: npm ci could not restore $Label dependencies. Falling back to npm install." -ForegroundColor Yellow
    & npm.cmd @InstallArguments
    if ($LASTEXITCODE -ne 0 -or -not (Test-CommandShim $RequiredShim)) {
        throw "$Label dependency repair failed with npm ci and npm install."
    }
    & git checkout -f -- $LockPath
    if ($LASTEXITCODE -ne 0) { throw "Unable to restore tracked lock file: $LockPath" }
}

function Ensure-Dependencies {
    Write-Host "Node: $(& node.exe --version)"
    Write-Host "npm: $(& npm.cmd --version)"
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

function Write-RuntimeBuildMarker([string]$SoftwareCommit, [string]$RepositoryCommit) {
    $serverMain = Join-Path $repoRoot 'server\dist\main.js'
    $webIndex = Join-Path $repoRoot 'dist\index.html'
    $marker = [ordered]@{
        branch = $targetBranch
        softwareCommit = $SoftwareCommit
        repositoryCommit = $RepositoryCommit
        builtAtShanghai = ShanghaiNow
        timezone = 'Asia/Shanghai (UTC+8)'
        operation = 'update'
        nodeVersion = (& node.exe --version)
        npmVersion = (& npm.cmd --version)
        serverMainSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $serverMain).Hash
        webIndexSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $webIndex).Hash
    }
    Write-JsonFile $runtimeMarker $marker
    Write-JsonFile (Join-Path $repoRoot 'server\dist\runtime-build.json') $marker
    Write-JsonFile (Join-Path $repoRoot 'dist\runtime-build.json') $marker
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'Git is not installed or is not available in PATH.' }
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { Fail 'Node.js is not installed or node.exe is not available in PATH.' }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { Fail 'npm is not installed or npm.cmd is not available in PATH.' }
if (-not (Get-Command powershell.exe -ErrorAction SilentlyContinue)) { Fail 'Windows PowerShell is not available in PATH.' }

try { $insideRepo = (& git rev-parse --is-inside-work-tree 2>$null).Trim() } catch { Fail 'This script must be run from a Git working tree.' }
if ($insideRepo -ne 'true') { Fail 'This script must be run from a Git working tree.' }

& git remote set-url origin $publicRemote
if ($LASTEXITCODE -ne 0) { Fail 'Unable to configure the public GitHub remote.' }

$oldPrompt = $env:GIT_TERMINAL_PROMPT
$env:GIT_TERMINAL_PROMPT = '0'
try {
    $beforeFull = (& git rev-parse HEAD).Trim()
    $before = (& git rev-parse --short HEAD).Trim()
    Write-Host "Repository: $repoRoot"
    Write-Host "Target branch: $targetBranch"
    Write-Host "Remote: $publicRemote"
    Write-Host "Current commit: $before"
    Write-Host 'WARNING: Local source changes and local-only commits will be discarded.' -ForegroundColor Yellow
    Write-Host 'Ignored runtime data such as logs and rollback history are preserved.'

    $resumeFromSynchronizedCommit = ($env:FLAME_UPDATER_REEXEC -eq '1')
    $pinnedCommit = $null
    if ($resumeFromSynchronizedCommit) {
        $pinnedCommit = $env:FLAME_UPDATER_PINNED_COMMIT
        if (-not $pinnedCommit) { $pinnedCommit = (& git rev-parse HEAD).Trim() }
        if ((& git rev-parse HEAD).Trim() -ne $pinnedCommit) { throw 'Updater resume commit does not match current HEAD.' }
        Prepare-RollbackState $pinnedCommit
        Write-Host "[UPDATE] Resuming at synchronized commit $((& git rev-parse --short HEAD).Trim())." -ForegroundColor Green
    } else {
        if (-not (Test-GitHubAccess 3)) { Fail 'GitHub repository is not reachable after 3 attempts or the target branch does not exist.' }
    }

    Stop-ProjectRuntimeProcesses
    $softwareCommit = $null
    $repositoryCommit = $null
    $buildSucceeded = $false

    for ($pass = 1; $pass -le 2; $pass++) {
        Write-Host "`n========== UPDATE PASS $pass/2 ==========" -ForegroundColor Cyan
        if ($resumeFromSynchronizedCommit -and $pass -eq 1) {
            $remoteCommit = (& git rev-parse HEAD).Trim()
        } else {
            Fetch-TargetBranch | Out-Null
            $remoteCommit = (& git rev-parse $remoteRef).Trim()
            Prepare-RollbackState $remoteCommit
            Write-Host "Remote commit: $((& git rev-parse --short $remoteRef).Trim())"
            & git checkout -f -B $targetBranch $remoteRef
            if ($LASTEXITCODE -ne 0) { throw "Unable to force switch to $targetBranch." }
            & git branch --set-upstream-to="origin/$targetBranch" $targetBranch *> $null
            Restart-WithUpdatedUpdaterIfNeeded $remoteCommit
        }

        Write-Host 'Removing non-ignored untracked files and directories...'
        & git clean -fd
        if ($LASTEXITCODE -ne 0) { throw 'git clean -fd failed.' }

        $softwareCommit = (& git rev-parse HEAD).Trim()
        if ($softwareCommit -ne $remoteCommit) { throw 'Local source commit does not match pinned/fetched source commit.' }
        Write-Host "Source synchronized: $((& git rev-parse --short HEAD).Trim())" -ForegroundColor Green

        Invoke-Checked 'Validate Electron main process syntax' 'node.exe' @('--check', 'desktop\main.cjs')
        Ensure-Dependencies
        Remove-RuntimeOutput 'dist'
        Remove-RuntimeOutput 'server\dist'

        $buildStartedAt = Get-Date
        Invoke-Checked 'Build unified backend runtime' 'npm.cmd' @('run', 'build:server')
        Invoke-Checked 'Build desktop frontend runtime' 'npm.cmd' @('run', 'build:web')
        Assert-RuntimeArtifact 'server\dist\main.js' $buildStartedAt
        Assert-RuntimeArtifact 'dist\index.html' $buildStartedAt
        if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'dist\assets') -PathType Container)) { throw 'Desktop frontend assets directory was not generated: dist\assets' }

        $postBuildFetchSucceeded = Fetch-TargetBranch -BestEffort
        if ($postBuildFetchSucceeded) {
            $latestRemoteCommit = (& git rev-parse $remoteRef).Trim()
            if ($latestRemoteCommit -ne $softwareCommit) {
                $softwareChanges = @(Get-SoftwareChanges $softwareCommit $latestRemoteCommit)
                if ($softwareChanges.Count -gt 0) {
                    if ($pass -lt 2) {
                        Write-Host 'Remote software changed during build. Repeating update against latest software...' -ForegroundColor Yellow
                        $resumeFromSynchronizedCommit = $false
                        continue
                    }
                    throw 'Remote software changed again during the second build pass. Run the updater again.'
                }
                Write-Host 'Remote advanced only by diagnostic/log commits; runtime build remains valid.'
                & git checkout -f -B $targetBranch $remoteRef
                if ($LASTEXITCODE -ne 0) { throw 'Unable to fast-forward local branch to latest log-only commit.' }
                & git branch --set-upstream-to="origin/$targetBranch" $targetBranch *> $null
            }
        }

        $repositoryCommit = (& git rev-parse HEAD).Trim()
        Write-RuntimeBuildMarker $softwareCommit $repositoryCommit
        Complete-RollbackState $softwareCommit $repositoryCommit
        $buildSucceeded = $true
        break
    }

    if (-not $buildSucceeded) { throw 'Runtime build did not complete.' }

    $currentBranch = (& git rev-parse --abbrev-ref HEAD).Trim()
    $currentShort = (& git rev-parse --short HEAD).Trim()
    $softwareShort = (& git rev-parse --short $softwareCommit).Trim()
    Write-Host ''
    Write-Host 'SUCCESS: SOURCE + BACKEND + FRONTEND ARE UPDATED.' -ForegroundColor Green
    Write-Host "Branch: $currentBranch"
    Write-Host "Previous repository commit: $before"
    Write-Host "Current repository commit: $currentShort"
    Write-Host "Software build commit: $softwareShort"
    if (Test-Path -LiteralPath $rollbackStatePath) {
        Write-Host "Rollback state: $rollbackStatePath"
        Write-Host 'Rollback command: powershell -ExecutionPolicy Bypass -File .\scripts\rollback-last-update.ps1' -ForegroundColor Cyan
    }
    Write-Host "Build marker: $runtimeMarker"

    Remove-Item Env:FLAME_UPDATER_PINNED_COMMIT -ErrorAction SilentlyContinue
    Remove-Item Env:FLAME_UPDATER_REEXEC -ErrorAction SilentlyContinue
    Remove-Item Env:FLAME_UPDATER_ROLLBACK_PREPARED -ErrorAction SilentlyContinue
    Remove-Item Env:FLAME_UPDATER_PREVIOUS_COMMIT -ErrorAction SilentlyContinue

    if ($StartAfterUpdate) {
        Write-Host 'Starting desktop application...' -ForegroundColor Cyan
        Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'desktop') -WorkingDirectory $repoRoot
    }
    exit 0
} catch {
    Write-Host ''
    Write-Host "UPDATE FAILED: $($_.Exception.Message)" -ForegroundColor Red
    if (Test-Path -LiteralPath $rollbackStatePath) {
        Write-Host 'A rollback point has been preserved. Run scripts\rollback-last-update.ps1 if the working tree/runtime needs to return to the previous version.' -ForegroundColor Yellow
    }
    exit 1
} finally {
    $env:GIT_TERMINAL_PROMPT = $oldPrompt
}
