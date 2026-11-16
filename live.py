"""Live flight status through AirLabs (https://airlabs.co), built to spend as few API calls as possible.

Standard library only. The API key is read from FLIGHT_API_KEY (the .env file next to main.py). It is only used
here on the server: it never reaches the browser and never appears in anything lookup() returns.

When the API is used (and when it is not)
  * ONLY for flights arriving TODAY (station time, STATION_TZ). Yesterday's and tomorrow's flights never cost a request.
    What was learned on the day (status, route, times) is saved on the ride and shown afterwards for free.
  * ONLY when somebody opens the flight: nothing runs in the background.
  * Answers are remembered (live_cache.json): re-checked at most every 30 min while hours away, every 10 min
    within 3 h, every 3 min around landing, and never again once the flight has landed or been cancelled.
    "Refresh now" is limited to once per 2 minutes per flight.
  * A request counter (live_usage.json) enforces LIVE_MONTHLY_BUDGET (default 1000, 0 = unlimited).
  * No map positions are requested: the route diagram works from the departure and arrival times alone.

How regional flights (SkyWest "OO"/SKW, Endeavor "9E"/EDV, Republic, Envoy, PSA ...) are found
  The flight is asked for under its IATA code (OO5131), its ICAO code (SKW5131) and, when the airport is known,
  from that airline's arrivals board at the airport (also matching the Delta/American/United/Alaska number the
  flight is sold under). Boards are shared: one request serves every flight of that airline. Whatever worked is
  remembered, so refreshes use a single request.
"""
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict

import airlines
import store

API_BASE = "https://airlabs.co/api/v9"
TIMEOUT = 8  # seconds

CACHE_FILE = "live_cache.json"
USAGE_FILE = "live_usage.json"

# re-check intervals (seconds)
TTL_FAR, TTL_MID, TTL_NEAR, TTL_OVERDUE, TTL_NODATA = 1800, 600, 180, 900, 1200
FORCE_MIN = 120      # the "Refresh now" button works at most this often per flight
BOARD_TTL = 600
DELAY_MIN = 5        # minutes of lateness before a flight is called "Delayed"


class LiveError(Exception):
    """A problem talking to AirLabs. The message is short and never contains the API key."""


class BudgetError(LiveError):
    pass


# --------------------------------------------------------------------------- settings / key

def load_env(path):
    """Read KEY=VALUE lines from a .env file into os.environ. Real environment variables win."""
    try:
        with open(path, encoding="utf-8-sig") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                if key.lower().startswith("export "):
                    key = key[7:].strip()
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                if key and not os.environ.get(key):
                    os.environ[key] = value
    except OSError:
        pass  # no .env file: live status simply stays off


def api_key():
    key = (os.environ.get("FLIGHT_API_KEY") or "").strip()
    if key.lower().startswith("your") or key.lower() in ("none", "null", "changeme"):
        return ""  # an unedited placeholder counts as "not set"
    return key


def _env_int(name, default):
    try:
        return int((os.environ.get(name) or "").strip())
    except ValueError:
        return default


def monthly_budget():
    return max(0, _env_int("LIVE_MONTHLY_BUDGET", 1000))


def max_tries():
    return max(1, min(8, _env_int("LIVE_MAX_TRIES", 4)))


def fetch_json(endpoint, **params):
    """GET one AirLabs endpoint and return its parsed JSON."""
    params["api_key"] = api_key()
    url = f"{API_BASE}/{endpoint}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "RideCentric/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise LiveError(f"AirLabs returned HTTP {e.code}") from None
    except (urllib.error.URLError, OSError):
        raise LiveError("AirLabs could not be reached") from None
    except ValueError:
        raise LiveError("AirLabs sent an unreadable reply") from None
    if isinstance(data, dict) and data.get("error"):
        err = data["error"]
        msg = err.get("message") if isinstance(err, dict) else str(err)
        raise LiveError(f"AirLabs: {msg}"[:140])
    return data


# --------------------------------------------------------------------------- flight codes

def clean_flight(code):
    """'af 94' -> 'AF94'"""
    return re.sub(r"[^A-Z0-9]", "", str(code or "").upper())


_CODE = re.compile(r"^(?:([A-Z]{3})|([A-Z0-9]{2}))0*(\d{1,4})$")


def split_code(flight):
    """'OO 5131' / 'SKW5131' / 'CX0870' -> (airline_iata, airline_icao, number) or None.
    The leading zeros of the number are dropped ('CX0870' -> CX, CPA, '870')."""
    m = _CODE.match(clean_flight(flight))
    if not m:
        return None
    a3, a2, num = m.group(1), m.group(2), m.group(3)
    if a3:
        iata = airlines.iata_of(a3)
        return (iata, a3, num) if iata else (None, a3, num)
    return a2, airlines.icao_of(a2), num


