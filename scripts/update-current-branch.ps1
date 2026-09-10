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

function Test-CommandShim([string]$PathValue) {
    if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) { return $false }
    $file = Get-Item -LiteralPath $PathValue
    if ($file.Length -le 0 -or $file.Length -ge 64KB) { return $false }
    try {
        $text = [System.IO.File]::ReadAllText($PathValue)
        return -not $text.Contains([char]0) -and $text -match 'node|npm'
    } catch {
        return $false
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
        Write-Host 'WARN: GitHub became unavailable after the source was already synchronized. The freshly rebuilt pinned runtime remains valid.' -ForegroundColor Yellow
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
    Write-Host '[UPDATE] Restarting with the newly downloaded updater at the already-synchronized commit...' -ForegroundColor Yellow
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
            $_.CommandLine -and
            $_.CommandLine -match $escapedRoot
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

    Write-Host "[REPAIR] $Label toolchain missing. Trying npm ci with conservative arguments..." -ForegroundColor Yellow
    & npm.cmd @CiArguments
    if ($LASTEXITCODE -eq 0 -and (Test-CommandShim $RequiredShim)) {
        Write-Host "[OK] $Label dependencies restored with npm ci." -ForegroundColor Green
        return
    }

    Write-Host "WARN: npm ci could not restore $Label dependencies on this field PC." -ForegroundColor Yellow
    Write-Host 'Falling back to npm install. The tracked lock file will be restored afterwards.' -ForegroundColor Yellow
    & npm.cmd @InstallArguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Label dependency repair failed with npm ci and npm install."
    }
    if (-not (Test-CommandShim $RequiredShim)) {
        throw "$Label dependency repair completed but required build tool is still missing: $RequiredShim"
    }
    & git checkout -f -- $LockPath
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to restore tracked lock file after dependency repair: $LockPath"
    }
    Write-Host "[OK] $Label dependencies repaired with npm install fallback." -ForegroundColor Green
}

function Ensure-Dependencies {
    Write-Host "Node: $(& node.exe --version)"
    Write-Host "npm: $(& npm.cmd --version)"

    Restore-DependencySet `
        'Root/web' `
        (Join-Path $repoRoot 'node_modules\.bin\vite.cmd') `
        @('ci') `
        @('install') `
        'package-lock.json'

    Restore-DependencySet `
        'Server' `
        (Join-Path $repoRoot 'server\node_modules\.bin\tsc.cmd') `
        @('ci', '--prefix', 'server') `
        @('install', '--prefix', 'server') `
        'server/package-lock.json'
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
    if ($file.Length -le 0) { throw "Generated runtime artifact is empty: $RelativePath" }
    if ($file.LastWriteTimeUtc -lt $BuildStartedAt.ToUniversalTime().AddSeconds(-2)) {
        throw "Runtime artifact was not freshly rebuilt: $RelativePath"
    }
}

function Get-SoftwareChanges([string]$BaseCommit, [string]$HeadCommit) {
    $names = @(& git diff --name-only $BaseCommit $HeadCommit --)
    if ($LASTEXITCODE -ne 0) { throw "Unable to compare $BaseCommit with $HeadCommit." }
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
        nodeVersion = (& node.exe --version)
        npmVersion = (& npm.cmd --version)
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

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'Git is not installed or is not available in PATH.' }
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { Fail 'Node.js is not installed or node.exe is not available in PATH.' }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { Fail 'npm is not installed or npm.cmd is not available in PATH.' }
if (-not (Get-Command powershell.exe -ErrorAction SilentlyContinue)) { Fail 'Windows PowerShell is not available in PATH.' }

try {
    $insideRepo = (& git rev-parse --is-inside-work-tree 2>$null).Trim()
} catch {
    Fail 'This script must be run from a Git working tree.'
}
if ($insideRepo -ne 'true') { Fail 'This script must be run from a Git working tree.' }

