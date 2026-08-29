@echo off
title Flame Detector Test Program
cd /d "%~dp0测试程序-PLC与数据状态监听"
node start-test-program.mjs
if errorlevel 1 (
    echo [ERROR] Failed to run start-test-program.mjs
    pause
)
