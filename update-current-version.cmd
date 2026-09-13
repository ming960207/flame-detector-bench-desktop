@echo off
setlocal
cd /d "%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
    echo ERROR: PowerShell is not available.
    pause
    exit /b 1
)

echo Updating the current Git branch from GitHub...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update-current-branch.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
    echo FAILED: Repository update did not complete.
) else (
    echo DONE: Repository update completed successfully.
)

pause
exit /b %EXIT_CODE%
