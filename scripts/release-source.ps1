function Get-ReleaseSourceConfig {
    param([string]$RepoRoot)

    $default = [pscustomobject]@{
        source = 'git'
        branch = 'refactor/unified-backend'
        git = [pscustomobject]@{
            label = 'GitHub'
            repository = 'https://github.com/ming960207/flame-detector-bench-desktop'
            remoteUrl = 'https://github.com/ming960207/flame-detector-bench-desktop.git'
        }
        gitee = [pscustomobject]@{
            label = 'Gitee'
            repository = 'https://gitee.com/mingchangpeng/flame-detector-bench-desktop'
            remoteUrl = 'https://gitee.com/mingchangpeng/flame-detector-bench-desktop.git'
        }
    }

    $configPath = Join-Path $RepoRoot 'config\release-source.json'
    $raw = $default
    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        try {
            $candidate = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
            if ($candidate) { $raw = $candidate }
        } catch {
            Write-Host "WARN: release source config could not be read; using GitHub defaults. $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }

    $source = if ([string]$raw.source -eq 'gitee') { 'gitee' } else { 'git' }
    $channel = $raw.$source
    if (-not $channel) { $channel = $default.$source }
    $repository = ([string]$channel.repository).Trim().TrimEnd('/') -replace '\.git$', ''
    if ([string]::IsNullOrWhiteSpace($repository)) { $repository = [string]$default.$source.repository }
    $remoteUrl = ([string]$channel.remoteUrl).Trim()
    if ([string]::IsNullOrWhiteSpace($remoteUrl)) { $remoteUrl = "$repository.git" }
    $branch = ([string]$raw.branch).Trim()
    if ([string]::IsNullOrWhiteSpace($branch)) { $branch = 'refactor/unified-backend' }

    $owner = ''
    $repo = ''
    try {
        $uri = [Uri]$repository
        $parts = @($uri.AbsolutePath.Trim('/').Split('/') | Where-Object { $_ })
        if ($parts.Count -ge 2) {
            $owner = [string]$parts[0]
            $repo = [string]($parts[1..($parts.Count - 1)] -join '/')
        }
    } catch { }

    $tokenNames = if ($source -eq 'gitee') { @('GITEE_ACCESS_TOKEN', 'FLAME_BENCH_GITEE_TOKEN') } else { @('FLAME_BENCH_GITHUB_TOKEN') }
    [pscustomobject]@{
        Source = $source
        Label = if ([string]::IsNullOrWhiteSpace([string]$channel.label)) { if ($source -eq 'gitee') { 'Gitee' } else { 'GitHub' } } else { [string]$channel.label }
        Branch = $branch
        Repository = $repository
        RemoteUrl = $remoteUrl
        RemoteName = if ($source -eq 'gitee') { 'gitee' } else { 'origin' }
        Owner = $owner
        Repo = $repo
        TokenEnvironmentNames = @($tokenNames)
        UsernameEnvironmentName = if ($source -eq 'gitee') { 'FLAME_BENCH_GITEE_USERNAME' } else { 'FLAME_BENCH_GITHUB_USERNAME' }
    }
}

function Ensure-ReleaseRemote {
    param([object]$Config)

    $currentRaw = & git remote get-url $Config.RemoteName 2>$null
    $current = if ($null -eq $currentRaw) { '' } else { ([string]$currentRaw).Trim() }
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($current)) {
        & git remote add $Config.RemoteName $Config.RemoteUrl *> $null
    } elseif ($current -ne $Config.RemoteUrl) {
        & git remote set-url $Config.RemoteName $Config.RemoteUrl *> $null
    }
    if ($LASTEXITCODE -ne 0) { throw "Unable to configure release remote '$($Config.RemoteName)' at '$($Config.RemoteUrl)'" }
}

function Get-ReleaseToken {
    param([object]$Config)

    foreach ($name in @($Config.TokenEnvironmentNames)) {
        $machine = [Environment]::GetEnvironmentVariable($name, 'Machine')
        if (-not [string]::IsNullOrWhiteSpace($machine)) { return [pscustomobject]@{ Value = $machine.Trim(); Source = 'machine environment'; Name = $name } }
        $user = [Environment]::GetEnvironmentVariable($name, 'User')
        if (-not [string]::IsNullOrWhiteSpace($user)) { return [pscustomobject]@{ Value = $user.Trim(); Source = 'user environment'; Name = $name } }
        $process = [Environment]::GetEnvironmentVariable($name, 'Process')
        if (-not [string]::IsNullOrWhiteSpace($process)) { return [pscustomobject]@{ Value = $process.Trim(); Source = 'current process environment'; Name = $name } }
    }
    return [pscustomobject]@{ Value = ''; Source = ''; Name = [string]$Config.TokenEnvironmentNames[0] }
}

