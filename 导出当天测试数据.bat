@echo off
chcp 65001 >nul
cd /d "%~dp0"
node scripts\test-log-export.mjs %*
if errorlevel 1 echo Export failed. See the message above.
pause
