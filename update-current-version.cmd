@echo off
setlocal
cd /d "%~dp0"

where powershell.exe >nul 2>nul
if errorlevel 1 (
    echo ERROR: PowerShell is not available.
    pause
    exit /b 1
)

echo Updating the current Git branch from the configured release source...
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update-current-branch.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
    echo FAILED: Repository update did not complete.
) else (
    echo DONE: Repository update completed successfully.
)

pause
exit /b %EXIT_CODE%
