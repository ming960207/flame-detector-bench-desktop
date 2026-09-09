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

# Configure a fixed repository-local identity for automated bench log commits.
# This writes only to this repository's .git/config and never changes global Git settings.
$deviceGitName = 'Flame Detector Bench'
$deviceGitEmail = 'flame-detector-bench@local.invalid'

& git config --local user.name $deviceGitName
if ($LASTEXITCODE -ne 0) {
    Fail 'Failed to configure repository-local Git user.name.'
}

& git config --local user.email $deviceGitEmail
if ($LASTEXITCODE -ne 0) {
    Fail 'Failed to configure repository-local Git user.email.'
}

Write-Host "Git identity: $deviceGitName <$deviceGitEmail>"
Write-Host 'Git identity scope: repository only'

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$archiveRelative = "diagnostic-logs/$stamp"
$archivePath = Join-Path $repoRoot $archiveRelative
New-Item -ItemType Directory -Force -Path $archivePath | Out-Null

$cutoff = (Get-Date).AddHours(-24)
$excludedParts = @(
    '\.git\',
    '\node_modules\',
    '\diagnostic-logs\',
    '\dist\',
    '\release\',
    '\release-latest\',
    '\release-backup-'
)

$files = Get-ChildItem -Path $repoRoot -Recurse -File -Filter '*.log' -ErrorAction SilentlyContinue | Where-Object {
    $path = $_.FullName
    $excluded = $false
    foreach ($part in $excludedParts) {
        if ($path -like "*$part*") {
            $excluded = $true
            break
        }
    }
    if ($excluded) {
        return $false
    }

    $alwaysInclude = $_.Name -eq 'latest.log' -or $_.Name -eq 'detector-lifecycle.log'
    $recentDiagnostic = $_.LastWriteTime -ge $cutoff

    return $alwaysInclude -or $recentDiagnostic
} | Sort-Object FullName -Unique

if (-not $files -or $files.Count -eq 0) {
    Remove-Item -Recurse -Force $archivePath
    Fail 'No current log files were found.'
}

$copied = 0
foreach ($file in $files) {
    $relative = $file.FullName.Substring($repoRoot.Length).TrimStart([char[]]@('\', '/'))
    $target = Join-Path $archivePath $relative
    $targetDir = Split-Path -Parent $target
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

    try {
        Copy-Item -LiteralPath $file.FullName -Destination $target -Force
        Write-Host "ADD: $relative"
        $copied++
    } catch {
        Write-Host "WARN: Failed to copy $relative"
    }
}

if ($copied -eq 0) {
    Remove-Item -Recurse -Force $archivePath
    Fail 'Log files were found, but none could be copied.'
}

$head = (& git rev-parse --short HEAD).Trim()
$manifest = @(
    'Flame detector bench diagnostic log package',
    "Captured: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
    "Branch: $branch",
    "Source commit: $head",
    "Git author: $deviceGitName <$deviceGitEmail>",
    "File count: $copied"
)
Set-Content -LiteralPath (Join-Path $archivePath 'manifest.txt') -Value $manifest -Encoding ASCII

Write-Host ''
Write-Host "Archive: $archiveRelative"
Write-Host "Files: $copied"
Write-Host "Branch: $branch"
Write-Host "Remote: $origin"
Write-Host ''

& git add -f -- $archiveRelative
if ($LASTEXITCODE -ne 0) {
    Fail 'git add failed.'
}

$commitMessage = "logs: upload diagnostic logs $stamp"
& git commit --only -m $commitMessage -- $archiveRelative
if ($LASTEXITCODE -ne 0) {
    Fail 'git commit failed.'
}

& git push origin $branch
if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host 'The local log commit was created, but git push failed.'
    Write-Host 'Resolve the remote branch state and run: git push origin ' -NoNewline
    Write-Host $branch
    exit 1
}

$newHead = (& git rev-parse --short HEAD).Trim()
Write-Host ''
Write-Host 'SUCCESS: Diagnostic logs were uploaded to GitHub.'
Write-Host "Commit: $newHead"
Write-Host "Path: $archiveRelative"
exit 0
