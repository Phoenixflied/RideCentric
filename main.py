import os
import json
import time
import re
from datetime import datetime
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import pdfplumber

# ----------------------
# FastAPI app
# ----------------------
app = FastAPI()

app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")
# ⚡ Full CORS setup (in case you fetch from other origins in future)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # allow all origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ----------------------
# Directories and DB
# ----------------------
MANIFEST_DIR = "./manifests"
DB_FILE = "database.json"
FRONTEND_DIR = "./frontend"  # put your dashboard.html, script.js, CSS here

STATIONS = {
    "Miami International": "MIA",
    "San Francisco": "SFO",
    "Dallas": "DFW"
}

# ----------------------
# PDF Scan Function
# ----------------------
def scan_pdf(path):
    print(f"🚀 Scanning Manifest: {path}")
    arrivals = []
    try:
        with pdfplumber.open(path) as pdf:
            text = "\n".join([p.extract_text() for p in pdf.pages if p.extract_text()])
            blocks = text.split("Ride Info")

            for block in blocks:
                if "Run Type: ARRIVAL" in block:
                    p = re.search(r"Passenger:\s*(.*)", block)
                    f = re.search(r"Flight\s+([A-Z0-9\s]+)", block)
                    st = next((code for name, code in STATIONS.items() if name in block), "TBA")

                    arrivals.append({
                        "id": str(time.time()),
                        "flight": f.group(1).replace(" ", "") if f else "TBA",
                        "passenger": p.group(1).strip() if p else "Unknown",
                        "station": st,
                        "status": "AWAITING RADAR",
                        "eta": None,
                        "terminal": "TBA",
                        "gate": "TBA",
                        "baggage": "TBA",
                        "map_url": "#",
                        "date": datetime.now().strftime("%m/%d/%Y")  # dynamic date
                    })
    except Exception as e:
        print(f"Error reading PDF: {e}")
    return arrivals

# ----------------------
# Watchdog Handler
# ----------------------
class Handler(FileSystemEventHandler):
    def on_created(self, event):
        if event.src_path.lower().endswith(".pdf"):
            time.sleep(1)
            data = scan_pdf(event.src_path)
            if data:
                if os.path.exists(DB_FILE):
                    with open(DB_FILE, 'r+') as f:
                        try:
                            db = json.load(f)
                        except json.JSONDecodeError:
                            db = []
                        db.extend(data)
                        f.seek(0)
                        json.dump(db, f, indent=4)
                        f.truncate()
                else:
                    with open(DB_FILE, 'w') as f:
                        json.dump(data, f, indent=4)

# ----------------------
# Startup Event
# ----------------------
@app.on_event("startup")
def startup():
    if not os.path.exists(MANIFEST_DIR):
        os.makedirs(MANIFEST_DIR)
    if not os.path.exists(DB_FILE):
        with open(DB_FILE, 'w') as f:
            json.dump([], f)

    # Start watchdog
    observer = Observer()
    observer.schedule(Handler(), MANIFEST_DIR, recursive=False)
    observer.start()
    print("System Active: Watchdog listening for incoming PDF manifests...")

# ----------------------
# API Endpoints
# ----------------------
@app.get("/api/flights")
def get_flights(date: str = Query(default="ALL")):
    # Load database
    if os.path.exists("database.json"):
        with open("database.json", "r") as f:
            try:
                db = json.load(f)
            except:
                db = []
    else:
        db = []

    result = {}
    if date == "ALL":
        for flight in db:
            result.setdefault(flight['station'], []).append(flight)
    else:
        for flight in db:
            if flight.get("date") == date:
                result.setdefault(flight['station'], []).append(flight)

    return result

@app.post("/api/flights/verify")
def verify_flight(flight: dict):
    if os.path.exists(DB_FILE):
        with open(DB_FILE, 'r+') as f:
            try:
                db = json.load(f)
            except json.JSONDecodeError:
                db = []
            flight['id'] = str(time.time())
            db.append(flight)
            f.seek(0)
            json.dump(db, f, indent=4)
            f.truncate()
    else:
        with open(DB_FILE, 'w') as f:
            flight['id'] = str(time.time())
            json.dump([flight], f, indent=4)
    return {"status": "ok", "flight": flight}

@app.delete("/api/flights/{date}/{flight_id}")
def delete_flight(date: str, flight_id: str):
    if not os.path.exists(DB_FILE):
        return {"status": "error", "message": "Database not found"}
    with open(DB_FILE, 'r+') as f:
        try:
            db = json.load(f)
        except json.JSONDecodeError:
            db = []
        db = [f for f in db if f['id'] != flight_id or (date != "ALL" and f.get('date') != date)]
        f.seek(0)
        json.dump(db, f, indent=4)
        f.truncate()
    return {"status": "ok"}

# ----------------------
# Serve Frontend
# ----------------------
if not os.path.exists(FRONTEND_DIR):
    os.makedirs(FRONTEND_DIR)  # create folder if missing

app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

# ----------------------
# Run uvicorn
# ----------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000, reload=True)