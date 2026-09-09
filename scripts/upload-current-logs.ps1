param(
    [switch]$Automatic,
    [string]$BatchId = ''
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    Write-Host "ERROR: $Message"
    exit 1
}

function Read-TokenSecurely {
    Write-Host ''
    Write-Host 'First-time upload setup'
    Write-Host 'No GitHub upload token is configured on this Windows account.'
    Write-Host 'Paste the fine-grained GitHub token for this repository and press Enter.'
    Write-Host 'The token will be saved as the current Windows user environment variable:'
    Write-Host 'FLAME_BENCH_GITHUB_TOKEN'
    Write-Host 'The token will not be written into this repository.'
    Write-Host ''
    $secure = Read-Host 'GitHub token' -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'Git is not installed or is not available in PATH.' }
try { $insideRepo = (& git rev-parse --is-inside-work-tree 2>$null).Trim() }
catch { Fail 'This script must be run from a Git working tree.' }
if ($insideRepo -ne 'true') { Fail 'This script must be run from a Git working tree.' }

$branch = (& git rev-parse --abbrev-ref HEAD).Trim()
if (-not $branch -or $branch -eq 'HEAD') { Fail 'Detached HEAD is not supported. Check out a branch first.' }

$publicRemote = 'https://github.com/ming960207/flame-detector-bench-desktop.git'
& git remote set-url origin $publicRemote
if ($LASTEXITCODE -ne 0) { Fail 'Unable to configure the GitHub remote.' }

$token = [Environment]::GetEnvironmentVariable('FLAME_BENCH_GITHUB_TOKEN', 'Machine')
$tokenSource = 'machine environment'
if (-not $token) { $token = [Environment]::GetEnvironmentVariable('FLAME_BENCH_GITHUB_TOKEN', 'User'); $tokenSource = 'user environment' }
if (-not $token) { $token = $env:FLAME_BENCH_GITHUB_TOKEN; $tokenSource = 'current process environment' }
if (-not $token) {
    if ($Automatic) {
        Fail 'Automatic log upload requires FLAME_BENCH_GITHUB_TOKEN. Run upload-current-logs.cmd once to complete the one-time token setup.'
    }
    $token = Read-TokenSecurely
    if (-not $token -or [string]::IsNullOrWhiteSpace($token)) { Fail 'No GitHub token was entered.' }
    $token = $token.Trim()
    try {
        [Environment]::SetEnvironmentVariable('FLAME_BENCH_GITHUB_TOKEN', $token, 'User')
        $env:FLAME_BENCH_GITHUB_TOKEN = $token
        $tokenSource = 'new user environment deployment'
        Write-Host ''
        Write-Host 'SUCCESS: GitHub token was saved for the current Windows user.'
        Write-Host 'Future log uploads will use it automatically.'
    } catch { Fail "Unable to save FLAME_BENCH_GITHUB_TOKEN for the current Windows user: $($_.Exception.Message)" }
}
$token = $token.Trim()

