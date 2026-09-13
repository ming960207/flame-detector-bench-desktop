[CmdletBinding()]
param([switch]$PreflightOnly)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
$temporaryRoot = Join-Path $temporaryBase ('flame-release-' + [guid]::NewGuid().ToString('N'))
$latestRoot = Join-Path $projectRoot 'release-latest'
$latestBaseName = -join @(
    [char]0x706B, [char]0x7130, [char]0x63A2, [char]0x6D4B,
    [char]0x5668, [char]0x68C0, [char]0x6D4B, [char]0x53F0,
    '-', [char]0x6700, [char]0x65B0, [char]0x7248
)

function Invoke-Checked([string]$Label, [string]$Command, [string[]]$Arguments) {
    Write-Host "`n[BUILD] $Label" -ForegroundColor Cyan
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE" }
}

function Assert-TextFileHealthy([string]$PathValue) {
    $bytes = [System.IO.File]::ReadAllBytes($PathValue)
    $sampleLength = [Math]::Min($bytes.Length, 4096)
    for ($index = 0; $index -lt $sampleLength; $index++) {
        if ($bytes[$index] -eq 0) {
            throw "Corrupted NUL/zero-filled source file: $PathValue`nRestore it from editor history or backup before packaging."
        }
    }
}

function Test-CommandShim([string]$PathValue) {
    if (-not (Test-Path -LiteralPath $PathValue)) { return $false }
    $file = Get-Item -LiteralPath $PathValue
    if ($file.Length -le 0 -or $file.Length -ge 64KB) { return $false }
    $text = [System.IO.File]::ReadAllText($PathValue)
    return -not $text.Contains([char]0) -and $text -match 'node|npm'
}

function Get-Sha256([string]$PathValue) {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($PathValue)
        try {
            return [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '')
        } finally {
            $stream.Dispose()
        }
    } finally {
        $sha256.Dispose()
    }
}

function Repair-DependenciesIfNeeded {
    if (-not (Test-CommandShim (Join-Path $projectRoot 'node_modules\.bin\vite.cmd'))) {
        Write-Host '[REPAIR] Reinstalling root dependencies from package-lock.json.' -ForegroundColor Yellow
        Invoke-Checked 'Restore root dependencies' 'npm.cmd' @('ci', '--ignore-scripts=false')
    }
    if (-not (Test-CommandShim (Join-Path $projectRoot 'server\node_modules\.bin\tsc.cmd'))) {
        Write-Host '[REPAIR] Reinstalling server dependencies from package-lock.json.' -ForegroundColor Yellow
        Invoke-Checked 'Restore server dependencies' 'npm.cmd' @('ci', '--prefix', 'server', '--ignore-scripts=false')
    }
}

function Invoke-SourcePreflight {
    Write-Host '[CHECK] Scanning package source files for NUL corruption...' -ForegroundColor Cyan
    $extensions = @('.ts', '.tsx', '.js', '.cjs', '.mjs', '.css', '.html', '.json', '.ps1', '.bat')
    $roots = @(
        $projectRoot,
        (Join-Path $projectRoot 'components'),
        (Join-Path $projectRoot 'config'),
        (Join-Path $projectRoot 'desktop'),
        (Join-Path $projectRoot 'scripts'),
        (Join-Path $projectRoot 'server\src')
    )
    $files = foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        if ($root -eq $projectRoot) {
            Get-ChildItem -LiteralPath $root -File | Where-Object Extension -in $extensions
        } else {
            Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object Extension -in $extensions
        }
    }
    foreach ($file in $files | Sort-Object FullName -Unique) { Assert-TextFileHealthy $file.FullName }
    Write-Host '[OK] Source integrity check passed.' -ForegroundColor Green
}

