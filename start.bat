@echo off
setlocal enableextensions
chcp 65001 > nul

REM ============================================================
REM  Flux Sharp one-click launcher
REM  Uses the project's bundled virtual environment (.venv-sharp)
REM  and starts the local web UI (web_server.py on :8765).
REM ============================================================

cd /d "%~dp0"

set "PYTHON=%~dp0.venv-sharp\Scripts\python.exe"

REM --- Sanity check: the bundled venv must exist --------------------
if not exist "%PYTHON%" (
  echo [error] Bundled virtual environment not found.
  echo         Expected: %PYTHON%
  pause
  exit /b 1
)

echo ============================================================
echo  Flux Sharp  -  bundled interpreter: %PYTHON%
echo  Starting web UI on http://127.0.0.1:8765
echo  Press Ctrl+C in this window to stop the server.
echo ============================================================
echo.

"%PYTHON%" web_server.py

REM Keep the window open if the server exited with an error.
if errorlevel 1 (
  echo.
  echo [error] web_server.py exited with code %errorlevel%.
  pause
)

endlocal
