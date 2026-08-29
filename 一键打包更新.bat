@echo off
setlocal
title Flame Detector Bench - One-click Release Build

set "PROJECT_ROOT=%~dp0"
set "PACK_SCRIPT=%PROJECT_ROOT%scripts\update-latest-release.ps1"
set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "NO_PAUSE=0"
if /i "%~1"=="--no-pause" set "NO_PAUSE=1"

if not exist "%PACK_SCRIPT%" (
    echo [ERROR] Packaging script was not found:
    echo %PACK_SCRIPT%
    set "EXIT_CODE=1"
    goto :finish
)

if not exist "%POWERSHELL_EXE%" (
    echo [ERROR] Windows PowerShell was not found:
    echo %POWERSHELL_EXE%
    set "EXIT_CODE=1"
    goto :finish
)

echo ========================================
echo   Flame Detector Bench - Release Build
echo ========================================
echo.

"%POWERSHELL_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%PACK_SCRIPT%"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
    echo [OK] The latest installer is in:
    echo %PROJECT_ROOT%release-latest
) else (
    echo [ERROR] Packaging failed with exit code %EXIT_CODE%.
    echo Fix the error shown above and retry. The previous installer is preserved.
)

:finish
echo.
if "%NO_PAUSE%"=="0" pause
exit /b %EXIT_CODE%
