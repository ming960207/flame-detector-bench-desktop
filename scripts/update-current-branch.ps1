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

if ($insideRepo -ne 'true') {
    Fail 'This script must be run from a Git working tree.'
}

$branch = (& git rev-parse --abbrev-ref HEAD).Trim()
if (-not $branch -or $branch -eq 'HEAD') {
    Fail 'Detached HEAD is not supported. Check out a branch first.'
}

try {
    $origin = (& git remote get-url origin).Trim()
} catch {
    Fail 'Git remote origin is not configured.'
}

if (-not $origin) {
    Fail 'Git remote origin is not configured.'
}

$status = & git status --porcelain --untracked-files=all
if ($LASTEXITCODE -ne 0) {
    Fail 'Unable to inspect the working tree.'
}

if ($status) {
    Write-Host 'ERROR: The working tree is not clean.'
    Write-Host 'Commit, upload, move, or discard local changes before updating.'
    Write-Host ''
    & git status --short
    exit 1
}

$before = (& git rev-parse --short HEAD).Trim()

Write-Host "Repository: $repoRoot"
Write-Host "Branch: $branch"
Write-Host "Remote: $origin"
Write-Host "Current commit: $before"
Write-Host ''
Write-Host 'Fetching remote updates...'

& git fetch --prune origin
if ($LASTEXITCODE -ne 0) {
    Fail 'git fetch failed.'
}

$remoteRef = "origin/$branch"
& git rev-parse --verify $remoteRef *> $null
if ($LASTEXITCODE -ne 0) {
    Fail "Remote branch $remoteRef does not exist."
}

$aheadBehind = (& git rev-list --left-right --count "$branch...$remoteRef").Trim()
if (-not $aheadBehind) {
    Fail 'Unable to compare local and remote branches.'
}

$parts = $aheadBehind -split '\s+'
if ($parts.Count -lt 2) {
    Fail 'Unexpected branch comparison result.'
}

$localAhead = [int]$parts[0]
$remoteAhead = [int]$parts[1]

Write-Host "Local-only commits: $localAhead"
Write-Host "Remote-only commits: $remoteAhead"
Write-Host ''

if ($localAhead -gt 0 -and $remoteAhead -gt 0) {
    Fail 'Local and remote branches have diverged. Manual reconciliation is required.'
}

if ($localAhead -gt 0 -and $remoteAhead -eq 0) {
    Write-Host 'No remote update is required. The local branch contains commits not yet on origin.'
    Write-Host 'Run the log upload script or push your commits if needed.'
    exit 0
}

if ($remoteAhead -eq 0) {
    Write-Host 'SUCCESS: The current branch is already up to date.'
    exit 0
}

Write-Host 'Applying remote updates with fast-forward only...'
& git pull --ff-only origin $branch
if ($LASTEXITCODE -ne 0) {
    Fail 'git pull --ff-only failed.'
}

$after = (& git rev-parse --short HEAD).Trim()
Write-Host ''
Write-Host 'SUCCESS: The current branch was updated from GitHub.'
Write-Host "Previous commit: $before"
Write-Host "Current commit: $after"
exit 0
