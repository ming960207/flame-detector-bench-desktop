@echo off
title Flame Detector Test Program - Stop

echo Stopping Test Program processes on port 3004 and 3005...

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3004" ^| findstr "LISTENING"') do (
    echo Killing Backend PID: %%a
    taskkill /f /pid %%a >nul 2>&1
)

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3005" ^| findstr "LISTENING"') do (
    echo Killing Frontend PID: %%a
    taskkill /f /pid %%a >nul 2>&1
)

echo [OK] Test Program stopped.
timeout /t 2 >nul
