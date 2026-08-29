@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo   Flame Detector Test Bench - Stop All
echo ========================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-all.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
    echo [ERROR] Some processes could not be stopped.
    echo         Please right-click this file and run as administrator.
) else (
    echo [OK] All project services have been stopped.
)
echo.
pause
exit /b %EXIT_CODE%

