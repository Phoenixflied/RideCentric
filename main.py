import asyncio
import json
import os
import sys
from datetime import datetime
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(BASE_DIR)  # data files, manifests/ and Frontend/ are found next to main.py wherever the server is started from
sys.path.insert(0, BASE_DIR)

import live  # noqa: E402  (live flight lookup; reads FLIGHT_API_KEY from .env)
live.load_env(os.path.join(BASE_DIR, ".env"))
import airports  # noqa: E402  (airport names and coordinates)
import manifest  # noqa: E402  (reads the RideCentric manifest PDFs)
import store  # noqa: E402  (keeps the month of rides)
import weather  # noqa: E402  (airport weather for the weather card)

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
    airport: Optional[str] = None
    pax: Optional[int] = None
    bags: Optional[int] = None
    source: Optional[str] = None

class UserCredentials(BaseModel):
    username: str = ""
    password: str = ""

def load_db() -> List[dict]:
    return store.load_db()

def save_db(data: List[dict]):
    store.save_db(data)

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

# authentication helpers

def require_token(token: Optional[str]):
    if not token or token not in SESSIONS:
        raise HTTPException(status_code=401, detail="Invalid or missing auth token")
    return SESSIONS[token]

def signup_allowed() -> bool:
    # Sign-up is OFF unless the server's .env contains ALLOW_SIGNUP=1. Accounts are normally created
    # with `python add_user.py` (see README), so strangers cannot register themselves.
    return (os.environ.get('ALLOW_SIGNUP') or '').strip().lower() in ('1', 'true', 'yes')

@app.post('/api/signup')
async def signup(credentials: UserCredentials):
    if not signup_allowed():
        raise HTTPException(status_code=403, detail='Sign-up is turned off. Ask an administrator for an account.')
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
    return {'status': 'success', 'token': token, 'username': username}

@app.post('/signup')
async def signup_alias(credentials: UserCredentials):
    return await signup(credentials)

@app.get('/api/flights')
async def get_flights(date: str = "ALL", token: Optional[str] = Query(None)):
    require_token(token)
    store.purge_if_due()  # rides whose time is over are removed before the list is sent
    db = load_db()
    if date == "ALL":
        return db
    return [r for r in db if r.get('date') == date]

@app.get('/flights')
async def get_flights_alias(date: str = "ALL", token: Optional[str] = Query(None)):
    return await get_flights(date, token)

def _flag(value) -> bool:
    return str(value or "").strip().lower() in ("1", "true", "yes")

@app.get('/api/live')
def live_flight(flight: str, date: Optional[str] = None, time: Optional[str] = None, airport: Optional[str] = None,
                force: Optional[str] = None, token: Optional[str] = Query(None)):
    """Live status of one flight. Looked up here so the airline API key never reaches the browser.
    The flight service is only asked for flights arriving today, and only when somebody opens the flight: other days get
    what was saved on the day. Answers come from the saved copy while it is still fresh.
    (A plain `def` on purpose: FastAPI runs it in a worker thread, so the web request to AirLabs does not block the server.)"""
    require_token(token)
    return live.lookup(flight, date, time, airport, force=_flag(force))

@app.get('/api/airports')
def airport_list(token: Optional[str] = Query(None)):
    """Names and coordinates of the airports the route diagram can draw."""
    require_token(token)
    return airports.all_airports()

@app.get('/api/weather')
def airport_weather(airport: str, at: Optional[str] = None, token: Optional[str] = Query(None)):
    """Weather at an airport now and (if `at`, a Unix time, is given) at the hour a flight lands. Free service, no key."""
    require_token(token)
    try:
        when = int(float(at)) if at else None
    except ValueError:
        when = None
    return weather.get(airport, when)

@app.get('/api/status')
def system_status(token: Optional[str] = Query(None)):
    """Numbers for the dashboard's storage chip: rides kept and API requests used this month."""
    require_token(token)
    out = store.summary()
    out["live"] = dict(live.usage(), configured=bool(live.api_key()), rule="today", today=live.today_str())
    code = (os.environ.get("STATION_AIRPORT") or "").strip().upper()[:3]
    out["station_airport"] = code if airports.get(code) else None   # the airport the weather card shows when no flight is selected
    return out

@app.post('/api/add_manual')
async def add_manual(entry: FlightEntry, token: Optional[str] = Query(None)):
    require_token(token)
    with store.lock:
        db = load_db()
        # Check for duplicates
        if any(item.get('ride_no') == entry.ride_no and item.get('date') == entry.date for item in db):
            raise HTTPException(status_code=400, detail="Flight already exists")
        db.append(entry.dict())
        save_db(db)
    return {"status": "success", "added": entry.flight}

MAX_UPLOAD = manifest.MAX_PDF_BYTES

@app.post("/api/upload_manifest")
async def upload_manifest(request: Request, name: str = "manifest.pdf", token: Optional[str] = Query(None)):
    """Loads one manifest PDF (sent as the raw request body). A whole month in one file is stored at once;
    uploading the same file again changes nothing."""
    require_token(token)
    try:
        declared = int(request.headers.get("content-length") or 0)
    except ValueError:
        declared = 0
    if declared > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail="That PDF is too large (limit 25 MB).")
    body = await request.body()
    if len(body) > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail="That PDF is too large (limit 25 MB).")
    clean = "".join(c for c in os.path.basename(name or "") if c.isprintable())[:120] or "manifest.pdf"
    try:
        result = await asyncio.get_running_loop().run_in_executor(None, store.load_manifest_bytes, body, clean)
    except manifest.ManifestError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"status": "success", **result}

@app.post("/api/scan_manifests")
async def scan_manifests(token: Optional[str] = Query(None)):
    """Loads every new PDF found in the manifests/ folder (the same thing the server does by itself every few minutes)."""
    require_token(token)
    res = await asyncio.get_running_loop().run_in_executor(None, store.scan_folder)
    if res["errors"] and not (res["files"] or res["already"]):
        return {"status": "error", "message": res["errors"][0], **res}
    return {"status": "success", **res}

@app.post('/scan_manifests')
async def scan_manifests_alias(token: Optional[str] = Query(None)):
    return await scan_manifests(token)

# Clean up now, then keep cleaning (and watching manifests/ for new PDFs) in the background.
store.purge()
if os.environ.get("RIDECENTRIC_NO_BACKGROUND") != "1":
    store.start_background()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
