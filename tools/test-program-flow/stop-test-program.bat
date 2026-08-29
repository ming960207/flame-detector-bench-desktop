@echo off
setlocal EnableExtensions

title Flame Detector Test Program - Stop

set "FLOW_DIR=%~dp0"
set "RUNTIME_DIR=%FLOW_DIR%runtime"
set "PID_FILE=%RUNTIME_DIR%\test-program.pid"
set "STATUS_FILE=%RUNTIME_DIR%\test-program.status.json"
set "READY_FLAG=%RUNTIME_DIR%\test-program.ready"
set "FAILED_FLAG=%RUNTIME_DIR%\test-program.failed"

echo ========================================
echo   Flame Detector Test Program - Stop
echo ========================================
echo.

if not exist "%PID_FILE%" (
    del /q "%READY_FLAG%" "%FAILED_FLAG%" "%STATUS_FILE%" >nul 2>&1
    echo [INFO] No active test program was found.
    exit /b 0
)

set "RUNNER_PID="
set /p RUNNER_PID=<"%PID_FILE%"
if not defined RUNNER_PID (
    del /q "%PID_FILE%" "%READY_FLAG%" "%FAILED_FLAG%" "%STATUS_FILE%" >nul 2>&1
    echo [INFO] Removed an empty test program state file.
    exit /b 0
)

echo %RUNNER_PID%| findstr /r /x "[0-9][0-9]*" >nul
if errorlevel 1 (
    echo [ERROR] Invalid test program PID: %RUNNER_PID%
    exit /b 1
)

set "FLOW_PROCESS=0"
for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$p = Get-CimInstance Win32_Process -Filter 'ProcessId = %RUNNER_PID%'; if ($p -and $p.CommandLine -like '*test-program-runner.mjs*') { '1' } else { '0' }"`) do set "FLOW_PROCESS=%%V"

if "%FLOW_PROCESS%"=="1" (
    echo [STOP] Stopping test program runner PID %RUNNER_PID% and child processes...
    taskkill.exe /PID %RUNNER_PID% /T /F
    set "KILL_CODE=%ERRORLEVEL%"
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 1" >nul 2>&1
    if not "%KILL_CODE%"=="0" (
        tasklist /FI "PID eq %RUNNER_PID%" /NH 2>nul | findstr /r /c:"%RUNNER_PID%" >nul
        if not errorlevel 1 (
            echo [ERROR] The test program runner could not be stopped.
            exit /b %KILL_CODE%
        )
    )
) else (
    echo [INFO] The PID file is stale or does not belong to this test program.
    echo [INFO] No unrelated process was stopped.
)

del /q "%PID_FILE%" "%READY_FLAG%" "%FAILED_FLAG%" "%STATUS_FILE%" >nul 2>&1
echo [OK] Test program is stopped.
exit /b 0