# --------------------------------------------------------------------------- state: cache + usage

_lock = threading.RLock()
_key_locks = defaultdict(threading.Lock)
_boards = {}      # (airline, airport) -> (fetched_ts, entries)   (memory only)


def _read(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _write(path, data):
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def _month(now):
    return time.strftime("%Y-%m", time.localtime(now))


def usage(now=None):
    now = time.time() if now is None else now
    with _lock:
        u = _read(USAGE_FILE, {})
        if not isinstance(u, dict) or u.get("month") != _month(now):
            u = {"month": _month(now), "calls": 0}
        budget = monthly_budget()
        return {"month": u["month"], "calls": int(u.get("calls", 0)), "budget": budget,
                "remaining": max(0, budget - int(u.get("calls", 0))) if budget else None}


def _spend(now):
    """Counts one API request. Raises BudgetError when this month's budget is used up."""
    with _lock:
        u = usage(now)
        if u["budget"] and u["calls"] >= u["budget"]:
            raise BudgetError("This month's API budget is used up")
        _write(USAGE_FILE, {"month": u["month"], "calls": u["calls"] + 1})


def _load_cache():
    c = _read(CACHE_FILE, {})
    return c if isinstance(c, dict) else {}


def _save_cache(cache, now):
    cutoff = now - 3 * 86400
    keep = {k: v for k, v in cache.items() if isinstance(v, dict) and v.get("fetched", 0) >= cutoff}
    _write(CACHE_FILE, keep)


def _ttl(entry, ride_ts, now):
    """Seconds this saved answer stays fresh; None = for good (landed / cancelled)."""
    if entry.get("final"):
        return None
    if entry["result"].get("status") == "No live data yet":
        return TTL_NODATA
    arrival = entry.get("arr_ts") or ride_ts or now
    until = arrival - now
    if until > 3 * 3600:
        return TTL_FAR
    if until > 3600:
        return TTL_MID
    if until > -1800:
        return TTL_NEAR
    return TTL_OVERDUE


# --------------------------------------------------------------------------- reading AirLabs answers

def _text(value):
    value = str(value).strip() if value is not None else ""
    return value or None


def _clock(stamp):
    """'2026-03-05 14:20' -> '14:20'"""
    stamp = str(stamp or "")
    return stamp.split(" ")[1][:5] if " " in stamp else None


def _int(value, default=None):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _ts(entry, base):
    """Unix time of arr_time / arr_estimated / arr_actual (uses the _ts field, else the local text at the station)."""
    v = _int(entry.get(base + "_ts"))
    if v:
        return v
    text = str(entry.get(base) or "")
    if " " in text:
        d, t = text.split(" ", 1)
        return store.local_epoch(d, t[:5])
    return None


def _entries(data):
    resp = data.get("response") if isinstance(data, dict) else None
    return [e for e in resp if isinstance(e, dict)] if isinstance(resp, list) else []


def _pick_leg(cands, ride_ts, airport):
    """Several legs/days of a flight can come back: take the one arriving closest to the ride (and at its airport)."""
    if not cands:
        return None
    if airport:
        here = [e for e in cands if str(e.get("arr_iata") or "").upper() == airport]
        cands = here or cands
    if ride_ts is None:
        return cands[0]

    def gap(e):
        t = _ts(e, "arr_time") or _ts(e, "arr_estimated") or _ts(e, "arr_actual")
        return abs(t - ride_ts) if t else 10 ** 9

    best = min(cands, key=gap)
    return best if gap(best) <= 14 * 3600 else None  # another day's flight is not this ride


def _pair(code):
    """'oo 5131' / 'OO05131' -> 'OO5131' (airline + number without leading zeros), or None."""
    p = split_code(code)
    return f"{p[0]}{p[2]}" if p and p[0] else None


def _matches(entry, pair):
    """Does a board entry belong to the wanted flight? (its own number, or the number it is sold under)"""
    if pair in (_pair(entry.get("flight_iata")), _pair(entry.get("cs_flight_iata"))):
        return True
    for a_key, n_key in (("airline_iata", "flight_number"), ("cs_airline_iata", "cs_flight_number")):
        a, n = str(entry.get(a_key) or "").upper(), re.sub(r"^0+", "", str(entry.get(n_key) or ""))
        if a and n and a + n == pair:
            return True
    return False


def _status(entry, sched_ts, est_ts):
    raw = str(entry.get("status") or "").lower()
    delay = _int(entry.get("arr_delayed"))
    if delay is None and est_ts and sched_ts:
        delay = round((est_ts - sched_ts) / 60)
    if delay is None:
        delay = _int(entry.get("delayed"), 0)  # deprecated field, only as a last resort
    delay = max(0, delay or 0)
    if raw == "cancelled":
        return "Cancelled", 0, True
    if raw == "landed":
        return "Landed", delay, True
    if delay >= DELAY_MIN:
        return f"Delayed {delay}m", delay, False
    if raw == "active":
        return "In Air", 0, False
    return "On Time", 0, False


# --------------------------------------------------------------------------- the lookup

def _base(code):
    return {"flight": code, "configured": True, "status": "Not found", "delay_minutes": 0, "eta": None, "arrived": None,
            "terminal": None, "gate": None, "baggage": None, "aircraft": None, "detail": None, "route": None,
            "checked_as": None, "tried": [], "cached": False, "age_s": 0, "not_today": False, "saved": False,
            "operator": None}


SAVED_KEYS = ("status", "delay_minutes", "eta", "arrived", "terminal", "gate", "baggage", "aircraft", "operator", "checked_as", "route")


def _plan(parsed, airport):
    """Every way to ask for this flight, cheapest/likeliest first: [(label, kind, params, airline)]."""
    iata, icao, num = parsed
    steps = []
    if iata:
        steps.append((f"{iata}{num}", "direct", {"flight_iata": f"{iata}{num}"}, None))
    if icao:
        steps.append((f"{icao}{num}", "direct", {"flight_icao": f"{icao}{num}"}, None))
    if iata and airport:
        partners = airlines.PARTNER_OPERATORS.get(iata, [])
        order = ([*partners, iata] if int(num) >= 3000 else [iata, *partners])  # high numbers are usually regional flights
        for a in dict.fromkeys(order):
            steps.append((f"{a} arrivals at {airport}", "board", {"airline_iata": a, "arr_iata": airport}, a))
    return steps


def _resolve(call, parsed, ride_ts, airport, known, now):
    """Finds the flight. Returns (entry, label) or (None, None); also the list of what was tried."""
    iata, icao, num = parsed
    pair = f"{iata}{num}" if iata else None
    tried, spent = [], 0
    steps = _plan(parsed, airport)
    if known:  # this flight was found before: ask for exactly that first
        kind = "flight_icao" if re.match(r"^[A-Z]{3}\d", known) else "flight_iata"
        steps.insert(0, (known, "direct", {kind: known}, None))
    seen = set()
    for label, kind, params, airline in steps:
        sig = tuple(sorted(params.items()))
        if sig in seen:
            continue
        seen.add(sig)
        if kind == "board":
            hit = _boards.get((airline, airport))
            if hit and now - hit[0] < BOARD_TTL:
                entries, fresh = hit[1], False
            else:
                if spent >= max_tries():
                    break
                spent += 1
                tried.append(label)
                entries, fresh = _entries(call("schedules", **params)), True
                _boards[(airline, airport)] = (now, entries)
            cands = [e for e in entries if _matches(e, pair)]
            if not fresh:
                tried.append(label + " (saved)")
        else:
            if spent >= max_tries():
                break
            spent += 1
            tried.append(label)
            cands = _entries(call("schedules", **params))
        leg = _pick_leg(cands, ride_ts, airport)
        if leg:
            ident = clean_flight(leg.get("flight_iata") or leg.get("flight_icao") or label)
            return leg, ident, tried
    return None, None, tried


def _finish(out, entry, ident):
    sched, est, act = _ts(entry, "arr_time"), _ts(entry, "arr_estimated"), _ts(entry, "arr_actual")
    status, delay, final = _status(entry, sched, est)
    arrival = act or est or sched
    dep = _ts(entry, "dep_actual") or _ts(entry, "dep_estimated") or _ts(entry, "dep_time")
    duration = _int(entry.get("duration"))
    if not dep and duration and arrival:
        dep = arrival - duration * 60       # no departure time: work it back from the flight's duration
    origin, dest = _text(entry.get("dep_iata")), _text(entry.get("arr_iata"))
    out.update(
        status=status, delay_minutes=delay, eta=_clock(entry.get("arr_estimated") or entry.get("arr_time")),
        arrived=_clock(entry.get("arr_actual")) if status == "Landed" else None,
        terminal=_text(entry.get("arr_terminal")), gate=_text(entry.get("arr_gate")),
        baggage=_text(entry.get("arr_baggage")), aircraft=_text(entry.get("aircraft_icao")), checked_as=ident,
        operator=airlines.name_of(entry.get("airline_iata") or entry.get("airline_icao")) or None,
        route={"origin": origin.upper() if origin else None, "dest": dest.upper() if dest else None, "dep_ts": dep, "arr_ts": arrival}
        if (origin or dest) else None,
    )
    return final, arrival


def today_str(now=None):
    """Today's date at the station (STATION_TZ), e.g. '2026-11-16'."""
    from datetime import datetime
    return datetime.fromtimestamp(time.time() if now is None else now, store.station_tz()).strftime("%Y-%m-%d")


def lookup(flight, date=None, time_hhmm=None, airport=None, force=False, now=None, fetch=None):
    """Live status for one flight. Always returns a dict, never raises.
    The flight service is only asked for flights arriving today; other days get what was saved on the day."""
    now = time.time() if now is None else now
    raw_fetch = fetch or fetch_json
    code = clean_flight(flight)
    out = _base(code)
    parsed = split_code(code)
    if not code or not parsed:
        out.update(status="Invalid flight", detail="That does not look like a flight number (example: OO 5131).")
        return out
    today = today_str(now)

    # 1) not today: never ask the flight service. Show what was saved on the day, if anything.
    if date and date != today:
        out["not_today"] = True
        out["usage"] = usage(now)
        saved_day = store.saved_live(code, date)
        if saved_day:
            out.update({k: saved_day.get(k) for k in SAVED_KEYS if k in saved_day})
            out.update(cached=True, saved=True, age_s=int(max(0, now - saved_day.get("saved_ts", now))),
                       detail="Saved on the day of the flight. Live status is only requested for today's flights.")
        else:
            out.update(status="Scheduled" if date > today else "Past flight",
                       detail="Live status is only requested for today's flights, so nothing was requested."
                              + (" It is available on the day of the flight." if date > today else ""))
        return out
    if not api_key():
        out.update(configured=False, status="API key not set",
                   detail="Add FLIGHT_API_KEY to the .env file and restart the server.")
        return out
    airport = (airport or os.environ.get("STATION_AIRPORT") or "").strip().upper()[:3] or None
    if airport and not re.match(r"^[A-Z]{3}$", airport):
        airport = None
    ride_ts = store.local_epoch(date, time_hhmm or "12:00") if date else None
    out["usage"] = usage(now)

    key = f"{code}|{date or ''}"
    with _key_locks[key]:
        with _lock:
            cache = _load_cache()
        saved = cache.get(key)

        # 2) a saved answer that is still fresh (landed/cancelled answers never expire; "Refresh now" skips the
        #    normal waiting time but not the 2-minute minimum between requests)
        if saved:
            ttl = _ttl(saved, ride_ts, now)
            age = now - saved.get("fetched", 0)
            too_soon = force and ttl is not None and age < FORCE_MIN
            fresh = ttl is None or (age < FORCE_MIN if force else age < ttl)
            if fresh:
                res = dict(saved["result"], cached=True, age_s=int(age), usage=out["usage"])
                if too_soon:
                    res["detail"] = "Refreshed less than 2 minutes ago, so nothing new was requested."
                return res

        # 3) ask AirLabs (counted against the monthly budget)
        def call(endpoint, **params):
            _spend(now)
            return raw_fetch(endpoint, **params)

        try:
            entry, ident, tried = _resolve(call, parsed, ride_ts, airport, (saved or {}).get("ident"), now)
        except BudgetError as e:
            if saved:
                return dict(saved["result"], cached=True, age_s=int(now - saved.get("fetched", 0)), usage=usage(now),
                            detail=f"{e}. Showing the last saved answer.")
            out.update(status="API budget used", detail=f"{e}. Live checks resume next month (or raise LIVE_MONTHLY_BUDGET).",
                       usage=usage(now))
            return out
        except LiveError as e:
            if saved:
                return dict(saved["result"], cached=True, age_s=int(now - saved.get("fetched", 0)), usage=usage(now),
                            detail=f"{e}. Showing the last saved answer.")
            out.update(status="API error", detail=str(e), usage=usage(now))
            return out

        out["tried"] = tried
        out["usage"] = usage(now)
        if entry is None:
            out.update(status="No live data yet",
                       detail="The flight service has no record of this flight yet (looked for " + ", ".join(tried) + "). "
                              "Flights usually appear a few hours before departure; it is checked again automatically.")
            final, best = False, None
            ident = None
        else:
            final, best = _finish(out, entry, ident)
        with _lock:
            cache = _load_cache()
            cache[key] = {"fetched": now, "result": {k: v for k, v in out.items() if k not in ("usage", "cached", "age_s")},
                          "final": final, "ident": ident, "arr_ts": best}
            _save_cache(cache, now)
        if entry is not None and date:
            summary = {k: out[k] for k in SAVED_KEYS}
            summary["saved_ts"] = int(now)
            # saved on the ride: shown on other days for free; a later arrival also protects the ride from the optional clean-up
            store.note_live(code, date, summary, best if best and ride_ts and best > ride_ts else None)
        return out
