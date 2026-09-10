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
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

$targetBranch = 'refactor/unified-backend'
$publicRemote = 'https://github.com/ming960207/flame-detector-bench-desktop.git'
$remoteRef = "refs/remotes/origin/$targetBranch"
$fetchRefspec = "+refs/heads/${targetBranch}:${remoteRef}"
$runtimeMarker = Join-Path $repoRoot 'logs\runtime-build.json'
$initialUpdaterHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $PSCommandPath).Hash

function Fetch-TargetBranch {
    $fetchSucceeded = $false
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        Write-Host "Fetching target branch (attempt $attempt/3)..."
        & git -c credential.helper= -c http.version=HTTP/1.1 fetch --no-tags origin $fetchRefspec
        if ($LASTEXITCODE -eq 0) {
            $fetchSucceeded = $true
            break
        }
        if ($attempt -lt 3) {
            $delay = $attempt * 3
            Write-Host "WARN: Fetch failed. Retrying in $delay seconds..." -ForegroundColor Yellow
            Start-Sleep -Seconds $delay
        }
    }
    if (-not $fetchSucceeded) {
        throw 'git fetch failed after 3 attempts. Retry after checking network stability.'
    }
    & git rev-parse --verify $remoteRef *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "Remote branch $remoteRef was not created after fetch."
    }
}

function Restart-WithUpdatedUpdaterIfNeeded {
    if ($env:FLAME_UPDATER_REEXEC -eq '1') {
        return
    }
    $diskHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $PSCommandPath).Hash
    if ($diskHash -eq $initialUpdaterHash) {
        return
    }

    Write-Host ''
    Write-Host '[UPDATE] The updater itself changed during git synchronization.' -ForegroundColor Yellow
    Write-Host '[UPDATE] Restarting with the newly downloaded updater before building runtime...' -ForegroundColor Yellow

    $env:FLAME_UPDATER_REEXEC = '1'
    $childArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
    if ($StartAfterUpdate) {
        $childArgs += '-StartAfterUpdate'
    }
    & powershell.exe @childArgs
    $childExitCode = $LASTEXITCODE
    exit $childExitCode
}

function Stop-ProjectRuntimeProcesses {
    Write-Host '[CHECK] Stopping running project Electron/Node processes before replacing runtime files...' -ForegroundColor Cyan
    try {
        $escapedRoot = [Regex]::Escape($repoRoot)
        $targets = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
            $_.ProcessId -ne $PID -and
            ($_.Name -ieq 'node.exe' -or $_.Name -ieq 'electron.exe') -and
            $_.CommandLine -and
            $_.CommandLine -match $escapedRoot
        })
        foreach ($process in $targets) {
            Write-Host "Stopping $($process.Name) PID=$($process.ProcessId)"
            Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
        }
        if ($targets.Count -gt 0) {
            Start-Sleep -Milliseconds 800
        }
    } catch {
        Write-Host "WARN: Runtime process detection failed: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host 'The build will continue, but it will fail if old runtime files are locked.' -ForegroundColor Yellow
    }
}

function Remove-RuntimeOutput([string]$RelativePath) {
    $path = Join-Path $repoRoot $RelativePath
    if (Test-Path -LiteralPath $path) {
        Write-Host "Removing stale runtime output: $RelativePath"
        Remove-Item -LiteralPath $path -Recurse -Force
    }
}

function Assert-RuntimeArtifact([string]$RelativePath, [datetime]$BuildStartedAt) {
    $path = Join-Path $repoRoot $RelativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required runtime artifact was not generated: $RelativePath"
    }
    $file = Get-Item -LiteralPath $path
    if ($file.Length -le 0) {
        throw "Generated runtime artifact is empty: $RelativePath"
    }
    if ($file.LastWriteTimeUtc -lt $BuildStartedAt.ToUniversalTime().AddSeconds(-2)) {
        throw "Runtime artifact was not freshly rebuilt: $RelativePath"
    }
}

function Get-SoftwareChanges([string]$BaseCommit, [string]$HeadCommit) {
    $names = @(& git diff --name-only $BaseCommit $HeadCommit --)
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to compare $BaseCommit with $HeadCommit."
    }
    return @($names | Where-Object {
        $name = ($_ -replace '\\', '/')
        $name -and
        -not $name.StartsWith('diagnostic-logs/') -and
        -not $name.StartsWith('logs/')
    })
}

