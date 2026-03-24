import json
import os
import re
import pdfplumber
from datetime import datetime
from fastapi import FastAPI, HTTPException, Query, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional

app = FastAPI(title="RideCentric Dispatch API")

# Serve your frontend from the same backend host
app.mount("/app", StaticFiles(directory="Frontend", html=True), name="dashboard")

# Ensure your frontend can communicate with the backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_FILE = 'database.json'
MANIFEST_DIR = 'manifests'
USERS_FILE = 'users.json'

# Simple in-memory token store (session tokens)
SESSIONS = {}

class FlightEntry(BaseModel):
    id: str
    flight: str
    arrival_time: str
    date: str
    passenger: Optional[str] = "N/A"
    ride_no: str
    terminal: Optional[str] = "TBD"
    gate: Optional[str] = "TBD"
    status: str = "SCHEDULED"
    run_type: str = "ARRIVAL"

class UserCredentials(BaseModel):
    username: str = ""
    password: str = ""

def load_db() -> List[dict]:
    if not os.path.exists(DB_FILE):
        return []
    with open(DB_FILE, 'r') as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            return []

def save_db(data: List[dict]):
    with open(DB_FILE, 'w') as f:
        json.dump(data, f, indent=4)

# user store utilities
def load_users() -> List[dict]:
    if not os.path.exists(USERS_FILE):
        return []
    with open(USERS_FILE, 'r') as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            return []

def save_users(users: List[dict]):
    with open(USERS_FILE, 'w') as f:
        json.dump(users, f, indent=4)

def hash_password(password: str) -> str:
    import hashlib
    return hashlib.sha256(password.encode('utf-8')).hexdigest()

def verify_password(password: str, stored: str) -> bool:
    return hash_password(password) == stored

@app.get("/api/flights")
async def get_flights(date: str = "ALL", token: Optional[str] = Query(None)):
    require_token(token)
    db = load_db()
    if date == "ALL":
        return db
    return [r for r in db if r.get('date') == date]

# authentication helpers

def require_token(token: Optional[str]):
    if not token or token not in SESSIONS:
        raise HTTPException(status_code=401, detail="Invalid or missing auth token")
    return SESSIONS[token]

@app.post('/api/signup')
async def signup(credentials: UserCredentials):
    username = credentials.username.strip()
    password = credentials.password.strip()
    if not username or not password:
        raise HTTPException(status_code=400, detail='Username and password required')
    users = load_users()
    if any(u['username'] == username for u in users):
        raise HTTPException(status_code=400, detail='Username already exists')
    users.append({'username': username, 'password': hash_password(password)})
    save_users(users)
    return {'status': 'success', 'message': 'User created'}

@app.post('/api/login')
async def login(credentials: UserCredentials):
    username = credentials.username.strip()
    password = credentials.password.strip()
    if not username or not password:
        raise HTTPException(status_code=400, detail='Username and password required')
    users = load_users()
    user = next((u for u in users if u['username'] == username), None)
    if not user or not verify_password(password, user['password']):
        raise HTTPException(status_code=401, detail='Invalid username or password')
    token = os.urandom(24).hex()
    SESSIONS[token] = {'username': username, 'iat': datetime.now().isoformat()}
    return {'status': 'success', 'token': token}

@app.post('/signup')
async def signup_alias(credentials: UserCredentials):
    return await signup(credentials)

@app.get('/api/flights')
async def get_flights(date: str = "ALL", token: Optional[str] = Query(None)):
    require_token(token)
    db = load_db()
    if date == "ALL":
        return db
    return [r for r in db if r.get('date') == date]

@app.get('/flights')
async def get_flights_alias(date: str = "ALL", token: Optional[str] = Query(None)):
    return await get_flights(date, token)

@app.post('/api/add_manual')
async def add_manual(entry: FlightEntry, token: Optional[str] = Query(None)):
    require_token(token)
    db = load_db()
    # Check for duplicates
    if any(item['ride_no'] == entry.ride_no and item['date'] == entry.date for item in db):
        raise HTTPException(status_code=400, detail="Flight already exists")
    
    db.append(entry.dict())
    save_db(db)
    return {"status": "success", "added": entry.flight}

@app.post("/api/scan_manifests")
async def scan_manifests(token: Optional[str] = Query(None)):
    require_token(token)
    if not os.path.exists(MANIFEST_DIR):
        os.makedirs(MANIFEST_DIR)
        return {"status": "error", "message": "Manifests folder created. Please add PDFs."}

    db = load_db()
    new_count = 0
    
    for filename in os.listdir(MANIFEST_DIR):
        if filename.endswith(".pdf"):
            path = os.path.join(MANIFEST_DIR, filename)
            with pdfplumber.open(path) as pdf:
                full_text = "".join([page.extract_text() or "" for page in pdf.pages])
                
                # YOUR ORIGINAL PARSING LOGIC (Regex)
                # This matches Ride #, Flight, and Time
                matches = re.findall(r"Ride #:\s*(\d+).*?Flight:\s*([A-Z0-9 ]+).*?Arrival:\s*(\d{2}:\d{2})", full_text, re.S)
                
                for r_no, fl, tm in matches:
                    if not any(x['ride_no'] == r_no for x in db):
                        db.append({
                            "id": f"PDF-{r_no}",
                            "flight": fl.strip(),
                            "arrival_time": tm,
                            "date": datetime.now().strftime("%Y-%m-%d"),
                            "ride_no": r_no,
                            "passenger": "REDACTED",
                            "terminal": "TBD",
                            "gate": "TBD",
                            "status": "ARRIVING",
                            "run_type": "ARRIVAL"
                        })
                        new_count += 1
    
    save_db(db)
    return {"status": "success", "added": new_count}

@app.post('/scan_manifests')
async def scan_manifests_alias(token: Optional[str] = Query(None)):
    return await scan_manifests(token)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)