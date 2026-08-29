[CmdletBinding()]
param(
    [string]$OutputDir = "release-webview",
    [string]$NuGetSource,
    [switch]$SelfContained,
    [switch]$OfflineNpm
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputDir))
$expectedParent = $projectRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar)
if ((Split-Path -Parent $releaseRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar) -ne $expectedParent) {
    throw "OutputDir must be a direct child of the project root: $OutputDir"
}

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE"
    }
}

function Assert-Path([string]$PathValue, [string]$Label) {
    if (-not (Test-Path -LiteralPath $PathValue)) {
        throw "Missing $Label`: $PathValue"
    }
}

$rootNodeModules = Join-Path $projectRoot "node_modules"
$serverNodeModules = Join-Path $projectRoot "server\node_modules"
Assert-Path $rootNodeModules "root node_modules"
Assert-Path $serverNodeModules "server node_modules"

$nodeSource = (Get-Command node.exe -ErrorAction Stop).Source
$webViewProject = Join-Path $projectRoot "desktop\webview\FlameDetectorBench.WebView.csproj"
Assert-Path $webViewProject "WebView2 project"

if (Test-Path -LiteralPath $releaseRoot) {
    Remove-Item -LiteralPath $releaseRoot -Recurse -Force
}

$publishRoot = Join-Path $releaseRoot ".publish"
$appRoot = Join-Path $releaseRoot "app"
$appDist = Join-Path $appRoot "dist"
$appServer = Join-Path $appRoot "server"
$appServerDist = Join-Path $appServer "dist"
$appRuntime = Join-Path $appRoot "runtime"
New-Item -ItemType Directory -Path $publishRoot,$appDist,$appServer,$appServerDist,$appRuntime -Force | Out-Null

Push-Location $projectRoot
try {
    Invoke-Checked "npm.cmd" @("run", "build:web")
    Invoke-Checked "npm.cmd" @("run", "build:server")
    $restoreArguments = @("restore", $webViewProject, "--runtime", "win-x64")
    if ($NuGetSource) {
        $restoreArguments += @("--source", $NuGetSource, "--ignore-failed-sources")
    }
    Invoke-Checked "dotnet.exe" $restoreArguments
    $publishArguments = @(
        "publish",
        $webViewProject,
        "--configuration", "Release",
        "--runtime", "win-x64",
        "--no-restore",
        "--output", $publishRoot,
        "/p:UseAppHost=true",
        "/p:UseAppHost=true",
        "/p:DebugType=None",
        "/p:DebugSymbols=false"
    )
    if ($SelfContained) {
        $publishArguments += @("--self-contained", "true", "/p:PublishSingleFile=true", "/p:IncludeNativeLibrariesForSelfExtract=true")
    } else {
        $publishArguments += @("--self-contained", "false")
    }
    Invoke-Checked "dotnet.exe" $publishArguments
} finally {
    Pop-Location
}

$publishedExecutable = Get-ChildItem -Path (Join-Path $publishRoot "*.exe") -File | Select-Object -First 1
if (-not $publishedExecutable) {
    throw "WebView2 executable was not produced"
}

Get-ChildItem -LiteralPath $publishRoot -File |
    Where-Object { $_.Extension -notin @(".pdb", ".xml") -and $_.Name -ne "Microsoft.Web.WebView2.Wpf.dll" } |
    Copy-Item -Destination $releaseRoot -Force
Copy-Item -Path (Join-Path $projectRoot "dist\*") -Destination $appDist -Recurse -Force
Copy-Item -Path (Join-Path $projectRoot "server\dist\*") -Destination $appServerDist -Recurse -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "server\package.json") -Destination $appServer -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "server\package-lock.json") -Destination $appServer -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "server\system-config.json") -Destination $appServer -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "server\plc-configs.json") -Destination $appServer -Force
if (Test-Path -LiteralPath (Join-Path $projectRoot "server\.env")) {
    Copy-Item -LiteralPath (Join-Path $projectRoot "server\.env") -Destination $appServer -Force
} else {
    Copy-Item -LiteralPath (Join-Path $projectRoot "server\.env.example") -Destination (Join-Path $appServer ".env") -Force
}
$npmArguments = @("ci", "--prefix", $appServer, "--omit=dev", "--ignore-scripts")
if ($OfflineNpm) {
    $npmArguments += "--offline"
}
Invoke-Checked "npm.cmd" $npmArguments
Remove-Item -LiteralPath (Join-Path $appServer "package-lock.json") -Force
Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $appRuntime "node.exe") -Force

$finalExecutable = Join-Path (Split-Path -Parent $publishRoot) $publishedExecutable.Name
if (Test-Path -LiteralPath $publishRoot) {
    Remove-Item -LiteralPath $publishRoot -Recurse -Force
}

$sizeMb = [math]::Round(((Get-ChildItem -LiteralPath $releaseRoot -Recurse -File -Force | Measure-Object Length -Sum).Sum) / 1MB, 1)
Write-Host "Done: $finalExecutable ($sizeMb MB)" -ForegroundColor Green
Write-Host "WebView2 Runtime: system-installed Evergreen runtime required"
