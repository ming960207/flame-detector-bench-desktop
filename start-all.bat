@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul

cd /d "%~dp0"
title Flame Detector Test Bench - Source Runtime

echo ========================================
echo   Flame Detector Test Bench - Source Runtime
echo ========================================
echo.
echo This launcher now uses the SAME Electron runtime/logging path as the packaged app.
echo.
echo Project : %CD%
echo Log dir : %CD%\logs
echo Latest  : %CD%\logs\latest.log
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
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js not found!
    echo         Please install Node.js 22 x64.
    echo.
    pause
    exit /b 1
)

where npm >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] npm not found! Please reinstall Node.js.
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
) else (
    if not exist "node_modules\vite" (
        set NEED_FRONTEND_INSTALL=1
        echo [INFO] vite package missing
    )
    if not exist "node_modules\electron" (
        set NEED_FRONTEND_INSTALL=1
        echo [INFO] electron package missing
    )
)

if !NEED_FRONTEND_INSTALL! == 1 (
    echo [INSTALL] Installing frontend dependencies...
    call npm install
    if %ERRORLEVEL% neq 0 goto :error
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
    if %ERRORLEVEL% neq 0 goto :error
    echo [OK] Backend dependencies installed
) else (
    echo [OK] Backend dependencies ready
)
echo.

:: ========================================
:: 4. Validate Electron main process
:: ========================================
echo [CHECK] Electron main process syntax...
node --check desktop\main.cjs
if %ERRORLEVEL% neq 0 goto :error
echo [OK] Electron main process syntax valid
echo.

:: ========================================
:: 5. Build source exactly for Electron runtime
:: ========================================
echo [BUILD] Unified backend...
call npm run build:server
if %ERRORLEVEL% neq 0 goto :error

echo.
echo [BUILD] Desktop web frontend...
call npm run build:web
if %ERRORLEVEL% neq 0 goto :error

echo.
echo ========================================
echo   Starting Electron source runtime...
echo ========================================
echo.
echo Runtime logging is shared with packaged app:
echo   %CD%\logs\latest.log
echo   %CD%\logs\flame-detector-^<timestamp^>-pid^<pid^>.log
echo.
echo Captured scopes include:
echo   BOOT / BACKEND / STDOUT / STDERR / PROCESS

echo   RENDERER / NETWORK / WaveformDiag[WS] / WaveformDiag[UI]
echo.
echo NOTE: latest.log is recreated on each launch.
echo       Preserve the session log if multiple runs are needed.
echo.

:: IMPORTANT:
:: npm run desktop -> electron . -> desktop/main.cjs
:: This is the same main-process logging implementation used by the packaged app.
call npm run desktop
set APP_EXIT=%ERRORLEVEL%

echo.
echo ========================================
echo   Electron runtime exited: %APP_EXIT%
echo ========================================
echo Latest log:
echo   %CD%\logs\latest.log
echo.

if not "%APP_EXIT%"=="0" (
    echo [WARN] Runtime exited with non-zero code. Check latest.log first.
)

pause
exit /b %APP_EXIT%

:error
echo.
echo ========================================
echo   Build/start preparation failed

echo ========================================
echo Please review the console output above.
echo If Electron started before the failure, also check:
echo   %CD%\logs\latest.log
echo.
pause
exit /b 1