function Write-RuntimeBuildMarker([string]$SoftwareCommit, [string]$RepositoryCommit) {
    $serverMain = Join-Path $repoRoot 'server\dist\main.js'
    $webIndex = Join-Path $repoRoot 'dist\index.html'
    $builtAtShanghai = [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8)).ToString('yyyy-MM-dd HH:mm:ss zzz')
    $marker = [ordered]@{
        branch = $targetBranch
        softwareCommit = $SoftwareCommit
        repositoryCommit = $RepositoryCommit
        builtAtShanghai = $builtAtShanghai
        timezone = 'Asia/Shanghai (UTC+8)'
        serverMainSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $serverMain).Hash
        webIndexSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $webIndex).Hash
    }
    $json = $marker | ConvertTo-Json -Depth 4
    $utf8 = New-Object System.Text.UTF8Encoding($false)

    $logsDir = Join-Path $repoRoot 'logs'
    New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
    [System.IO.File]::WriteAllText($runtimeMarker, $json, $utf8)
    [System.IO.File]::WriteAllText((Join-Path $repoRoot 'server\dist\runtime-build.json'), $json, $utf8)
    [System.IO.File]::WriteAllText((Join-Path $repoRoot 'dist\runtime-build.json'), $json, $utf8)
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail 'Git is not installed or is not available in PATH.'
}
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    Fail 'Node.js is not installed or node.exe is not available in PATH.'
}
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    Fail 'npm is not installed or npm.cmd is not available in PATH.'
}
if (-not (Get-Command powershell.exe -ErrorAction SilentlyContinue)) {
    Fail 'Windows PowerShell is not available in PATH.'
}

try {
    $insideRepo = (& git rev-parse --is-inside-work-tree 2>$null).Trim()
} catch {
    Fail 'This script must be run from a Git working tree.'
}
if ($insideRepo -ne 'true') {
    Fail 'This script must be run from a Git working tree.'
}

& git remote set-url origin $publicRemote
if ($LASTEXITCODE -ne 0) {
    Fail 'Unable to configure the public GitHub remote.'
}

