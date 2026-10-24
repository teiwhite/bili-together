@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Please install Node.js LTS from https://nodejs.org/
  pause
  exit /b 1
)
echo Starting Bili Together website...
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000"
node server.js
pause
