[CmdletBinding()]
param(
    [int[]]$Ports = @(3000, 3001),
    [string]$ProjectRoot
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
}
$resolvedRoot = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
$targetIds = [System.Collections.Generic.HashSet[int]]::new()

function Add-TargetProcess([int]$ProcessId) {
    if ($ProcessId -gt 0 -and $ProcessId -ne $PID) {
        [void]$targetIds.Add($ProcessId)
    }
}

function Get-ListeningPortOwners {
    $owners = @{}
    foreach ($connection in @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)) {
        $owners[[int]$connection.LocalPort] = [int]$connection.OwningProcess
    }

    # Get-NetTCPConnection can require elevated access on hardened Windows hosts.
    # netstat remains available to standard users and supplies the same PID data.
    foreach ($line in @(& "$env:SystemRoot\System32\netstat.exe" -ano -p tcp 2>$null)) {
        if ($line -match '^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
            $owners[[int]$matches[1]] = [int]$matches[2]
        }
    }
    return $owners
}

# Fixed development ports are the most reliable signal when an npm/tsx child
# survives after its command window has been closed.
foreach ($entry in (Get-ListeningPortOwners).GetEnumerator()) {
    if ($entry.Key -in $Ports) {
        Add-TargetProcess $entry.Value
    }
}

foreach ($process in @(Get-Process -ErrorAction SilentlyContinue)) {
    if ($process.ProcessName -eq 'FlameDetectorBench.WebView' -or
        $process.MainWindowTitle -in @('Backend - Offline Closure', 'Frontend - Offline Closure')) {
        Add-TargetProcess $process.Id
    }
}

# Also catch project processes that currently only own outbound detector/PLC TCP
# connections and therefore do not appear in the listening-port list.
try {
    foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
        $commandLine = [string]$process.CommandLine
        $isProjectRuntime = $commandLine.IndexOf($resolvedRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
        $isNamedWindow = $commandLine -match 'Backend - Offline Closure|Frontend - Offline Closure'
        if (($isProjectRuntime -or $isNamedWindow) -and $process.Name -match '^(node|tsx|cmd|dotnet|FlameDetectorBench\.WebView)(\.exe)?$') {
            Add-TargetProcess $process.ProcessId
        }
    }
} catch {
    Write-Warning "Cannot inspect process command lines; falling back to listening ports only: $($_.Exception.Message)"
}

if ($targetIds.Count -eq 0) {
    Write-Host "No running project services were found." -ForegroundColor Green
    exit 0
}

$failed = @()
foreach ($processId in @($targetIds)) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if (-not $process) {
        continue
    }

    Write-Host "Stopping $($process.ProcessName) (PID $processId)..."
    $previousErrorPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $taskkillOutput = & taskkill.exe /PID $processId /T /F 2>&1
    $taskkillExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorPreference
    $taskkillOutput | Out-Host
    if ($taskkillExitCode -ne 0 -and (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
        $failed += $processId
    }
}

Start-Sleep -Milliseconds 300
$occupied = @((Get-ListeningPortOwners).Keys | Where-Object { $_ -in $Ports } | Sort-Object -Unique)

if ($failed.Count -gt 0 -or $occupied.Count -gt 0) {
    $details = @()
    if ($failed.Count -gt 0) { $details += "Failed PIDs: $($failed -join ', ')" }
    if ($occupied.Count -gt 0) { $details += "Occupied ports: $($occupied -join ', ')" }
    Write-Error ($details -join '; ')
    exit 1
}

Write-Host "Frontend, backend, and their TCP connections have been stopped." -ForegroundColor Green