function Remove-TemporaryOutput {
    $resolved = [System.IO.Path]::GetFullPath($temporaryRoot)
    if ((Split-Path -Parent $resolved).TrimEnd('\') -ne $temporaryBase -or
        -not (Split-Path -Leaf $resolved).StartsWith('flame-release-')) {
        throw "Unsafe temporary output path: $resolved"
    }
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}

function Write-LogGuide([string]$DestinationRoot) {
    $guidePath = Join-Path $DestinationRoot '现场调试日志说明.txt'
    $content = @"
火焰探测器检测台 - 现场调试日志说明

1. 安装版启动后，程序会在“程序 EXE 所在目录”自动创建 logs 子目录：
   <安装目录>\logs\

2. latest.log：当前/最近一次启动的完整日志，现场复现后优先提供此文件。

3. flame-detector-<时间>-pid<进程号>.log：每次启动保留一个独立会话日志。

4. 日志包含：
   - Electron 主进程启动、关闭、异常
   - 内嵌统一后端 console/stdout/stderr
   - 渲染器 console、加载失败、崩溃/无响应
   - 本地后端网络错误
   - [WaveformDiag][WS] 后端 WebSocket 波形发布诊断
   - [WaveformDiag][UI] 前端实际接收波形诊断

5. 波形延迟分析重点对比：
   total       累计样本数
   delta       本次 WebSocket 增量样本数
   lastAgeMs   该探测器最后数据更新时间距当前时间
   stateAgeMs  后端发布状态年龄
   wireAgeMs   前端收到消息时的链路年龄
   maxBuffered WebSocket 客户端发送缓冲字节数

6. 日志自动保留最近 30 天，最多 60 个会话文件；latest.log 始终指向最新会话内容。
"@
    [System.IO.File]::WriteAllText($guidePath, $content, [System.Text.UTF8Encoding]::new($true))
}

Push-Location $projectRoot
try {
    Invoke-SourcePreflight
    Repair-DependenciesIfNeeded
    Invoke-Checked 'Validate Electron main process syntax' 'node.exe' @('--check', 'desktop\main.cjs')
    if ($PreflightOnly) {
        Write-Host "`n[OK] Preflight passed. Packaging was not run." -ForegroundColor Green
        exit 0
    }

    Remove-TemporaryOutput
    Invoke-Checked 'Build frontend' 'npm.cmd' @('run', 'build:web')
    Invoke-Checked 'Build server' 'npm.cmd' @('run', 'build:server')
    Invoke-Checked 'Build Windows installer' 'npx.cmd' @(
        '--no-install', 'electron-builder', '--win', 'nsis',
        "--config.directories.output=$temporaryRoot"
    )

    $installer = Get-ChildItem -LiteralPath $temporaryRoot -Filter '*.exe' -File |
        Where-Object Name -NotLike '*uninstaller*' |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $installer) { throw "Installer not found in $temporaryRoot" }

    $bytes = [System.IO.File]::ReadAllBytes($installer.FullName)
    if ($bytes.Length -lt 64 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) {
        throw "Generated file is not a valid Windows EXE: $($installer.FullName)"
    }

    New-Item -ItemType Directory -Path $latestRoot -Force | Out-Null
    $latestInstaller = Join-Path $latestRoot "$latestBaseName.exe"
    Copy-Item -LiteralPath $installer.FullName -Destination $latestInstaller -Force
    $hash = Get-Sha256 $latestInstaller
    [System.IO.File]::WriteAllText(
        (Join-Path $latestRoot "$latestBaseName.sha256"),
        "$hash  $latestBaseName.exe`r`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    Write-LogGuide $latestRoot

    $file = Get-Item -LiteralPath $latestInstaller
    Write-Host "`n[OK] Latest installer updated" -ForegroundColor Green
    Write-Host "Path: $latestInstaller"
    Write-Host "Size: $([Math]::Round($file.Length / 1MB, 1)) MB"
    Write-Host "SHA256: $hash"
    Write-Host "Runtime logs after install: <install dir>\logs\latest.log"
} finally {
    Pop-Location
    try { Remove-TemporaryOutput } catch { Write-Warning "Temporary cleanup failed: $($_.Exception.Message)" }
}
