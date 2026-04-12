@echo off
REM Local launcher for the ER staff display (Windows).
REM Starts a static HTTP server in this folder and opens the page.

setlocal
cd /d "%~dp0"

if "%PORT%"=="" set PORT=8000
set URL=http://localhost:%PORT%

echo Serving ER staff display at %URL%  (Ctrl+C to stop)
start "" %URL%

where py >nul 2>nul
if %ERRORLEVEL%==0 (
  py -3 -m http.server %PORT%
  goto :eof
)
where python >nul 2>nul
if %ERRORLEVEL%==0 (
  python -m http.server %PORT%
  goto :eof
)
echo Python 3 not found. Install Python or run: npx --yes serve -l %PORT% .
exit /b 1
