@echo off
setlocal

REM Enter script directory (so serve.ps1 / index.html / CSV are found)
cd /d "%~dp0"

REM Change port if needed
set "PORT=5173"
set "AGENT_FLAG="
if /i "%NO_AGENT%"=="1" set "AGENT_FLAG=-NoAgent"

echo.
echo [VPP Dashboard] Starting server...
echo Root: %cd%
echo Port: %PORT%
echo.

REM Clean previous port file
if exist "serve.port" del /f /q "serve.port" >nul 2>nul

REM Open browser after server picks an available port (writes serve.port). Timeout ~12s.
powershell -NoProfile -Command ^
  "$p=Join-Path (Get-Location) 'serve.port'; for($i=0;$i -lt 60;$i++){ if(Test-Path $p){ $port=(Get-Content $p -TotalCount 1).Trim(); if($port){ Start-Process ('http://127.0.0.1:'+$port+'/') }; break }; Start-Sleep -Milliseconds 200 }"

powershell -NoProfile -ExecutionPolicy Bypass -File ".\serve.ps1" -Port %PORT% %AGENT_FLAG%

echo.
echo [VPP Dashboard] Server stopped. If it failed to start, open serve.log for details.
echo.
pause

endlocal

