$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    Write-Host "ERROR: $Message"
    exit 1
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail 'Git is not installed or is not available in PATH.'
}

try {
    $insideRepo = (& git rev-parse --is-inside-work-tree 2>$null).Trim()
} catch {
    Fail 'This script must be run from a Git working tree.'
}
if ($insideRepo -ne 'true') { Fail 'This script must be run from a Git working tree.' }

$targetBranch = 'refactor/unified-backend'
$publicRemote = 'https://github.com/ming960207/flame-detector-bench-desktop.git'
$remoteRef = "refs/remotes/origin/$targetBranch"
$fetchRefspec = "+refs/heads/${targetBranch}:${remoteRef}"

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
    Write-Host 'WARNING: Local source changes and local-only commits will be discarded.'
    Write-Host 'Ignored runtime files such as logs are preserved.'
    Write-Host ''

    Write-Host 'Checking GitHub repository access...'
    & git -c credential.helper= -c http.version=HTTP/1.1 ls-remote --exit-code $publicRemote "refs/heads/$targetBranch" *> $null
    if ($LASTEXITCODE -ne 0) { Fail 'GitHub repository is not reachable or the target branch does not exist.' }
    Write-Host 'GitHub access: OK'

    $fetchSucceeded = $false
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        Write-Host "Fetching target branch (attempt $attempt/3)..."
        & git -c credential.helper= -c http.version=HTTP/1.1 fetch --no-tags origin $fetchRefspec
        if ($LASTEXITCODE -eq 0) { $fetchSucceeded = $true; break }
        if ($attempt -lt 3) {
            $delay = $attempt * 3
            Write-Host "WARN: Fetch failed. Retrying in $delay seconds..."
            Start-Sleep -Seconds $delay
        }
    }
    if (-not $fetchSucceeded) { Fail 'git fetch failed after 3 attempts. Retry after checking network stability.' }

    & git rev-parse --verify $remoteRef *> $null
    if ($LASTEXITCODE -ne 0) { Fail "Remote branch $remoteRef was not created after fetch." }
    $remoteCommit = (& git rev-parse --short $remoteRef).Trim()
    Write-Host "Remote commit: $remoteCommit"

    Write-Host 'Discarding local tracked changes...'
    & git reset --hard
    if ($LASTEXITCODE -ne 0) { Fail 'git reset --hard failed.' }
    Write-Host 'Removing non-ignored untracked files and directories...'
    & git clean -fd
    if ($LASTEXITCODE -ne 0) { Fail 'git clean -fd failed.' }

    Write-Host "Switching to $targetBranch..."
    & git checkout -B $targetBranch $remoteRef
    if ($LASTEXITCODE -ne 0) { Fail "Unable to switch to $targetBranch." }
    & git reset --hard $remoteRef
    if ($LASTEXITCODE -ne 0) { Fail 'Final git reset --hard failed.' }
    & git clean -fd
    if ($LASTEXITCODE -ne 0) { Fail 'Final git clean -fd failed.' }

    $after = (& git rev-parse --short HEAD).Trim()
    $currentBranch = (& git rev-parse --abbrev-ref HEAD).Trim()
    Write-Host ''
    Write-Host 'SUCCESS: Software update completed.'
    Write-Host "Branch: $currentBranch"
    Write-Host "Previous commit: $before"
    Write-Host "Current commit: $after"
    Write-Host "Remote commit: $remoteCommit"
    exit 0
} finally {
    $env:GIT_TERMINAL_PROMPT = $oldPrompt
}
