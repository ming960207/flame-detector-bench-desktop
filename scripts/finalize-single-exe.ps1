param(
    [string]$ReleaseDir = "release-installer-final",
    [string]$OutputDir = "release"
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$sourceRoot = Join-Path $projectRoot $ReleaseDir
$outputRoot = Join-Path $projectRoot $OutputDir
$targetFileName = [string]::Concat(
    [char]0x706B, [char]0x7130, [char]0x63A2, [char]0x6D4B,
    [char]0x5668, [char]0x68C0, [char]0x6D4B, [char]0x53F0,
    "-single-exe-setup.exe"
)
$target = Join-Path $outputRoot $targetFileName

$installer = Get-ChildItem -LiteralPath $sourceRoot -Filter "*.exe" -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if (-not $installer) { throw "未找到 Electron 单 EXE 安装包：$sourceRoot" }

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
Copy-Item -LiteralPath $installer.FullName -Destination $target -Force

$bytes = [System.IO.File]::ReadAllBytes($target)
if ($bytes.Length -lt 64 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) {
    throw "生成文件不是有效的 Windows EXE：$target"
}

$hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
$sizeMb = [math]::Round((Get-Item -LiteralPath $target).Length / 1MB, 1)
Write-Host "完成：$target ($sizeMb MB)" -ForegroundColor Green
Write-Host "SHA256: $hash"
