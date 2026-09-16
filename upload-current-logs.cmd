@echo off
setlocal
cd /d "%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
    echo ERROR: PowerShell is not available.
    pause
    exit /b 1
)

echo Uploading current diagnostic logs to GitHub...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\upload-current-logs.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
    echo FAILED: Log upload did not complete.
) else (
    echo DONE: Log upload completed successfully.
)

pause
exit /b %EXIT_CODE%
