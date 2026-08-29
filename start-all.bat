@echo off
setlocal EnableDelayedExpansion

title Flame Detector Test Bench - Field Runtime

echo ========================================
echo   Flame Detector Test Bench - Field Runtime
echo ========================================
echo.

:: ========================================
:: 1. Check Node.js
:: ========================================
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js not found!
    echo         Please install from https://nodejs.org
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v 2^>nul') do set NODE_VER=%%v
echo [OK] Node.js: %NODE_VER%

:: ========================================
:: 2. Check npm
:: ========================================
where npm >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] npm not found! Please reinstall Node.js.
    pause
    exit /b 1
)
echo [OK] npm is available
echo.

:: ========================================
:: 3. Frontend dependencies
:: ========================================
echo [CHECK] Frontend dependencies...

set NEED_FRONTEND_INSTALL=0

if not exist "node_modules" (
    set NEED_FRONTEND_INSTALL=1
    echo [INFO] node_modules not found
) else (
    if not exist "node_modules\vite" (
        set NEED_FRONTEND_INSTALL=1
        echo [INFO] vite package missing, reinstalling...
    )
)

if !NEED_FRONTEND_INSTALL! == 1 (
    echo [INSTALL] Installing frontend dependencies...
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Frontend install failed! Check network or run: npm install
        pause
        exit /b 1
    )
    echo [OK] Frontend dependencies installed
) else (
    echo [OK] Frontend dependencies ready
)
echo.

:: ========================================
:: 4. Backend dependencies
:: ========================================
echo [CHECK] Backend dependencies...

set NEED_SERVER_INSTALL=0

if not exist "server\node_modules" (
    set NEED_SERVER_INSTALL=1
    echo [INFO] server\node_modules not found
) else (
    if not exist "server\node_modules\tsx" (
        set NEED_SERVER_INSTALL=1
        echo [INFO] tsx missing, reinstalling server deps...
    ) else (
        if not exist "server\node_modules\express" (
            set NEED_SERVER_INSTALL=1
            echo [INFO] express missing, reinstalling server deps...
        )
    )
)

if !NEED_SERVER_INSTALL! == 1 (
    echo [INSTALL] Installing backend dependencies...
    pushd server
    call npm install
    if %ERRORLEVEL% neq 0 (
        popd
        echo [ERROR] Backend install failed! Check network or run: npm install in server/
        pause
        exit /b 1
    )
    popd
    echo [OK] Backend dependencies installed
) else (
    echo [OK] Backend dependencies ready
)

echo.
echo ========================================
echo   All checks passed. Starting services...
echo ========================================
echo.

:: ========================================
:: 5. Start Backend
:: ========================================
echo [START] Backend (field runtime; PLC and detector acquisition enabled)...
start "Backend - Field Runtime" cmd /k "cd /d ""%~dp0server"" && npm run dev:field"

echo [WAIT] Waiting 5s for backend to initialize...
timeout /t 5 /nobreak >nul

:: ========================================
:: 6. Start Frontend
:: ========================================
echo [START] Frontend (local Vite)...
start "Frontend - Field Runtime" cmd /k "cd /d ""%~dp0"" && set ""VITE_RUNTIME_MODE=field"" && set ""VITE_BACKEND_API_URL=http://127.0.0.1:3003"" && set ""VITE_BACKEND_WS_URL=ws://127.0.0.1:3003"" && npm run dev"

echo.
echo ========================================
echo   Services started successfully!
echo.
echo   Frontend : http://127.0.0.1:3002
echo   Backend  : http://127.0.0.1:3003
echo   Mode     : field (PLC and detector acquisition enabled)
echo ========================================
echo.
echo This window can be closed safely.
echo To stop services, close the Backend / Frontend windows.
echo.
pause >nul
