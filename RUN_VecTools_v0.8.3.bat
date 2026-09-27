@echo off
:: VecTools v0.8.3 launcher - starts a local static server and opens the app.
:: ES modules and Web Workers need http://, file:// will not work.
:: serve.py disables browser caching so an update never runs with stale modules.
title VecTools v0.8.3
cd /d "%~dp0"
set PORT=8765
echo VecTools v0.8.3  -  http://localhost:%PORT%/VecTools_v0.8.3.html
echo Close this window to stop the server.
start "" "http://localhost:%PORT%/VecTools_v0.8.3.html"
python serve.py %PORT%
if errorlevel 1 (
  echo.
  echo Python was not found. Install Python 3 or run any static server in this folder.
  pause
)
