@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0rollback-last-update.ps1" %*
