import os
import json
import time
import re
from datetime import datetime
from pathlib import Path
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import pdfplumber

# ----------------------
# FastAPI app
# ----------------------
app = FastAPI()

FRONTEND_DIR = "./frontend"
MANIFEST_DIR = "./manifests"
DB_FILE = "./database.json"

app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ----------------------
# Flight stations
# ----------------------
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
            if not text.strip():
                print("⚠ PDF has no text to extract.")
                return arrivals

            blocks = text.split("Ride Info")
            for block in blocks:
                if "Run Type: ARRIVAL" in block:
                    p = re.search(r"Passenger\s*:\s*(.*)", block)
                    f = re.search(r"Flight\s*[:\s]+([A-Z0-9]+)", block)
                    st = next((code for name, code in STATIONS.items() if name in block), "TBA")

                    arrivals.append({
                        "id": str(time.time()),
                        "flight": f.group(1).strip() if f else "TBA",
                        "passenger": p.group(1).strip() if p else "Unknown",
                        "station": st,
                        "status": "AWAITING RADAR",
                        "eta": None,
                        "terminal": "TBA",
                        "gate": "TBA",
                        "baggage": "TBA",
                        "map_url": "#",
                        "date": datetime.now().strftime("%m/%d/%Y")
                    })
    except Exception as e:
        print(f"Error reading PDF {path}: {e}")

    return arrivals

# ----------------------
# API Endpoints
# ----------------------
@app.get("/api/flights")
def get_flights(date: str = Query(default="ALL")):
    if os.path.exists(DB_FILE):
        with open(DB_FILE, "r") as f:
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

@app.post("/api/scan_manifests")
def scan_manifests():
    all_flights = []
    if not os.path.exists(MANIFEST_DIR):
        return {"status": "error", "message": "Manifests folder not found"}

    for pdf_path in Path(MANIFEST_DIR).glob("*.pdf"):
        flights = scan_pdf(str(pdf_path))
        if flights:
            all_flights.extend(flights)

    with open(DB_FILE, "w") as f:
        json.dump(all_flights, f, indent=4)

    return {"status": "ok", "flights_found": len(all_flights)}

# ----------------------
# Run uvicorn
# ----------------------
if __name__ == "__main__":
    import uvicorn
    os.makedirs(FRONTEND_DIR, exist_ok=True)
    os.makedirs(MANIFEST_DIR, exist_ok=True)
    uvicorn.run(app, host="127.0.0.1", port=8000, reload=True)