$deviceGitName = 'Flame Detector Bench'
$deviceGitEmail = 'flame-detector-bench@local.invalid'
& git config --local user.name $deviceGitName
if ($LASTEXITCODE -ne 0) { Fail 'Failed to configure repository-local Git user.name.' }
& git config --local user.email $deviceGitEmail
if ($LASTEXITCODE -ne 0) { Fail 'Failed to configure repository-local Git user.email.' }
Write-Host "Git identity: $deviceGitName <$deviceGitEmail>"
Write-Host 'Git identity scope: repository only'
Write-Host "Authentication: $tokenSource, no local Git login"

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$batchSlug = ($BatchId -replace '[^A-Za-z0-9._-]', '_').Trim('_')
if ($batchSlug.Length -gt 80) { $batchSlug = $batchSlug.Substring(0, 80) }
if ($Automatic -and $batchSlug) {
    $archiveRelative = "diagnostic-logs/$stamp-$batchSlug"
} else {
    $archiveRelative = "diagnostic-logs/$stamp"
}
$archivePath = Join-Path $repoRoot $archiveRelative
New-Item -ItemType Directory -Force -Path $archivePath | Out-Null
$cutoff = (Get-Date).AddHours(-24)
$excludedParts = @('\.git\','\node_modules\','\diagnostic-logs\','\dist\','\release\','\release-latest\','\release-backup-')
$files = Get-ChildItem -Path $repoRoot -Recurse -File -Filter '*.log' -ErrorAction SilentlyContinue | Where-Object {
    $path = $_.FullName
    $excluded = $false
    foreach ($part in $excludedParts) { if ($path -like "*$part*") { $excluded = $true; break } }
    if ($excluded) { return $false }

    if ($Automatic) {
        # Automatic uploads happen after every completed test. Keep each package
        # focused on the live server log, detector lifecycle and completed result
        # logs instead of re-uploading every historical *.log from the last 24h.
        return ($_.Name -eq 'latest.log' -or $_.Name -eq 'detector-lifecycle.log' -or $_.Name -like 'test-results*.log')
    }

    return ($_.Name -eq 'latest.log' -or $_.Name -eq 'detector-lifecycle.log' -or $_.LastWriteTime -ge $cutoff)
} | Sort-Object FullName -Unique
$files = @($files)
if (-not $files -or $files.Count -eq 0) { Remove-Item -Recurse -Force $archivePath; Fail 'No current log files were found.' }

$copied = 0
foreach ($file in $files) {
    $relative = $file.FullName.Substring($repoRoot.Length).TrimStart([char[]]@('\', '/'))
    $target = Join-Path $archivePath $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    try { Copy-Item -LiteralPath $file.FullName -Destination $target -Force; Write-Host "ADD: $relative"; $copied++ }
    catch { Write-Host "WARN: Failed to copy $relative" }
}
if ($copied -eq 0) { Remove-Item -Recurse -Force $archivePath; Fail 'Log files were found, but none could be copied.' }

$head = (& git rev-parse --short HEAD).Trim()
$modeText = if ($Automatic) { 'automatic-after-complete' } else { 'manual' }
$batchText = if ($BatchId) { $BatchId } else { '-' }
$manifest = @(
    'Flame detector bench diagnostic log package',
    "Captured: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
    "Mode: $modeText",
    "Batch: $batchText",
    "Branch: $branch",
    "Source commit: $head",
    "Git author: $deviceGitName <$deviceGitEmail>",
    "File count: $copied"
)
Set-Content -LiteralPath (Join-Path $archivePath 'manifest.txt') -Value $manifest -Encoding ASCII
Write-Host ''
Write-Host "Archive: $archiveRelative"
Write-Host "Files: $copied"
Write-Host "Batch: $batchText"
Write-Host "Branch: $branch"
Write-Host "Remote: $publicRemote"
Write-Host ''

& git -c core.autocrlf=false add -f -- $archiveRelative
if ($LASTEXITCODE -ne 0) { Fail 'git add failed.' }
$commitMessage = if ($Automatic -and $BatchId) {
    "logs: auto upload completed batch $BatchId $stamp"
} elseif ($Automatic) {
    "logs: auto upload completed test $stamp"
} else {
    "logs: upload diagnostic logs $stamp"
}
& git commit --only -m $commitMessage -- $archiveRelative
if ($LASTEXITCODE -ne 0) { Fail 'git commit failed.' }

$askPass = Join-Path $env:TEMP "flame-bench-git-askpass-$PID.cmd"
$askPassContent = @(
    '@echo off',
    'set "PROMPT=%~1"',
    'echo %PROMPT% | findstr /I "username" >nul',
    'if not errorlevel 1 (',
    '  echo x-access-token',
    '  exit /b 0',
    ')',
    'echo %FLAME_BENCH_GITHUB_ASKPASS_VALUE%'
)
Set-Content -LiteralPath $askPass -Value $askPassContent -Encoding ASCII
$oldAskPass = $env:GIT_ASKPASS
$oldPrompt = $env:GIT_TERMINAL_PROMPT
$oldAskPassValue = $env:FLAME_BENCH_GITHUB_ASKPASS_VALUE
try {
    $env:GIT_ASKPASS = $askPass
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:FLAME_BENCH_GITHUB_ASKPASS_VALUE = $token
    Write-Host 'Uploading diagnostic commit to GitHub...'
    & git -c credential.helper= -c http.version=HTTP/1.1 push origin $branch
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host 'The local log commit was created, but authenticated push failed.'
        Write-Host 'The inspection result remains valid and the next automatic upload may retry the pending local commit.'
        Write-Host 'Required token access: this repository, Contents = Read and write.'
        exit 1
    }
} finally {
    $env:GIT_ASKPASS = $oldAskPass
    $env:GIT_TERMINAL_PROMPT = $oldPrompt
    $env:FLAME_BENCH_GITHUB_ASKPASS_VALUE = $oldAskPassValue
    Remove-Item -LiteralPath $askPass -Force -ErrorAction SilentlyContinue
}
$newHead = (& git rev-parse --short HEAD).Trim()
Write-Host ''
Write-Host 'SUCCESS: Diagnostic logs were uploaded to GitHub.'
Write-Host "Commit: $newHead"
Write-Host "Path: $archiveRelative"
exit 0
