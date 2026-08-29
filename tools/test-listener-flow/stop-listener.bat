@echo off
setlocal EnableExtensions

title Test Listener Flow - Stop

set "FLOW_DIR=%~dp0"
set "RUNTIME_DIR=%FLOW_DIR%runtime"
set "PID_FILE=%RUNTIME_DIR%\listener.pid"
set "STATUS_FILE=%RUNTIME_DIR%\listener.status.json"
set "READY_FLAG=%RUNTIME_DIR%\listener.ready"
set "FAILED_FLAG=%RUNTIME_DIR%\listener.failed"

echo ========================================
echo   Test Listener Flow - Stop
echo ========================================
echo.

if not exist "%PID_FILE%" (
    del /q "%READY_FLAG%" "%FAILED_FLAG%" "%STATUS_FILE%" >nul 2>&1
    echo [INFO] No active listener flow was found.
    exit /b 0
)

set "LISTENER_PID="
set /p LISTENER_PID=<"%PID_FILE%"
if not defined LISTENER_PID (
    del /q "%PID_FILE%" "%READY_FLAG%" "%FAILED_FLAG%" "%STATUS_FILE%" >nul 2>&1
    echo [INFO] Removed an empty listener state file.
    exit /b 0
)

echo %LISTENER_PID%| findstr /r /x "[0-9][0-9]*" >nul
if errorlevel 1 (
    echo [ERROR] Invalid listener PID: %LISTENER_PID%
    exit /b 1
)

set "FLOW_PROCESS=0"
for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$expected = [IO.Path]::GetFullPath('%FLOW_DIR%listener-runner.mjs'); $p = Get-CimInstance Win32_Process -Filter 'ProcessId = %LISTENER_PID%'; if ($p -and $p.CommandLine -like ('*' + $expected + '*')) { '1' } else { '0' }"`) do set "FLOW_PROCESS=%%V"

if "%FLOW_PROCESS%"=="1" (
    echo [STOP] Stopping listener runner PID %LISTENER_PID% and its child processes...
    taskkill.exe /PID %LISTENER_PID% /T /F
    set "KILL_CODE=%ERRORLEVEL%"
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 1" >nul 2>&1
    if not "%KILL_CODE%"=="0" (
        tasklist /FI "PID eq %LISTENER_PID%" /NH 2>nul | findstr /r /c:"%LISTENER_PID%" >nul
        if not errorlevel 1 (
            echo [ERROR] The listener runner could not be stopped.
            exit /b %KILL_CODE%
        )
    )
) else (
    echo [INFO] The PID file is stale or does not belong to this listener flow.
    echo [INFO] No unrelated process was stopped.
)

del /q "%PID_FILE%" "%READY_FLAG%" "%FAILED_FLAG%" "%STATUS_FILE%" >nul 2>&1
echo [OK] Test listener flow is stopped.
exit /b 0
