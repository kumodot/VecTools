@echo off
:: VecTools v0.3.0 launcher - starts a local static server and opens the app.
:: ES modules and Web Workers need http://, file:// will not work.
title VecTools v0.3.0
cd /d "%~dp0"
set PORT=8765
echo VecTools v0.3.0  -  http://localhost:%PORT%/VecTools_v0.3.0.html
echo Close this window to stop the server.
start "" "http://localhost:%PORT%/VecTools_v0.3.0.html"
python -m http.server %PORT% --bind 127.0.0.1
if errorlevel 1 (
  echo.
  echo Python was not found. Install Python 3 or run any static server in this folder.
  pause
)