$oldPrompt = $env:GIT_TERMINAL_PROMPT
$env:GIT_TERMINAL_PROMPT = '0'
try {
    $before = (& git rev-parse --short HEAD 2>$null).Trim()
    Write-Host "Repository: $repoRoot"
    Write-Host "Target branch: $targetBranch"
    Write-Host "Remote: $publicRemote"
    Write-Host 'Authentication: anonymous read-only HTTPS'
    Write-Host "Current commit: $before"
    Write-Host ''
    Write-Host 'WARNING: Local source changes and local-only commits will be discarded.' -ForegroundColor Yellow
    Write-Host 'Ignored runtime data such as logs are preserved.'
    Write-Host 'The running project process will be stopped before rebuilding.'
    Write-Host ''

    Write-Host 'Checking GitHub repository access...'
    & git -c credential.helper= -c http.version=HTTP/1.1 ls-remote --exit-code $publicRemote "refs/heads/$targetBranch" *> $null
    if ($LASTEXITCODE -ne 0) {
        Fail 'GitHub repository is not reachable or the target branch does not exist.'
    }
    Write-Host 'GitHub access: OK' -ForegroundColor Green

    Stop-ProjectRuntimeProcesses

    $softwareCommit = $null
    $repositoryCommit = $null
    $buildSucceeded = $false

    for ($pass = 1; $pass -le 2; $pass++) {
        Write-Host "`n========== UPDATE PASS $pass/2 ==========" -ForegroundColor Cyan
        Fetch-TargetBranch

        $remoteCommit = (& git rev-parse $remoteRef).Trim()
        $remoteShort = (& git rev-parse --short $remoteRef).Trim()
        Write-Host "Remote commit: $remoteShort"

        Write-Host "Force switching working tree to $targetBranch..."
        & git checkout -f -B $targetBranch $remoteRef
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to force switch to $targetBranch."
        }
        & git branch --set-upstream-to="origin/$targetBranch" $targetBranch *> $null

        # Future updater revisions are allowed to replace this file. If that happens,
        # restart immediately so the rest of the update uses the new updater logic
        # instead of continuing with the old script already loaded in memory.
        Restart-WithUpdatedUpdaterIfNeeded

        Write-Host 'Removing non-ignored untracked files and directories...'
        & git clean -fd
        if ($LASTEXITCODE -ne 0) {
            throw 'git clean -fd failed.'
        }

        $softwareCommit = (& git rev-parse HEAD).Trim()
        if ($softwareCommit -ne $remoteCommit) {
            throw "Verification failed: local source commit does not match fetched remote commit."
        }

        Write-Host "Source synchronized: $((& git rev-parse --short HEAD).Trim())" -ForegroundColor Green

        Invoke-Checked 'Validate Electron main process syntax' 'node.exe' @('--check', 'desktop\main.cjs')

        # npm ci is intentional here. The old updater only replaced Git-tracked source,
        # so node_modules could also remain stale when package-lock.json changed.
        # prefer-offline keeps field updates fast when the npm cache is already warm,
        # while npm ci guarantees the installed dependency tree matches the lock files.
        Invoke-Checked 'Restore exact root dependencies' 'npm.cmd' @('ci', '--prefer-offline', '--no-audit', '--no-fund')
        Invoke-Checked 'Restore exact server dependencies' 'npm.cmd' @('ci', '--prefix', 'server', '--prefer-offline', '--no-audit', '--no-fund')

        # dist and server/dist are Git-ignored. Explicitly delete them before building
        # so a failed or partial build can never leave the previous executable runtime
        # looking like a successful software update.
        Remove-RuntimeOutput 'dist'
        Remove-RuntimeOutput 'server\dist'

        $buildStartedAt = Get-Date
        Invoke-Checked 'Build unified backend runtime' 'npm.cmd' @('run', 'build:server')
        Invoke-Checked 'Build desktop frontend runtime' 'npm.cmd' @('run', 'build:web')

        Assert-RuntimeArtifact 'server\dist\main.js' $buildStartedAt
        Assert-RuntimeArtifact 'dist\index.html' $buildStartedAt
        if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'dist\assets') -PathType Container)) {
            throw 'Desktop frontend assets directory was not generated: dist\assets'
        }

        Write-Host '[OK] Runtime artifacts were freshly rebuilt.' -ForegroundColor Green

        # A field test can auto-upload logs to this same branch. Re-fetch after the
        # build and only rebuild again when real software files changed. Log-only
        # commits do not invalidate the runtime we just compiled.
        Fetch-TargetBranch
        $latestRemoteCommit = (& git rev-parse $remoteRef).Trim()
        if ($latestRemoteCommit -ne $softwareCommit) {
            $softwareChanges = @(Get-SoftwareChanges $softwareCommit $latestRemoteCommit)
            if ($softwareChanges.Count -gt 0) {
                Write-Host 'WARN: Remote software changed while this update was building:' -ForegroundColor Yellow
                $softwareChanges | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
                if ($pass -lt 2) {
                    Write-Host 'Repeating synchronization and build against the newer software commit...' -ForegroundColor Yellow
                    continue
                }
                throw 'Remote software changed again during the second build pass. Run the updater again.'
            }

            Write-Host 'Remote advanced only by diagnostic/log commits; runtime rebuild remains valid.'
            & git checkout -f -B $targetBranch $remoteRef
            if ($LASTEXITCODE -ne 0) {
                throw 'Unable to fast-forward local branch to the latest log-only remote commit.'
            }
            & git branch --set-upstream-to="origin/$targetBranch" $targetBranch *> $null
        }

        $repositoryCommit = (& git rev-parse HEAD).Trim()
        Write-RuntimeBuildMarker $softwareCommit $repositoryCommit
        $buildSucceeded = $true
        break
    }

    if (-not $buildSucceeded) {
        throw 'Runtime build did not complete.'
    }

    $serverArtifact = Get-Item -LiteralPath (Join-Path $repoRoot 'server\dist\main.js')
    $webArtifact = Get-Item -LiteralPath (Join-Path $repoRoot 'dist\index.html')
    $currentBranch = (& git rev-parse --abbrev-ref HEAD).Trim()
    $currentShort = (& git rev-parse --short HEAD).Trim()
    $softwareShort = (& git rev-parse --short $softwareCommit).Trim()

    Write-Host ''
    Write-Host 'SUCCESS: SOURCE + BACKEND + FRONTEND ARE UPDATED.' -ForegroundColor Green
    Write-Host "Branch: $currentBranch"
    Write-Host "Previous repository commit: $before"
    Write-Host "Current repository commit: $currentShort"
    Write-Host "Software build commit: $softwareShort"
    Write-Host "Server runtime: $($serverArtifact.FullName)"
    Write-Host "Web runtime: $($webArtifact.FullName)"
    Write-Host "Build marker: $runtimeMarker"
    Write-Host ''
    Write-Host 'The next launch will use the freshly rebuilt runtime. Do not use an already-running old process.' -ForegroundColor Green

    if ($StartAfterUpdate) {
        Write-Host 'Starting desktop application...' -ForegroundColor Cyan
        Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'desktop') -WorkingDirectory $repoRoot
    }

    exit 0
} catch {
    Write-Host ''
    Write-Host "UPDATE FAILED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Old runtime must NOT be treated as updated. Fix the reported error and run the updater again.' -ForegroundColor Red
    exit 1
} finally {
    $env:GIT_TERMINAL_PROMPT = $oldPrompt
}
