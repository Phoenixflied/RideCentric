@echo off
rem RideCentric LIVE - start the server (Windows). Double-click this file.
cd /d "%~dp0"

echo ===================================================
echo  RideCentric LIVE
echo ===================================================

set "PY=py"
where py >nul 2>nul || set "PY=python"

if not exist ".env" (
    if exist ".env.example" copy ".env.example" ".env" >nul
    echo [NOTE] Created .env - open it, paste your FLIGHT_API_KEY after the "=", save, then restart this window.
    echo        The app still runs without a key, live flight status just stays off.
)

echo [1/2] Installing requirements...
%PY% -m pip install -r requirements.txt
if errorlevel 1 (
    echo [ERROR] Could not install the requirements. Check that Python is installed and you are online.
    pause
    exit /b 1
)

echo [2/2] Starting the server on http://localhost:8000 ...
start "" cmd /c "timeout /t 4 >nul & start http://localhost:8000/app/login.html"
%PY% -m uvicorn main:app --port 8000
pause
