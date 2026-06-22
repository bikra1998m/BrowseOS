@echo off
setlocal enabledelayedexpansion
REM BrowserOS offline launcher (Windows) — double-click to run.
REM Auto-installs Python if it's missing, then serves the bundled real Linux.
cd /d "%~dp0"
set PORT=8086
set PYVER=3.12.4

REM ---- 1) Find an existing Python -------------------------------------
set PY=
where python >nul 2>nul && (python --version >nul 2>nul && set PY=python)
if "!PY!"=="" ( where py >nul 2>nul && set PY=py )
if not "!PY!"=="" goto :run

REM ---- 2) Not found: download the official installer ------------------
echo.
echo Python was not found. Downloading the official Python !PYVER! installer...
echo.

set ARCH=amd64
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set ARCH=arm64
set INSTALLER=%TEMP%\python-!PYVER!-!ARCH!.exe
set URL=https://www.python.org/ftp/python/!PYVER!/python-!PYVER!-!ARCH!.exe

REM Prefer curl (built into Windows 10+); fall back to PowerShell.
where curl >nul 2>nul
if !errorlevel!==0 (
  curl -fL -o "!INSTALLER!" "!URL!"
) else (
  powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '!URL!' -OutFile '!INSTALLER!' } catch { exit 1 }"
)
if not exist "!INSTALLER!" (
  echo.
  echo Could not download Python automatically.
  echo Please install it manually from https://www.python.org/downloads/
  echo and check "Add Python to PATH" during setup, then run this file again.
  pause
  exit /b 1
)

REM ---- 3) Install silently, just for this user, add to PATH ----------
echo Installing Python (this may take a minute, no clicks needed)...
"!INSTALLER!" /quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1 Include_test=0
del "!INSTALLER!" >nul 2>nul

REM ---- 4) Re-detect Python (new PATH may not be in this window) ------
set PY=
where python >nul 2>nul && set PY=python
if "!PY!"=="" ( where py >nul 2>nul && set PY=py )
if "!PY!"=="" (
  REM Use the default per-user install location directly.
  set "PYDIR=%LOCALAPPDATA%\Programs\Python\Python312"
  if exist "!PYDIR!\python.exe" set "PY=!PYDIR!\python.exe"
)
if "!PY!"=="" (
  echo.
  echo Python was installed, but this window needs to refresh its PATH.
  echo Please CLOSE this window and double-click run-offline.bat again.
  pause
  exit /b 0
)

:run
echo.
echo BrowserOS is starting at http://localhost:%PORT%  (close this window to stop)
start "" "http://localhost:%PORT%/"
"!PY!" scripts\server.py %PORT% public
pause
