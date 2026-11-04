@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] node not found, install Node.js 18+
    pause
    exit /b 1
)

node control.js start
node control.js status
pause
