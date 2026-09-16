[CmdletBinding()]
param(
    [int[]]$Ports = @(3000, 3001, 3002, 3003, 3004, 3005),
    [string]$ProjectRoot,
    [int[]]$ExcludeProcessIds = @()
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
}
$resolvedRoot = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
$targetIds = [System.Collections.Generic.HashSet[int]]::new()
$excludedIds = [System.Collections.Generic.HashSet[int]]::new()

foreach ($processId in $ExcludeProcessIds) {
    if ($processId -gt 0) { [void]$excludedIds.Add($processId) }
}
[void]$excludedIds.Add($PID)
[void]$excludedIds.Add(4) # Windows System/HTTP.sys owner must never be force-killed.

# The launcher invokes this script as a child process. Exclude the complete
# caller chain so the cleanup pass cannot terminate the current start-all.bat
# or the one-click stop wrapper while scanning project command lines.
try {
    $ancestorId = $PID
    while ($ancestorId -gt 0) {
        $ancestor = Get-CimInstance Win32_Process -Filter "ProcessId=$ancestorId" -ErrorAction Stop
        if (-not $ancestor) { break }
        $parentId = [int]$ancestor.ParentProcessId
        if ($parentId -le 0 -or $parentId -eq $ancestorId) { break }
        [void]$excludedIds.Add($parentId)
        $ancestorId = $parentId
    }
} catch {
    Write-Warning "Cannot inspect cleanup caller chain; current PowerShell process remains excluded: $($_.Exception.Message)"
}

function Add-TargetProcess([int]$ProcessId) {
    if ($ProcessId -gt 0 -and -not $excludedIds.Contains($ProcessId)) {
        [void]$targetIds.Add($ProcessId)
    }
}

function Add-PortOwner([hashtable]$Owners, [int]$Port, [int]$ProcessId) {
    if ($Port -le 0 -or $ProcessId -le 0) { return }
    if (-not $Owners.ContainsKey($Port)) {
        $Owners[$Port] = [System.Collections.Generic.HashSet[int]]::new()
    }
    [void]$Owners[$Port].Add($ProcessId)
}

function Get-ListeningPortOwners {
    $owners = @{}
    foreach ($connection in @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)) {
        Add-PortOwner $owners ([int]$connection.LocalPort) ([int]$connection.OwningProcess)
    }

    # Get-NetTCPConnection can require elevated access on hardened Windows hosts.
    # netstat remains available to standard users and supplies the same PID data.
    foreach ($line in @(& "$env:SystemRoot\System32\netstat.exe" -ano -p tcp 2>$null)) {
        if ($line -match '^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
            Add-PortOwner $owners ([int]$matches[1]) ([int]$matches[2])
        }
    }
    return $owners
}

# Fixed project ports are the most reliable signal when an npm/tsx/Electron
# child survives after its command window has been closed.
foreach ($entry in (Get-ListeningPortOwners).GetEnumerator()) {
    if ($entry.Key -in $Ports) {
        foreach ($processId in $entry.Value) {
            Add-TargetProcess ([int]$processId)
        }
    }
}

foreach ($process in @(Get-Process -ErrorAction SilentlyContinue)) {
    if ($process.ProcessName -in @('FlameDetectorBench.WebView', 'FlameDetectorBench', '火焰探测器检测台') -or
        $process.MainWindowTitle -in @('Backend - Offline Closure', 'Frontend - Offline Closure')) {
        Add-TargetProcess $process.Id
    }
}

# Also catch project processes that currently only own outbound detector/PLC TCP
# connections and therefore do not appear in the listening-port list.
try {
    foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
        $commandLine = [string]$process.CommandLine
        $executablePath = [string]$process.ExecutablePath
        $hasProjectPath = $commandLine.IndexOf($resolvedRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
        $hasProjectMarker = $commandLine -match '(?i)(start-all\.bat|dev:field|dev-field\.mjs|desktop[\\/]+main\.cjs|server[\\/]+(?:dist|src|node_modules)[\\/]+|node_modules[\\/]+(?:vite|electron)[\\/]+|test-program)'
        $isProjectRuntime = $hasProjectPath -and $hasProjectMarker
        $isProjectExecutable = $executablePath.IndexOf($resolvedRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            $process.Name -match '^(electron|FlameDetectorBench(?:\.WebView)?|火焰探测器检测台)(\.exe)?$'
        $isNamedWindow = $commandLine -match 'Backend - Offline Closure|Frontend - Offline Closure'
        if (($isProjectRuntime -or $isProjectExecutable -or $isNamedWindow) -and
            $process.Name -match '^(node|tsx|cmd|dotnet|electron|vite|FlameDetectorBench(?:\.WebView)?|火焰探测器检测台)(\.exe)?$') {
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

$occupied = @()
$deadline = [DateTime]::UtcNow.AddSeconds(5)
do {
    Start-Sleep -Milliseconds 200
    $occupied = @((Get-ListeningPortOwners).Keys | Where-Object { $_ -in $Ports } | Sort-Object -Unique)
} while ($occupied.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)

if ($failed.Count -gt 0 -or $occupied.Count -gt 0) {
    $details = @()
    if ($failed.Count -gt 0) { $details += "Failed PIDs: $($failed -join ', ')" }
    if ($occupied.Count -gt 0) { $details += "Occupied ports: $($occupied -join ', ')" }
    Write-Error ($details -join '; ')
    exit 1
}

Write-Host "Frontend, backend, and their TCP connections have been stopped." -ForegroundColor Green
