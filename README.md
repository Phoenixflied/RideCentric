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

- **Upload PDFs** (or drag PDF files onto the flight list): choose the RideCentric *Manifest* reports, for example the monthly `DFW SkyWest.pdf`, `DFW Endeavor.pdf`. The whole month is stored at once, so the manifests do not have to be added day by day. Several files can be chosen together, and loading the same file twice changes nothing.
- **Scan folder** loads any new PDFs in the `manifests/` folder. The server also does this by itself every 5 minutes, so you can simply drop a PDF there.
- **+ Add flight** adds one by hand.
- **Rides are kept.** The whole month stays in the list, past flights included; nothing is deleted automatically. (If you ever want old rides cleaned up, put `PURGE_AFTER_MINUTES=60` in `.env`: each ride is then deleted that many minutes after its arrival.)
- **Route diagram** (under the flight list): pick a flight and a world map shows its route, for example **CDG → MIA**. The plane moves along the arc as the clock runs between the departure and the arrival time, once a second, and follows the ETA when the flight is late. It is an estimate from the schedule, not a GPS position, and it needs no map service or extra API requests. Without a selection it shows the world with the station airport marked.
- **Weather card** (under the flight details): current weather at the arrival airport (and a *Departure* tab) plus the forecast for the hour the flight lands. It comes from [Open-Meteo](https://open-meteo.com/) through the server: free, no key, not counted in the flight API budget, remembered for 30 minutes per airport. Open-Meteo's free service is for non-commercial use; for commercial use see their terms or a paid plan.
- **Next arrival** (top left) counts down to the next flight that has not landed. It turns amber inside 30 minutes and red when the flight is due. Flights due within the hour get a small *in 25m* badge in the list.
- **Timeline** (top right) shows the day's arrivals on a 24-hour line with a NOW marker. Click a dot to open that flight.
- **Dispatch time zone** (drop-down in the top bar): "Today", the clock and the countdowns use this zone, not the computer's. It starts on Dallas / Chicago time and is remembered per browser. Flight times in the list are read as times at that station.
- **CSV** downloads the flights you currently see (after date, search and status filters).
- **Keyboard:** `/` search, `J`/`K` next/previous flight, `N` next arrival, `T` today, `[` `]` previous/next day, `A` add flight, `R` refresh, `E` export CSV, `D` dark mode, `?` help.
- Click a flight to see its details. With a key set, the card shows live status, ETA, terminal, gate, baggage, aircraft and the operating airline, plus *Checked as ...* (the flight code that matched), how old the answer is and a **Refresh now** button.

## How manifests are read

The reader understands the RideCentric Manifest report (one file per airline and airport, a month at a time). Per ride it uses `Pickup:` (date and time), `Ride #`, `Flight`, `Run Type`, `# of Bags` and `Total # of pax`.

- Only **ARRIVAL** rides are kept. Departures and cancelled reservations are skipped. The ride's pickup time is treated as the flight's arrival time at the station (local time, see `STATION_TZ`).
- The airport comes from the start of the file name (`DFW SkyWest.pdf` -> DFW).
- Past rides are loaded too (the data is kept).
- A re-issued manifest with a changed time or flight updates the existing ride; nothing is duplicated.
- Passenger names are not read or stored. Uploaded PDFs are read in memory and not kept; PDFs placed in `manifests/` stay where you put them (and are not read twice).

## Live status and the API key (only used when needed)

- **Only flights arriving today** use the API (today = the station's date, `STATION_TZ`). **Yesterday's and tomorrow's flights never do**: the card says *Scheduled* or *Past flight*, or shows the answer that was saved on the day.
- **Only when you open the flight.** Nothing is requested in the background, when the page loads, or for the route diagram and the weather.
- Answers are **saved** (`live_cache.json`): re-checked at most every 30 min while hours away, every 10 min within 3 h, every 3 min around landing, and **never again** once landed or cancelled. Opening the same flight again costs nothing. What was learned (status, route, times) is also saved on the ride itself, so the next day it is still shown, for free.
- No plane positions are requested: the route diagram works from the departure and arrival times only.
- A **monthly budget** (`LIVE_MONTHLY_BUDGET`, default 1000, 0 = unlimited) stops requests when it is used up; the footer shows `API used/budget`. Saved answers keep being shown.
- **SkyWest, Endeavor and other regional airlines** are found by their IATA code (`OO 5131`), their ICAO code (`SKW5131`) and, when the airport is known, the airline's arrivals board at that airport, which also finds a flight sold under a Delta/American/United/Alaska number. What worked is remembered, so refreshes take one request.
- If a flight still shows *No live data yet*, run `python3 diagnose_flight.py "OO 5131" 2026-11-16 14:20 DFW` on the server. It prints every request it makes and what came back (it uses a few of your requests).

## What is not in the repo (on purpose)

These hold private data or secrets and are listed in `.gitignore`. Each machine creates its own:

| File | What it is | If missing |
|---|---|---|
| `.env` | your API key | live status is off |
| `users.json` | login accounts | created by `add_user.py`; nobody can log in until it exists |
| `database.json` | the stored rides (a month at a time) | starts empty, filled by Upload PDFs / Scan folder / Add flight |
| `manifest_ledger.json` | which PDFs were already loaded, rides deleted so far | recreated; the same PDF may then be loaded again |
| `live_cache.json`, `live_usage.json` | saved live answers and this month's API request count | recreated; the count restarts at 0 |
| `manifests/*.pdf` | manifest PDFs to load | folder is kept, add PDFs when needed |

Optional settings in `.env` (see `.env.example`): `STATION_TZ`, `STATION_AIRPORT`, `PURGE_AFTER_MINUTES` (off by default), `AUTO_SCAN_MINUTES`, `LIVE_MONTHLY_BUDGET`. Run **one** server process (the default); the background thread and the data files assume it.

## Files

- `main.py` - API and static file server
- `add_user.py` - creates / updates a login (sign-up on the website is switched off)
- `manifest.py` - reads the manifest PDFs; `store.py` - keeps the month of rides (and the optional clean-up)
- `live.py` - live flight lookup (AirLabs): today only, saved answers, request budget, regional airline search; `airlines.py` - airline code table
- `weather.py` - airport weather (Open-Meteo); `airports.py` - airport names and coordinates
- `diagnose_flight.py` - shows how one flight is looked up, step by step
- `Frontend/` - `login.html`, `dashboard.html`, `Style.css`, `script.js`, `route.js` (route diagram + weather card), `world.js` (world map outline), `fx.js` (animations), `img/` (logo)
- `airports.json` - airport names and coordinates (Natural Earth, public domain); `Frontend/world.js` is from the same source

## Troubleshooting

- **Page is unstyled / 404 on `/app/...`:** start the server from this folder (the scripts above do).
- **"Session expired":** the server forgets logins when it restarts; just log in again.
- **Status says *Scheduled* or *Past flight*:** live status is only requested for flights arriving today. **API budget used:** the month's `LIVE_MONTHLY_BUDGET` is spent.
- **The route diagram only shows the arrival airport:** the route is learned when a flight arriving today is opened and the flight service reports its departure airport. Other days show it only if it was saved on the day.
- **A manifest PDF says "No rides were found":** it is probably not the RideCentric *Manifest* report, or it is a scan (a picture). Export it again as PDF.
- **Live status says *API error*:** the key is wrong, out of quota, or the AirLabs service is unreachable. The message under the row says which.
- **"Sign-up is turned off":** by design. Create the account with `add_user.py`. Only if you really want open self-registration, put `ALLOW_SIGNUP=1` in `.env` and restart.
- **Animations:** they are skipped automatically when the system's *reduce motion* setting is on.
