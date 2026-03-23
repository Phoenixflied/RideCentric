import os, re, json
from datetime import datetime
from pathlib import Path
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
import pdfplumber
import uvicorn

app = FastAPI()

BASE_DIR = Path(__file__).parent
MANIFEST_DIR = BASE_DIR / "manifests"
FRONTEND_DIR = BASE_DIR / "Frontend"
DB_FILE = BASE_DIR / "database.json"
os.makedirs(MANIFEST_DIR, exist_ok=True)

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

def load_db():
    if DB_FILE.exists():
        with open(DB_FILE, "r") as f:
            try: return json.load(f)
            except: return []
    return []

def save_db(data):
    with open(DB_FILE, "w") as f:
        json.dump(data, f, indent=4)

def parse_pdf(path):
    extracted_data = []
    try:
        with pdfplumber.open(path) as pdf:
            for page in pdf.pages:
                text = page.extract_text()
                if not text: continue
                
                # Split by "Account:" to separate each ride record
                blocks = text.split("Account:")
                for block in blocks:
                    if not block.strip(): continue
                    
                    # --- EXTRACTION LOGIC ---
                    # 1. Run Type (Check if Arrival)
                    run_type_match = re.search(r'Run Type:\s*(\w+)', block, re.I)
                    run_type = run_type_match.group(1).upper() if run_type_match else "UNKNOWN"
                    
                    # ONLY PROCESS ARRIVALS (As requested)
                    if run_type != "ARRIVAL":
                        continue

                    # 2. Passenger Name
                    pass_match = re.search(r'Passenger:\s*([^\n]+)', block)
                    passenger = pass_match.group(1).strip() if pass_match else "Unknown"

                    # 3. Pickup Date & Time
                    pickup_match = re.search(r'Pickup:\s*(\d{2}/\d{2}/\d{4})\s*(\d{2}:\d{2})', block)
                    p_date = pickup_match.group(1) if pickup_match else "03/05/2026"
                    p_time = pickup_match.group(2) if pickup_match else "00:00"

                    # 4. Flight Number
                    flight_match = re.search(r'Flight\s*([A-Z0-9\s]+)', block)
                    flight_no = flight_match.group(1).strip() if flight_match else "TBD"

                    # 5. Ride Number
                    ride_match = re.search(r'Ride #:\s*(\d+)', block)
                    ride_no = ride_match.group(1) if ride_match else "N/A"

                    # Format for Database
                    extracted_data.append({
                        "id": f"RIDE-{ride_no}-{datetime.now().timestamp()}",
                        "passenger": passenger,
                        "flight": flight_no,
                        "arrival_time": p_time,
                        "date": datetime.strptime(p_date, "%m/%d/%Y").strftime("%Y-%m-%d"),
                        "run_type": run_type,
                        "ride_no": ride_no,
                        "status": "ARRIVING"
                    })
        print(f"✅ Extracted {len(extracted_data)} ARRIVAL records.")
    except Exception as e:
        print(f"❌ Error: {e}")
    return extracted_data

@app.get("/api/flights")
async def get_flights(date: str = "ALL"):
    db = load_db()
    if date and date != "ALL":
        return [f for f in db if f["date"] == date]
    return db

@app.post("/api/scan_manifests")
async def scan_manifests():
    all_rides = []
    for pdf in list(MANIFEST_DIR.glob("*.pdf")):
        all_rides.extend(parse_pdf(pdf))
    save_db(all_rides)
    return {"added": len(all_rides)}

@app.get("/")
async def root(): return FileResponse(FRONTEND_DIR / "dashboard.html")
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)