@echo off
title Flame Detector Test Program
cd /d "%~dp0"
if exist "%~dp0FlameDetectorTestProgram.exe" (
    echo Starting portable Flame Detector Test Program...
    start "Flame Detector Test Program" /wait "%~dp0FlameDetectorTestProgram.exe" %*
    exit /b %errorlevel%
)

echo [WARN] Portable EXE is not present. Falling back to source launcher...
node start-test-program.mjs
if errorlevel 1 (
    echo [ERROR] Failed to run start-test-program.mjs
    pause
)
