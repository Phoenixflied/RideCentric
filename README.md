# RideCentric LIVE

Flight / ride dispatch dashboard. Python (FastAPI) backend + plain HTML/JS frontend served by the same server.

## Quick start

1. **Get the code:** `git pull` (or `git clone https://github.com/Phoenixflied/RideCentric`).
2. **Add the airline API key.** Copy `.env.example` to `.env` and paste your [AirLabs](https://airlabs.co) key:
   ```
   FLIGHT_API_KEY=your-key-here
   ```
   The key is only read by the server (`live.py`). It is never sent to the browser and `.env` is never committed.
3. **Start it**
   - Windows: double-click `run_dashboard.bat`
   - Mac / Linux:
     ```
     python3 -m pip install -r requirements.txt
     python3 -m uvicorn main:app --port 8000
     ```
4. **Open** <http://localhost:8000/app/login.html>, press **Sign Up** to create the first user, then log in.

Without a key everything still works; the "Live status" row of the flight details card just says *API key not set*.

## Using it

- **Scan PDF** reads the manifest PDFs in the `manifests/` folder and adds their flights.
- **+ Add flight** adds one by hand.
- Click a flight to see its details. With a key set, the card shows live status, ETA, terminal, gate, baggage and aircraft, and a **Track on map** button while the flight is in the air.

## What is not in the repo (on purpose)

These hold private data or secrets and are listed in `.gitignore`. Each machine creates its own:

| File | What it is | If missing |
|---|---|---|
| `.env` | your API key | live status is off |
| `users.json` | login accounts | created when the first user signs up |
| `database.json` | the flight list | starts empty, filled by Scan PDF / Add flight |
| `manifests/*.pdf` | manifest PDFs to scan | folder is kept, add PDFs when needed |

## Files

- `main.py` - API and static file server
- `live.py` - live flight lookup (AirLabs), uses the key from `.env`
- `Frontend/` - `login.html`, `dashboard.html`, `Style.css`, `script.js`
- `airports.json` - airport coordinates

## Troubleshooting

- **Page is unstyled / 404 on `/app/...`:** start the server from this folder (the scripts above do).
- **"Session expired":** the server forgets logins when it restarts; just log in again.
- **Live status says *API error*:** the key is wrong, out of quota, or the AirLabs service is unreachable. The message under the row says which.
