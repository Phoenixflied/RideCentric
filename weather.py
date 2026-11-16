"""Airport weather for the dashboard's weather card, from Open-Meteo (https://open-meteo.com).

No account or key is needed, and it has nothing to do with the flight API key or its request budget.
It is only asked when the dashboard shows an airport, and each airport is remembered for 30 minutes.
Standard library only. Temperatures are in Fahrenheit, wind in mph.
"""
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import airports

API = "https://api.open-meteo.com/v1/forecast"
TIMEOUT = 6
TTL = 30 * 60          # how long one airport's forecast is reused
STALE_OK = 3 * 3600    # if the service cannot be reached, an older answer is still shown up to this age

_lock = threading.Lock()
_cache = {}            # iata -> (fetched_ts, raw answer)

# WMO weather codes -> (text, kind); the kind picks the icon
_CODES = {
    0: ("Clear sky", "clear"), 1: ("Mainly clear", "clear"), 2: ("Partly cloudy", "partly"), 3: ("Overcast", "cloud"),
    45: ("Fog", "fog"), 48: ("Freezing fog", "fog"),
    51: ("Light drizzle", "rain"), 53: ("Drizzle", "rain"), 55: ("Heavy drizzle", "rain"), 56: ("Freezing drizzle", "rain"), 57: ("Freezing drizzle", "rain"),
    61: ("Light rain", "rain"), 63: ("Rain", "rain"), 65: ("Heavy rain", "rain"), 66: ("Freezing rain", "rain"), 67: ("Freezing rain", "rain"),
    71: ("Light snow", "snow"), 73: ("Snow", "snow"), 75: ("Heavy snow", "snow"), 77: ("Snow grains", "snow"),
    80: ("Rain showers", "rain"), 81: ("Rain showers", "rain"), 82: ("Heavy showers", "rain"), 85: ("Snow showers", "snow"), 86: ("Snow showers", "snow"),
    95: ("Thunderstorm", "storm"), 96: ("Thunderstorm, hail", "storm"), 99: ("Thunderstorm, hail", "storm"),
}
_DIRS = ("N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW")


def describe(code):
    text, kind = _CODES.get(int(code) if code is not None else -1, ("Unknown", "cloud"))
    return text, kind


def compass(deg):
    try:
        return _DIRS[int((float(deg) % 360) / 22.5 + 0.5) % 16]
    except (TypeError, ValueError):
        return None


def _num(v, nd=0):
    try:
        return round(float(v), nd) if nd else int(round(float(v)))
    except (TypeError, ValueError):
        return None


def fetch_raw(lat, lng):
    """One Open-Meteo request: now, plus the next 3 days by the hour."""
    q = urllib.parse.urlencode({
        "latitude": lat, "longitude": lng,
        "current": "temperature_2m,apparent_temperature,relative_humidity_2m,is_day,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
        "hourly": "temperature_2m,precipitation_probability,weather_code,wind_speed_10m",
        "temperature_unit": "fahrenheit", "wind_speed_unit": "mph", "timezone": "auto", "forecast_days": 3})
    req = urllib.request.Request(f"{API}?{q}", headers={"User-Agent": "RideCentric/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"weather service returned HTTP {e.code}") from None
    except (urllib.error.URLError, OSError):
        raise RuntimeError("weather service could not be reached") from None
    except ValueError:
        raise RuntimeError("weather service sent an unreadable reply") from None
    if not isinstance(data, dict) or "current" not in data:
        raise RuntimeError("weather service sent no data")
    return data


def _shape(iata, info, raw, fetched, at):
    cur = raw.get("current") or {}
    text, kind = describe(cur.get("weather_code"))
    out = {
        "airport": iata, "name": info.get("name"), "updated": int(fetched), "error": None, "arrival": None,
        "current": {"temp": _num(cur.get("temperature_2m")), "feels": _num(cur.get("apparent_temperature")),
                    "humidity": _num(cur.get("relative_humidity_2m")), "wind": _num(cur.get("wind_speed_10m")),
                    "gust": _num(cur.get("wind_gusts_10m")), "dir": compass(cur.get("wind_direction_10m")),
                    "code": cur.get("weather_code"), "text": text, "kind": kind, "night": cur.get("is_day") == 0,
                    "clouds": _num(cur.get("cloud_cover")), "precip": _num(cur.get("precipitation"), 2)},
    }
    # the forecast for the hour the flight lands (the airport's own local clock)
    hourly, offset = raw.get("hourly") or {}, _num(raw.get("utc_offset_seconds")) or 0
    if at and hourly.get("time"):
        local = datetime.fromtimestamp(int(at) + offset, timezone.utc).strftime("%Y-%m-%dT%H:00")
        times = hourly["time"]
        if local in times:
            i = times.index(local)
            code = (hourly.get("weather_code") or [None] * (i + 1))[i]
            t2, k2 = describe(code)
            out["arrival"] = {"time": local[11:16], "temp": _num((hourly.get("temperature_2m") or [None] * (i + 1))[i]),
                              "text": t2, "kind": k2, "wind": _num((hourly.get("wind_speed_10m") or [None] * (i + 1))[i]),
                              "precip_pct": _num((hourly.get("precipitation_probability") or [None] * (i + 1))[i])}
    return out


def get(iata, at=None, now=None, fetch=None):
    """Weather at an airport (IATA code); `at` = Unix time of the flight's arrival. Always returns a dict, never raises."""
    now = time.time() if now is None else now
    iata = str(iata or "").strip().upper()
    info = airports.get(iata)
    if not info:
        return {"airport": iata, "error": "Unknown airport", "current": None, "arrival": None}
    with _lock:
        hit = _cache.get(iata)
    if hit and now - hit[0] < TTL:
        return _shape(iata, info, hit[1], hit[0], at)
    try:
        raw = (fetch or fetch_raw)(info["lat"], info["lng"])
    except RuntimeError as e:
        if hit and now - hit[0] < STALE_OK:      # keep showing the older answer rather than an empty card
            out = _shape(iata, info, hit[1], hit[0], at)
            out["error"] = f"Showing the last answer ({int((now - hit[0]) / 60)} min old): {e}"
            return out
        return {"airport": iata, "name": info.get("name"), "error": f"Weather unavailable: {e}", "current": None, "arrival": None}
    with _lock:
        _cache[iata] = (now, raw)
    return _shape(iata, info, raw, now, at)