function Save-ReleaseToken {
    param([object]$Config, [string]$Token)
    $name = [string]$Config.TokenEnvironmentNames[0]
    [Environment]::SetEnvironmentVariable($name, $Token.Trim(), 'User')
    Set-Item -Path "Env:$name" -Value $Token.Trim()
}

function New-ReleaseGitAuthentication {
    param([object]$Config, [string]$Token)
    if ([string]::IsNullOrWhiteSpace($Token)) { return $null }

    $askPass = Join-Path $env:TEMP "flame-bench-release-askpass-$PID.cmd"
    $username = [Environment]::GetEnvironmentVariable($Config.UsernameEnvironmentName, 'Process')
    if ([string]::IsNullOrWhiteSpace($username)) { $username = [string]$Config.Owner }
    if ([string]::IsNullOrWhiteSpace($username)) { $username = if ($Config.Source -eq 'gitee') { 'oauth2' } else { 'x-access-token' } }
    $content = @(
        '@echo off',
        'set "PROMPT=%~1"',
        'echo %PROMPT% | findstr /I "username" >nul',
        'if not errorlevel 1 (',
        "  echo $username",
        '  exit /b 0',
        ')',
        'echo %FLAME_BENCH_RELEASE_ASKPASS_VALUE%'
    )
    [System.IO.File]::WriteAllText($askPass, ($content -join [Environment]::NewLine), [System.Text.Encoding]::ASCII)

    $state = [pscustomobject]@{
        AskPass = $askPass
        OldAskPass = $env:GIT_ASKPASS
        OldPrompt = $env:GIT_TERMINAL_PROMPT
        OldAskPassValue = $env:FLAME_BENCH_RELEASE_ASKPASS_VALUE
    }
    $env:GIT_ASKPASS = $askPass
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:FLAME_BENCH_RELEASE_ASKPASS_VALUE = $Token.Trim()
    return $state
}

function Remove-ReleaseGitAuthentication {
    param([object]$State)
    if ($null -eq $State) { return }
    if ([string]::IsNullOrWhiteSpace([string]$State.OldAskPass)) { Remove-Item Env:GIT_ASKPASS -ErrorAction SilentlyContinue } else { $env:GIT_ASKPASS = $State.OldAskPass }
    if ([string]::IsNullOrWhiteSpace([string]$State.OldPrompt)) { Remove-Item Env:GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue } else { $env:GIT_TERMINAL_PROMPT = $State.OldPrompt }
    if ([string]::IsNullOrWhiteSpace([string]$State.OldAskPassValue)) { Remove-Item Env:FLAME_BENCH_RELEASE_ASKPASS_VALUE -ErrorAction SilentlyContinue } else { $env:FLAME_BENCH_RELEASE_ASKPASS_VALUE = $State.OldAskPassValue }
    Remove-Item -LiteralPath $State.AskPass -Force -ErrorAction SilentlyContinue
}

function Backup-ReleaseSourceConfig {
    param([string]$RepoRoot)
    $sourcePath = Join-Path $RepoRoot 'config\release-source.json'
    $backupPath = Join-Path $env:TEMP "flame-bench-release-source-$PID.json"
    $present = Test-Path -LiteralPath $sourcePath -PathType Leaf
    if ($present) { Copy-Item -LiteralPath $sourcePath -Destination $backupPath -Force }
    return [pscustomobject]@{ SourcePath = $sourcePath; BackupPath = $backupPath; Present = $present }
}

function Restore-ReleaseSourceConfig {
    param([object]$State)
    if ($null -eq $State -or -not $State.Present) { return }
    New-Item -ItemType Directory -Path (Split-Path -Parent $State.SourcePath) -Force | Out-Null
    Copy-Item -LiteralPath $State.BackupPath -Destination $State.SourcePath -Force
}

function Remove-ReleaseSourceConfigBackup {
    param([object]$State)
    if ($null -ne $State) { Remove-Item -LiteralPath $State.BackupPath -Force -ErrorAction SilentlyContinue }
}
