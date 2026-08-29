@echo off
setlocal EnableExtensions EnableDelayedExpansion

title Flame Detector Test Program - Start

set "FLOW_DIR=%~dp0"
for %%I in ("%FLOW_DIR%..\..") do set "PROJECT_ROOT=%%~fI"
set "RUNTIME_DIR=%FLOW_DIR%runtime"
set "PID_FILE=%RUNTIME_DIR%\test-program.pid"
set "READY_FLAG=%RUNTIME_DIR%\test-program.ready"
set "FAILED_FLAG=%RUNTIME_DIR%\test-program.failed"
set "STATUS_FILE=%RUNTIME_DIR%\test-program.status.json"

if not defined TEST_PROGRAM_SERVER_PORT set "TEST_PROGRAM_SERVER_PORT=3004"
if not defined TEST_PROGRAM_FRONTEND_PORT set "TEST_PROGRAM_FRONTEND_PORT=3005"
if not defined FORMAL_BACKEND_URL set "FORMAL_BACKEND_URL=http://127.0.0.1:3003"
if not defined TEST_PROGRAM_DATA_DIR set "TEST_PROGRAM_DATA_DIR=%RUNTIME_DIR%\data"

echo ========================================
echo   Flame Detector Test Program - Start
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
if not exist "%RUNTIME_DIR%" mkdir "%RUNTIME_DIR%"

if exist "%PID_FILE%" (
    set "EXISTING_PID="
    set /p EXISTING_PID=<"%PID_FILE%"
    if defined EXISTING_PID (
        tasklist /FI "PID eq !EXISTING_PID!" /NH 2>nul | findstr /r /c:"!EXISTING_PID!" >nul
        if not errorlevel 1 (
            echo [INFO] Test program is already running with PID !EXISTING_PID!.
            echo [INFO] Use stop-test-program.bat before starting it again.
            exit /b 0
        )
    )
    del /q "%PID_FILE%" >nul 2>&1
)

del /q "%READY_FLAG%" "%FAILED_FLAG%" "%STATUS_FILE%" >nul 2>&1

if not defined TEST_PROGRAM_SKIP_BUILD (
    echo [BUILD] Building the test program frontend...
    pushd "%PROJECT_ROOT%"
    call npm run build:web:test
    set "BUILD_CODE=!ERRORLEVEL!"
    popd
    if not "!BUILD_CODE!"=="0" (
        echo [ERROR] Test program frontend build failed.
        exit /b !BUILD_CODE!
    )
    echo [BUILD] Building the test program backend...
    pushd "%PROJECT_ROOT%"
    call npm run build:server
    set "BUILD_CODE=!ERRORLEVEL!"
    popd
    if not "!BUILD_CODE!"=="0" (
        echo [ERROR] Test program backend build failed.
        exit /b !BUILD_CODE!
    )
) else (
    echo [BUILD] Skipped by TEST_PROGRAM_SKIP_BUILD.
)

if not exist "%PROJECT_ROOT%\dist\index.html" (
    echo [ERROR] Missing dist\index.html. Build the test frontend first.
    exit /b 1
)
if not exist "%PROJECT_ROOT%\server\dist\test-program-main.js" (
    echo [ERROR] Missing server\dist\test-program-main.js. Build the server first.
    exit /b 1
)
if not exist "%PROJECT_ROOT%\node_modules\vite\bin\vite.js" (
    echo [ERROR] Missing frontend Vite runtime. Run npm install in the project root.
    exit /b 1
)

echo [START] Launching the read-only test observer and frontend...
start "" /b node "%FLOW_DIR%test-program-runner.mjs"
if errorlevel 1 (
    echo [ERROR] Could not launch the test program runner.
    exit /b 1
)

for /l %%N in (1,1,30) do (
    if exist "%READY_FLAG%" (
        echo.
        echo [OK] Test program is ready.
        echo [INFO] Frontend: http://127.0.0.1:%TEST_PROGRAM_FRONTEND_PORT%
        echo [INFO] Observer: http://127.0.0.1:%TEST_PROGRAM_SERVER_PORT%
        echo [INFO] Formal source: %FORMAL_BACKEND_URL%
        echo [INFO] Stop: stop-test-program.bat
        exit /b 0
    )
    if exist "%FAILED_FLAG%" (
        echo.
        echo [ERROR] Test program failed to start.
        if exist "%STATUS_FILE%" type "%STATUS_FILE%"
        exit /b 1
    )
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 1" >nul 2>&1
)

echo [ERROR] Test program startup timed out.
if exist "%STATUS_FILE%" type "%STATUS_FILE%"
exit /b 1