& git remote set-url origin $publicRemote
if ($LASTEXITCODE -ne 0) { Fail 'Unable to configure the public GitHub remote.' }

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

    # An old updater sets FLAME_UPDATER_REEXEC before starting the newly fetched script.
    # At that point checkout already succeeded, so the new script must not require another
    # GitHub round trip before it can rebuild the exact source that is already on disk.
    $resumeFromSynchronizedCommit = ($env:FLAME_UPDATER_REEXEC -eq '1')
    $pinnedCommit = $null
    if ($resumeFromSynchronizedCommit) {
        $pinnedCommit = $env:FLAME_UPDATER_PINNED_COMMIT
        if (-not $pinnedCommit) { $pinnedCommit = (& git rev-parse HEAD).Trim() }
        $currentFull = (& git rev-parse HEAD).Trim()
        if ($currentFull -ne $pinnedCommit) {
            throw 'Updater resume commit does not match current HEAD; refusing to build an ambiguous runtime.'
        }
        Write-Host "[UPDATE] Resuming at already-synchronized commit $((& git rev-parse --short HEAD).Trim())." -ForegroundColor Green
        Write-Host '[UPDATE] GitHub refresh is skipped for this rebuild pass; a transient network outage cannot block an already-fetched source commit.' -ForegroundColor Green
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
            $remoteShort = (& git rev-parse --short HEAD).Trim()
            Write-Host "Using already-synchronized commit: $remoteShort" -ForegroundColor Green
        } else {
            Fetch-TargetBranch | Out-Null
            $remoteCommit = (& git rev-parse $remoteRef).Trim()
            $remoteShort = (& git rev-parse --short $remoteRef).Trim()
            Write-Host "Remote commit: $remoteShort"

            Write-Host "Force switching working tree to $targetBranch..."
            & git checkout -f -B $targetBranch $remoteRef
            if ($LASTEXITCODE -ne 0) { throw "Unable to force switch to $targetBranch." }
            & git branch --set-upstream-to="origin/$targetBranch" $targetBranch *> $null

            Restart-WithUpdatedUpdaterIfNeeded $remoteCommit
        }

        Write-Host 'Removing non-ignored untracked files and directories...'
        & git clean -fd
        if ($LASTEXITCODE -ne 0) { throw 'git clean -fd failed.' }

        $softwareCommit = (& git rev-parse HEAD).Trim()
        if ($softwareCommit -ne $remoteCommit) {
            throw 'Verification failed: local source commit does not match the pinned/fetched source commit.'
        }
        Write-Host "Source synchronized: $((& git rev-parse --short HEAD).Trim())" -ForegroundColor Green

        Invoke-Checked 'Validate Electron main process syntax' 'node.exe' @('--check', 'desktop\main.cjs')
        Ensure-Dependencies

        # dist and server/dist are Git-ignored. Delete them explicitly before every build;
        # an unsuccessful build can therefore never leave an old runtime masquerading as updated.
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

        # A network check after a successful pinned build is intentionally best-effort.
        # If GitHub is down now, the just-built runtime is still objectively the fresh runtime
        # for softwareCommit. The next normal updater invocation will discover later source changes.
        $postBuildFetchSucceeded = Fetch-TargetBranch -BestEffort
        if ($postBuildFetchSucceeded) {
            $latestRemoteCommit = (& git rev-parse $remoteRef).Trim()
            if ($latestRemoteCommit -ne $softwareCommit) {
                $softwareChanges = @(Get-SoftwareChanges $softwareCommit $latestRemoteCommit)
                if ($softwareChanges.Count -gt 0) {
                    Write-Host 'WARN: Remote software changed while this update was building:' -ForegroundColor Yellow
                    $softwareChanges | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
                    if ($pass -lt 2) {
                        Write-Host 'Repeating synchronization and build against the newer software commit...' -ForegroundColor Yellow
                        $resumeFromSynchronizedCommit = $false
                        continue
                    }
                    throw 'Remote software changed again during the second build pass. Run the updater again.'
                }

                Write-Host 'Remote advanced only by diagnostic/log commits; runtime rebuild remains valid.'
                & git checkout -f -B $targetBranch $remoteRef
                if ($LASTEXITCODE -ne 0) { throw 'Unable to fast-forward local branch to the latest log-only remote commit.' }
                & git branch --set-upstream-to="origin/$targetBranch" $targetBranch *> $null
            }
        }

        $repositoryCommit = (& git rev-parse HEAD).Trim()
        Write-RuntimeBuildMarker $softwareCommit $repositoryCommit
        $buildSucceeded = $true
        break
    }

    if (-not $buildSucceeded) { throw 'Runtime build did not complete.' }

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
    Write-Host 'The next launch will use the freshly rebuilt runtime.' -ForegroundColor Green

    Remove-Item Env:FLAME_UPDATER_PINNED_COMMIT -ErrorAction SilentlyContinue
    Remove-Item Env:FLAME_UPDATER_REEXEC -ErrorAction SilentlyContinue

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
