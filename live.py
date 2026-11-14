"""Live flight status through AirLabs (https://airlabs.co).

Standard library only. The API key is read from the FLIGHT_API_KEY environment variable
(put it in the .env file next to main.py) and is only used here on the server: it is
never sent to the browser and never appears in the messages returned by lookup().
"""
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

API_BASE = "https://airlabs.co/api/v9"
TIMEOUT = 8  # seconds


class LiveError(Exception):
    """A problem talking to AirLabs. The message is short and never contains the API key."""


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


def clean_flight(code):
    """'af 94' -> 'AF94'"""
    return re.sub(r"[^A-Z0-9]", "", str(code or "").upper())


def _text(value):
    value = str(value).strip() if value is not None else ""
    return value or None


def _clock(stamp):
    """'2026-03-05 14:20' -> '14:20'"""
    stamp = str(stamp or "")
    return stamp.split(" ")[1][:5] if " " in stamp else None


def _int(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def _pick(entries, date):
    """AirLabs can list several days of the same flight: prefer the one on the wanted date."""
    if not isinstance(entries, list) or not entries:
        return None
    entries = [e for e in entries if isinstance(e, dict)]
    if date:
        for e in entries:
            if str(e.get("arr_time") or e.get("dep_time") or "").startswith(date):
                return e
    return entries[0] if entries else None


def _status(entry):
    raw = str(entry.get("status") or "").lower()
    delay = _int(entry.get("delayed"))
    if raw == "cancelled":
        return "Cancelled", 0
    if raw == "landed":
        return "Landed", delay
    if delay > 0:
        return f"Delayed {delay}m", delay
    if raw == "active":
        return "In Air", 0
    return "On Time", 0


def _position(flight_iata, fetch):
    """Where the plane is right now, in the units the dashboard prints (feet, knots, degrees)."""
    data = fetch("flight", flight_iata=flight_iata)
    r = data.get("response") if isinstance(data, dict) else None
    if not isinstance(r, dict):
        return None
    try:
        lat, lng = float(r["lat"]), float(r["lng"])
    except (KeyError, TypeError, ValueError):
        return None

    def num(v, factor=1.0):
        try:
            return round(float(v) * factor)
        except (TypeError, ValueError):
            return None

    return {
        "latitude": lat, "longitude": lng,
        "altitude": num(r.get("alt"), 3.28084),   # AirLabs: metres  -> feet
        "heading": num(r.get("dir")),             # degrees
        "speed": num(r.get("speed"), 0.539957),   # AirLabs: km/h    -> knots
    }


def lookup(flight, date=None, fetch=None):
    """Live status for one flight. Always returns a dict, never raises."""
    fetch = fetch or fetch_json
    code = clean_flight(flight)
    out = {"flight": code, "configured": True, "status": "Not found", "delay_minutes": 0, "eta": None,
           "terminal": None, "gate": None, "baggage": None, "aircraft": None, "position": None, "detail": None}
    if not code:
        return out
    if not api_key():
        out.update(configured=False, status="API key not set",
                   detail="Add FLIGHT_API_KEY to the .env file and restart the server.")
        return out
    try:
        data = fetch("schedules", flight_iata=code)
        entry = _pick(data.get("response") if isinstance(data, dict) else None, date)
        if entry is None:
            return out
        status, delay = _status(entry)
        out.update(
            status=status, delay_minutes=delay,
            eta=_clock(entry.get("arr_estimated") or entry.get("arr_time")),
            terminal=_text(entry.get("arr_terminal")), gate=_text(entry.get("arr_gate")),
            baggage=_text(entry.get("arr_baggage")), aircraft=_text(entry.get("aircraft_icao")),
        )
        if str(entry.get("status") or "").lower() == "active":
            try:
                out["position"] = _position(code, fetch)
            except LiveError:
                pass  # the status is still useful without a map position
    except LiveError as e:
        out.update(status="API error", detail=str(e))
    return out
