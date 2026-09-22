@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul

cd /d "%~dp0"
title Flame Detector Test Bench - Browser Runtime

echo ========================================
echo   Flame Detector Test Bench - Browser Runtime
echo ========================================
echo.
echo This launcher starts the field backend and Vite, then opens the system browser.
echo Electron is reserved for packaged desktop builds.
echo.
echo Project : %CD%
echo Backend : http://127.0.0.1:3001
echo Frontend: http://127.0.0.1:3002
echo.

:: ========================================
:: 0. Clean up every previous project runtime
:: ========================================
echo [CLEANUP] Stopping previous project processes and releasing ports...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-all.ps1" -ProjectRoot "%CD%"
if errorlevel 1 (
    echo [ERROR] Existing project processes or ports could not be stopped.
    echo         Resolve the reported PIDs/ports, then run start-all.bat again.
    echo.
    pause
    exit /b 1
)
echo [OK] Previous project processes stopped and ports released
echo.

:: ========================================
:: 1. Check Node.js / npm
:: ========================================
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found!
    echo         Please install Node.js 22 x64.
    echo.
    pause
    exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm not found! Please reinstall Node.js.
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v 2^>nul') do set NODE_VER=%%v
echo [OK] Node.js: %NODE_VER%
echo [OK] npm is available
echo.

:: ========================================
:: 2. Frontend dependencies
:: ========================================
echo [CHECK] Frontend dependencies...
set NEED_FRONTEND_INSTALL=0

if not exist "node_modules" (
    set NEED_FRONTEND_INSTALL=1
    echo [INFO] node_modules not found
) else if not exist "node_modules\vite" (
    set NEED_FRONTEND_INSTALL=1
    echo [INFO] vite package missing
)

if !NEED_FRONTEND_INSTALL! == 1 (
    echo [INSTALL] Installing frontend dependencies...
    call npm install
    if errorlevel 1 goto :error
    echo [OK] Frontend dependencies installed
) else (
    echo [OK] Frontend dependencies ready
)
echo.

:: ========================================
:: 3. Backend dependencies
:: ========================================
echo [CHECK] Backend dependencies...
set NEED_SERVER_INSTALL=0

if not exist "server\node_modules" (
    set NEED_SERVER_INSTALL=1
    echo [INFO] server\node_modules not found
) else (
    if not exist "server\node_modules\tsx" (
        set NEED_SERVER_INSTALL=1
        echo [INFO] tsx package missing
    )
    if not exist "server\node_modules\express" (
        set NEED_SERVER_INSTALL=1
        echo [INFO] express package missing
    )
)

if !NEED_SERVER_INSTALL! == 1 (
    echo [INSTALL] Installing backend dependencies...
    call npm install --prefix server
    if errorlevel 1 goto :error
    echo [OK] Backend dependencies installed
) else (
    echo [OK] Backend dependencies ready
)
echo.

:: ========================================
:: 4. Start the source services in the background
:: ========================================
echo [START] Unified field backend and Vite frontend...
set "NODE_ENV=development"
set "CLOSURE_MODE=field"
set "SERVER_PORT=3001"
start "Flame Detector Backend" /min cmd /c "npm run dev --prefix server"

set "VITE_RUNTIME_MODE=field"
set "VITE_BACKEND_API_URL=http://127.0.0.1:3001"
set "VITE_BACKEND_WS_URL=ws://127.0.0.1:3001"
start "Flame Detector Vite" /min cmd /c "npm run dev"

set "NODE_ENV="
set "CLOSURE_MODE="
set "SERVER_PORT="
set "VITE_RUNTIME_MODE="
set "VITE_BACKEND_API_URL="
set "VITE_BACKEND_WS_URL="

echo [WAIT] Waiting for backend and frontend to become ready...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$deadline = (Get-Date).AddSeconds(30); $frontendReady = $false; $backendReady = $false; while ((Get-Date) -lt $deadline) { try { $frontend = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3002/' -TimeoutSec 1; $frontendReady = $frontend.StatusCode -ge 200 -and $frontend.StatusCode -lt 500 } catch { $frontendReady = $false }; try { $backend = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3001/api/health' -TimeoutSec 1; $backendReady = $backend.StatusCode -ge 200 -and $backend.StatusCode -lt 500 } catch { $backendReady = $false }; if ($frontendReady -and $backendReady) { exit 0 }; Start-Sleep -Milliseconds 250 }; exit 1"
if errorlevel 1 (
    echo [ERROR] Backend or frontend did not become ready within 30 seconds.
    echo         Check the running field runtime console for the concrete error.
    goto :error
)

echo [OK] Backend and frontend are ready
echo [OPEN] Opening the system default browser...
start "" "http://127.0.0.1:3002/"
echo.
echo Browser page: http://127.0.0.1:3002/
echo Backend    : http://127.0.0.1:3001/
echo.
echo The field runtime is running in the background. Run scripts\stop-all.ps1 to stop it.
echo.
pause
exit /b 0

:error
echo.
echo ========================================
echo   Browser runtime preparation failed
echo ========================================
echo Please review the service console output above.
echo.
pause
exit /b 1
