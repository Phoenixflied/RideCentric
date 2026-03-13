@echo off
echo ===================================================
echo [SYSTEM] Starting RideCentric Command Center...
echo ===================================================

cd backend
py -m pip install fastapi uvicorn pdfplumber pydantic

start "Backend API" cmd /k "py -m uvicorn main:app --reload --port 8000"

cd ../frontend
start "Frontend UI" cmd /k "py -m http.server 5500"

echo [OK] System Live. 
echo Access: http://localhost:5500/login.html
pause