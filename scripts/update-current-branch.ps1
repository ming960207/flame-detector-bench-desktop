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

$publicRemote = 'https://github.com/ming960207/flame-detector-bench-desktop.git'
& git remote set-url origin $publicRemote
if ($LASTEXITCODE -ne 0) {
    Fail 'Unable to configure the public GitHub remote.'
}

$env:GIT_TERMINAL_PROMPT = '0'
$before = (& git rev-parse --short HEAD).Trim()

Write-Host "Repository: $repoRoot"
Write-Host "Branch: $branch"
Write-Host "Remote: $publicRemote"
Write-Host 'Authentication: anonymous read-only HTTPS'
Write-Host "Current commit: $before"
Write-Host ''
Write-Host 'WARNING: This update mode discards all local repository changes.'
Write-Host 'Tracked changes, staged changes, local commits, and untracked files will be removed.'
Write-Host ''
Write-Host 'Fetching remote updates anonymously...'

& git -c credential.helper= fetch --prune origin
if ($LASTEXITCODE -ne 0) {
    Fail 'git fetch failed. Verify network access to GitHub.'
}

$remoteRef = "origin/$branch"
& git rev-parse --verify $remoteRef *> $null
if ($LASTEXITCODE -ne 0) {
    Fail "Remote branch $remoteRef does not exist."
}

$remoteCommit = (& git rev-parse --short $remoteRef).Trim()
Write-Host "Remote commit: $remoteCommit"
Write-Host ''
Write-Host 'Resetting current branch to the remote branch...'

& git reset --hard $remoteRef
if ($LASTEXITCODE -ne 0) {
    Fail 'git reset --hard failed.'
}

Write-Host 'Removing untracked files and directories...'
& git clean -fd
if ($LASTEXITCODE -ne 0) {
    Fail 'git clean -fd failed.'
}

$after = (& git rev-parse --short HEAD).Trim()
$remaining = & git status --porcelain --untracked-files=all
if ($LASTEXITCODE -ne 0) {
    Fail 'Unable to verify the working tree after update.'
}

if ($remaining) {
    Write-Host 'WARNING: The repository still contains ignored or external runtime files.'
    Write-Host 'Tracked and untracked repository content was synchronized successfully.'
}

Write-Host ''
Write-Host 'SUCCESS: The current branch now matches GitHub tracked content.'
Write-Host "Previous commit: $before"
Write-Host "Current commit: $after"
Write-Host "Remote commit: $remoteCommit"
exit 0
