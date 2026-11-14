# RideCentric LIVE

Flight / ride dispatch dashboard. Python (FastAPI) backend + plain HTML/JS frontend served by the same server.

## Quick start

1. **Get the code:** `git pull` (or `git clone https://github.com/Phoenixflied/RideCentric`).
2. **Add the airline API key.** Copy `.env.example` to `.env` and paste your [AirLabs](https://airlabs.co) key:
   ```
   FLIGHT_API_KEY=your-key-here
   ```
   The key is only read by the server (`live.py`). It is never sent to the browser and `.env` is never committed.
3. **Create a login.** There is no sign-up on the website (login only), so accounts are made on the server:
   ```
   python3 add_user.py          (Windows: py add_user.py)
   ```
   It asks for a username and password and saves them (hashed) in `users.json`. Run it again for more people, or with an existing name to change that person's password. `python3 add_user.py --list` shows who has an account.
   `run_dashboard.bat` does this step for you the first time.
4. **Start it**
   - Windows: double-click `run_dashboard.bat`
   - Mac / Linux:
     ```
     python3 -m pip install -r requirements.txt
     python3 -m uvicorn main:app --port 8000
     ```
5. **Open** <http://localhost:8000/app/login.html> and log in.

Without a key everything still works; the "Live status" row of the flight details card just says *API key not set*.

## Using it

- **Scan PDF** reads the manifest PDFs in the `manifests/` folder and adds their flights.
- **+ Add flight** adds one by hand.
- **Next arrival** (top left) counts down to the next flight that has not landed. It turns amber inside 30 minutes and red when the flight is due. Flights due within the hour get a small *in 25m* badge in the list.
- **Timeline** (top right) shows the day's arrivals on a 24-hour line with a NOW marker. Click a dot to open that flight.
- **Dispatch time zone** (drop-down in the top bar): "Today", the clock and the countdowns use this zone, not the computer's. It starts on Miami / New York time and is remembered per browser. Flight times in the list are read as times at that station.
- **CSV** downloads the flights you currently see (after date, search and status filters).
- **Keyboard:** `/` search, `J`/`K` next/previous flight, `N` next arrival, `T` today, `[` `]` previous/next day, `A` add flight, `R` refresh, `E` export CSV, `D` dark mode, `?` help.
- Click a flight to see its details. With a key set, the card shows live status, ETA, terminal, gate, baggage and aircraft, and a **Track on map** button while the flight is in the air.

## What is not in the repo (on purpose)

These hold private data or secrets and are listed in `.gitignore`. Each machine creates its own:

| File | What it is | If missing |
|---|---|---|
| `.env` | your API key | live status is off |
| `users.json` | login accounts | created by `add_user.py`; nobody can log in until it exists |
| `database.json` | the flight list | starts empty, filled by Scan PDF / Add flight |
| `manifests/*.pdf` | manifest PDFs to scan | folder is kept, add PDFs when needed |

## Files

- `main.py` - API and static file server
- `add_user.py` - creates / updates a login (sign-up on the website is switched off)
- `live.py` - live flight lookup (AirLabs), uses the key from `.env`
- `Frontend/` - `login.html`, `dashboard.html`, `Style.css`, `script.js`, `fx.js` (animations), `img/` (logo)
- `airports.json` - airport coordinates

## Troubleshooting

- **Page is unstyled / 404 on `/app/...`:** start the server from this folder (the scripts above do).
- **"Session expired":** the server forgets logins when it restarts; just log in again.
- **Live status says *API error*:** the key is wrong, out of quota, or the AirLabs service is unreachable. The message under the row says which.
- **"Sign-up is turned off":** by design. Create the account with `add_user.py`. Only if you really want open self-registration, put `ALLOW_SIGNUP=1` in `.env` and restart.
- **Animations:** they are skipped automatically when the system's *reduce motion* setting is on.
