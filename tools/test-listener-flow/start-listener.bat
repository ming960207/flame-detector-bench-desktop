@echo off
setlocal EnableExtensions EnableDelayedExpansion

title Test Listener Flow - Start

set "FLOW_DIR=%~dp0"
for %%I in ("%FLOW_DIR%..\..") do set "PROJECT_ROOT=%%~fI"
set "RUNTIME_DIR=%FLOW_DIR%runtime"
set "PID_FILE=%RUNTIME_DIR%\listener.pid"
set "STATUS_FILE=%RUNTIME_DIR%\listener.status.json"
set "READY_FLAG=%RUNTIME_DIR%\listener.ready"
set "FAILED_FLAG=%RUNTIME_DIR%\listener.failed"

if not defined TEST_LISTENER_SERVER_PORT set "TEST_LISTENER_SERVER_PORT=3003"
if not defined TEST_LISTENER_FRONTEND_PORT set "TEST_LISTENER_FRONTEND_PORT=3002"

echo ========================================
echo   Test Listener Flow - Start
echo ========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js was not found in PATH.
    exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm was not found in PATH.
    exit /b 1
)

set "NODE_EXE="
for /f "delims=" %%N in ('where node') do if not defined NODE_EXE set "NODE_EXE=%%N"

if not exist "%RUNTIME_DIR%" mkdir "%RUNTIME_DIR%"

if exist "%PID_FILE%" (
    set "EXISTING_PID="
    set /p EXISTING_PID=<"%PID_FILE%"
    if defined EXISTING_PID (
        tasklist /FI "PID eq !EXISTING_PID!" /NH 2>nul | findstr /r /c:"!EXISTING_PID!" >nul
        if not errorlevel 1 (
            echo [INFO] Listener is already running with PID !EXISTING_PID!.
            echo [INFO] Use stop-listener.bat before starting it again.
            exit /b 0
        )
    )
    del /q "%PID_FILE%" >nul 2>&1
)

del /q "%READY_FLAG%" "%FAILED_FLAG%" "%STATUS_FILE%" >nul 2>&1

if not defined TEST_LISTENER_SKIP_BUILD (
    echo [BUILD] Building the field server...
    pushd "%PROJECT_ROOT%"
    call npm run build --prefix server
    set "BUILD_CODE=!ERRORLEVEL!"
    popd
    if not "!BUILD_CODE!"=="0" (
        echo [ERROR] Field server build failed.
        exit /b !BUILD_CODE!
    )
) else (
    echo [BUILD] Skipped by TEST_LISTENER_SKIP_BUILD.
)

if not exist "%PROJECT_ROOT%\server\dist\field-main.js" (
    echo [ERROR] Missing server\dist\field-main.js.
    echo [INFO] Run the server build or clear TEST_LISTENER_SKIP_BUILD.
    exit /b 1
)

if not exist "%PROJECT_ROOT%\node_modules\vite\bin\vite.js" (
    echo [ERROR] Missing frontend Vite runtime.
    echo [INFO] Run npm install in the project root.
    exit /b 1
)

echo [START] Launching the read-only field listener...
start "" /b "%NODE_EXE%" "%FLOW_DIR%listener-runner.mjs"
if errorlevel 1 (
    echo [ERROR] Could not launch the listener runner.
    exit /b 1
)

for /l %%N in (1,1,30) do (
    if exist "%READY_FLAG%" (
        echo.
        echo [OK] Test listener flow is ready.
        echo [INFO] Frontend: http://127.0.0.1:%TEST_LISTENER_FRONTEND_PORT%
        echo [INFO] Backend : http://127.0.0.1:%TEST_LISTENER_SERVER_PORT%
        echo [INFO] Log     : %RUNTIME_DIR%\listener.log
        echo [INFO] Stop    : stop-listener.bat
        exit /b 0
    )
    if exist "%FAILED_FLAG%" (
        echo.
        echo [ERROR] Test listener flow failed to start.
        if exist "%STATUS_FILE%" type "%STATUS_FILE%"
        echo [INFO] Log: %RUNTIME_DIR%\listener.log
        exit /b 1
    )
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 1" >nul 2>&1
)

echo [ERROR] Listener startup timed out.
if exist "%STATUS_FILE%" type "%STATUS_FILE%"
echo [INFO] Log: %RUNTIME_DIR%\listener.log
exit /b 1
