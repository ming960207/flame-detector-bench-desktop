[CmdletBinding()]
param(
    [switch]$SkipFrontendBuild,
    [switch]$SkipServerBuild,
    [switch]$OfflineNpm
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$packagingRoot = Join-Path $projectRoot 'packaging\test-listener-portable'
$releaseRoot = Join-Path $projectRoot 'release-single'
$artifactPath = Join-Path $releaseRoot 'FlameDetectorTestListener.exe'
$hashPath = $artifactPath + '.sha256'
$tempRoot = Join-Path $env:TEMP ('flame-detector-portable-build-' + [guid]::NewGuid().ToString('N'))
$payloadRoot = Join-Path $tempRoot 'payload'
$stagedServerRoot = Join-Path $payloadRoot 'server'
$stagedServerDist = Join-Path $stagedServerRoot 'dist'
$zipPath = Join-Path $tempRoot 'payload.zip'

function Assert-File([string]$path, [string]$description) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Missing $description`: $path"
    }
}

function Write-Utf8NoBom([string]$path, [string]$content) {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $content, $encoding)
}

function Invoke-Checked([string]$fileName, [string[]]$arguments) {
    & $fileName @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $fileName $($arguments -join ' ')"
    }
}

try {
    Assert-File (Join-Path $packagingRoot 'Launcher.cs') 'launcher source'
    Assert-File (Join-Path $packagingRoot 'static-server.mjs') 'static server source'
    Assert-File (Join-Path $projectRoot 'server\package.json') 'server package manifest'
    Assert-File (Join-Path $projectRoot 'server\package-lock.json') 'server lock file'
    Assert-File (Join-Path $projectRoot 'server\system-config.json') 'system configuration'
    Assert-File (Join-Path $projectRoot 'server\plc-configs.json') 'PLC configuration'

    $nodeCommand = Get-Command node.exe -ErrorAction Stop
    $nodePath = $nodeCommand.Source
    $nodeArch = (& $nodePath -p 'process.arch').Trim()
    if ($nodeArch -ne 'x64') {
        throw "The packaged Node.js runtime must be x64. Detected: $nodeArch"
    }

    if (-not $SkipFrontendBuild) {
        Push-Location $projectRoot
        try {
            Invoke-Checked 'npm.cmd' @('run', 'build:web')
        }
        finally {
            Pop-Location
        }
    }
    if (-not $SkipServerBuild) {
        Push-Location $projectRoot
        try {
            Invoke-Checked 'npm.cmd' @('run', 'build:server')
        }
        finally {
            Pop-Location
        }
    }

    Assert-File (Join-Path $projectRoot 'dist\index.html') 'frontend build'
    Assert-File (Join-Path $projectRoot 'server\dist\field-main.js') 'field backend build'

    New-Item -ItemType Directory -Path $payloadRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $stagedServerRoot -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $payloadRoot 'runtime') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $payloadRoot 'config') -Force | Out-Null

    Copy-Item -LiteralPath (Join-Path $projectRoot 'dist') -Destination (Join-Path $payloadRoot 'dist') -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $projectRoot 'server\dist') -Destination $stagedServerRoot -Recurse -Force
    Get-ChildItem -LiteralPath $stagedServerDist -Recurse -File -Include '*.d.ts', '*.map' |
        Remove-Item -Force
    Copy-Item -LiteralPath (Join-Path $packagingRoot 'static-server.mjs') -Destination (Join-Path $payloadRoot 'static-server.mjs') -Force
    Copy-Item -LiteralPath (Join-Path $projectRoot 'server\package.json') -Destination (Join-Path $stagedServerRoot 'package.json') -Force
    Copy-Item -LiteralPath (Join-Path $projectRoot 'server\package-lock.json') -Destination (Join-Path $stagedServerRoot 'package-lock.json') -Force

    Write-Utf8NoBom (Join-Path $stagedServerRoot '.env') "CLOSURE_MODE=field`r`nSERVER_PORT=3003`r`n"

    $systemConfig = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'server\system-config.json') | ConvertFrom-Json
    $systemExample = [ordered]@{
        flameConfig = $systemConfig.flameConfig
        lastUpdated = $systemConfig.lastUpdated
    }
    Write-Utf8NoBom (
        Join-Path $payloadRoot 'config\system-config.example.json'
    ) (($systemExample | ConvertTo-Json -Depth 100) + [Environment]::NewLine)

    $plcConfig = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'server\plc-configs.json') | ConvertFrom-Json
    $plcExample = [ordered]@{
        plcs = $plcConfig.plcs
        lastUpdated = $plcConfig.lastUpdated
    }
    Write-Utf8NoBom (
        Join-Path $payloadRoot 'config\plc-configs.example.json'
    ) (($plcExample | ConvertTo-Json -Depth 100) + [Environment]::NewLine)

    Push-Location $stagedServerRoot
    try {
        $npmArguments = @('ci', '--omit=dev', '--ignore-scripts')
        if ($OfflineNpm) { $npmArguments += '--offline' }
        Invoke-Checked 'npm.cmd' $npmArguments
    }
    finally {
        Pop-Location
    }
    Remove-Item -LiteralPath (Join-Path $stagedServerRoot 'package.json') -Force
    Remove-Item -LiteralPath (Join-Path $stagedServerRoot 'package-lock.json') -Force

    Copy-Item -LiteralPath $nodePath -Destination (Join-Path $payloadRoot 'runtime\node.exe') -Force

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $payloadRoot,
        $zipPath,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $false)

    New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
    foreach ($oldPath in @($artifactPath, $hashPath)) {
        if (Test-Path -LiteralPath $oldPath) {
            Remove-Item -LiteralPath $oldPath -Force
        }
    }

    $frameworkRoot = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
    $cscPath = Join-Path $frameworkRoot 'csc.exe'
    Assert-File $cscPath 'x64 C# compiler'
    $references = @(
        'System.dll',
        'System.Core.dll',
        'System.IO.Compression.dll',
        'System.IO.Compression.FileSystem.dll',
        'System.Management.dll',
        'System.Windows.Forms.dll'
    ) | ForEach-Object { '/reference:' + (Join-Path $frameworkRoot $_) }
    $cscArguments = @(
        '/nologo',
        '/target:winexe',
        '/platform:x64',
        '/optimize+',
        ('/out:' + $artifactPath),
        ('/resource:' + $zipPath + ',Payload.zip')
    ) + $references + @(Join-Path $packagingRoot 'Launcher.cs')
    Invoke-Checked $cscPath $cscArguments

    $hash = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Utf8NoBom $hashPath ($hash + '  ' + (Split-Path -Leaf $artifactPath) + [Environment]::NewLine)
    Copy-Item -LiteralPath (Join-Path $packagingRoot 'README.md') -Destination (Join-Path $releaseRoot 'FlameDetectorTestListener-README.md') -Force

    $artifactInfo = Get-Item -LiteralPath $artifactPath
    Write-Output ('Artifact: ' + $artifactPath)
    Write-Output ('SizeBytes: ' + $artifactInfo.Length)
    Write-Output ('SHA256: ' + $hash)
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
