"""The ride store: keeps a whole month of manifests and removes each ride by itself once it is over.

* Rides live in database.json (same list-of-dicts format the dashboard has always used).
* Manifest PDFs are read once. A "ledger" (manifest_ledger.json) remembers which files were already loaded,
  so uploading or dropping the same PDF again never creates duplicates.
* Every ride is deleted PURGE_AFTER_MINUTES (default 60) after its arrival. If the flight service reported a
  later arrival (a delayed flight), the clean-up waits for that one instead.
* A background thread does the clean-up every minute and picks up new PDFs dropped in the manifests/ folder.
  The clean-up also runs whenever the dashboard asks for the list, so it is right even if the thread is not running.

Standard library only (the PDF reading itself is in manifest.py). Times in the manifests are local time at the
station; STATION_TZ (default America/Chicago, i.e. Dallas) says which time zone that is.
"""
import hashlib
import json
import os
import threading
import time
from datetime import datetime, timedelta, timezone

import manifest

DB_FILE = "database.json"
LEDGER_FILE = "manifest_ledger.json"
MANIFEST_DIR = "manifests"

_lock = threading.RLock()
_thread = None
_last_purge_check = 0.0


# --------------------------------------------------------------------------- settings

def _env_int(name, default, lo=0, hi=10 ** 6):
    try:
        return max(lo, min(hi, int((os.environ.get(name) or "").strip())))
    except ValueError:
        return default


def purge_after_minutes():
    return _env_int("PURGE_AFTER_MINUTES", 60)


def station_tzname():
    return (os.environ.get("STATION_TZ") or "").strip() or "America/Chicago"


def station_tz():
    """The station's time zone. Falls back to this computer's own zone if the time-zone data is not installed."""
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(station_tzname())
    except Exception:
        return datetime.now().astimezone().tzinfo or timezone.utc


def local_epoch(date, hhmm="00:00", tz=None):
    """'2026-03-05' + '14:20' (station local time) -> Unix seconds, or None if it cannot be read."""
    try:
        y, m, d = (int(x) for x in str(date).split("-"))
        parts = str(hhmm or "00:00").split(":")
        h, n = int(parts[0]), int(parts[1]) if len(parts) > 1 else 0
        return datetime(y, m, d, h, n, tzinfo=tz or station_tz()).timestamp()
    except (ValueError, TypeError, IndexError):
        return None


# --------------------------------------------------------------------------- files

def _read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _write_json(path, data):
    """Write to a temporary file and swap it in, so a crash can never leave a half-written file."""
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def load_db():
    with _lock:
        data = _read_json(DB_FILE, [])
        return data if isinstance(data, list) else []


def save_db(data):
    with _lock:
        _write_json(DB_FILE, data)


def load_ledger():
    data = _read_json(LEDGER_FILE, {})
    if not isinstance(data, dict):
        data = {}
    data.setdefault("files", {})
    data.setdefault("stats", {})
    return data


# --------------------------------------------------------------------------- purge

def due_ts(ride, tz=None):
    """When this ride should be removed (Unix seconds), or None if it has no usable date."""
    arrival = local_epoch(ride.get("date"), ride.get("arrival_time") or "23:59", tz)
    if arrival is None:  # no readable time (e.g. "TBD"): count from the end of that day
        arrival = local_epoch(ride.get("date"), "23:59", tz)
    if arrival is None:
        return None
    live = ride.get("live_arrival_ts")  # a later estimated/actual arrival reported by the flight service
    if isinstance(live, (int, float)) and live > arrival:
        arrival = live
    return arrival + purge_after_minutes() * 60


def purge(now=None):
    """Deletes every ride whose time has come. Returns how many were removed."""
    global _last_purge_check
    now = time.time() if now is None else now
    tz = station_tz()
    with _lock:
        db = load_db()
        keep = [r for r in db if not (isinstance(r, dict) and (due_ts(r, tz) or float("inf")) <= now)]
        removed = len(db) - len(keep)
        if removed:
            save_db(keep)
            led = load_ledger()
            st = led["stats"]
            st["purged_total"] = int(st.get("purged_total", 0)) + removed
            st["last_purge_ts"] = now
            _write_json(LEDGER_FILE, led)
        _last_purge_check = time.time()
        return removed


def purge_if_due(max_age=30):
    """Cheap check used by the web requests: runs the clean-up if it has not run in the last `max_age` seconds."""
    if time.time() - _last_purge_check >= max_age:
        return purge()
    return 0


# --------------------------------------------------------------------------- ingest

def _same_ride(a, b):
    return all(a.get(k) == b.get(k) for k in ("flight", "date", "arrival_time"))


def ingest_report(rep, now=None):
    """Adds the rides of a parsed manifest to the store. Returns counts."""
    now = time.time() if now is None else now
    tz = station_tz()
    counts = {"added": 0, "updated": 0, "duplicates": 0, "expired": 0}
    with _lock:
        db = load_db()
        by_id = {r.get("id"): i for i, r in enumerate(db) if isinstance(r, dict)}
        keys = {(r.get("ride_no"), r.get("date")) for r in db if isinstance(r, dict)}
        for ride in rep.get("rides", []):
            due = due_ts(ride, tz)
            if due is not None and due <= now:
                counts["expired"] += 1  # already over: it would be deleted again straight away
                continue
            i = by_id.get(ride["id"])
            if i is not None:
                old = db[i]
                if _same_ride(old, ride):
                    counts["duplicates"] += 1
                else:  # the manifest was re-issued with a change (flight, date or time)
                    for k in ("flight", "date", "arrival_time", "pax", "bags", "airport", "source"):
                        old[k] = ride.get(k)
                    old.pop("live_arrival_ts", None)
                    counts["updated"] += 1
                continue
            if (ride["ride_no"], ride["date"]) in keys:
                counts["duplicates"] += 1
                continue
            ride = dict(ride, added_ts=int(now))
            db.append(ride)
            by_id[ride["id"]] = len(db) - 1
            keys.add((ride["ride_no"], ride["date"]))
            counts["added"] += 1
        if counts["added"] or counts["updated"]:
            save_db(db)
    return counts


def _remember_file(sha, name, rep, counts, now=None):
    now = time.time() if now is None else now
    with _lock:
        led = load_ledger()
        led["files"][sha] = {
            "name": os.path.basename(name or ""), "loaded_ts": int(now),
            "date_from": rep.get("date_from"), "date_to": rep.get("date_to"), "airport": rep.get("airport"),
            "arrivals": rep.get("arrivals", 0), "added": counts["added"],
        }
        led["stats"]["last_load_ts"] = int(now)
        _write_json(LEDGER_FILE, led)


def load_manifest_bytes(data, name="", now=None):
    """Reads one uploaded or dropped PDF and stores its rides. Raises manifest.ManifestError for unusable files."""
    sha = hashlib.sha256(data).hexdigest()
    with _lock:
        known = load_ledger()["files"].get(sha)
    if known:
        return {"file": os.path.basename(name or ""), "already_loaded": True, "added": 0, "updated": 0, "duplicates": 0,
                "expired": 0, "arrivals": known.get("arrivals", 0), "departures_skipped": 0,
                "date_from": known.get("date_from"), "date_to": known.get("date_to"), "airport": known.get("airport")}
    rep = manifest.parse_pdf(data, name)
    counts = ingest_report(rep, now)
    _remember_file(sha, name, rep, counts, now)
    return {"file": rep["source"], "already_loaded": False, **counts, "arrivals": rep["arrivals"],
            "departures_skipped": rep["departures"], "cancelled_skipped": rep["cancelled"],
            "unreadable": rep["incomplete"] + rep["no_flight"],
            "date_from": rep["date_from"], "date_to": rep["date_to"], "airport": rep["airport"]}


def scan_folder(now=None):
    """Loads every PDF in manifests/ that has not been loaded yet. The PDFs stay where they are."""
    summary = {"files": 0, "added": 0, "updated": 0, "expired": 0, "errors": [], "already": 0}
    if not os.path.isdir(MANIFEST_DIR):
        os.makedirs(MANIFEST_DIR, exist_ok=True)
        return summary
    for name in sorted(os.listdir(MANIFEST_DIR)):
        if not name.lower().endswith(".pdf"):
            continue
        try:
            with open(os.path.join(MANIFEST_DIR, name), "rb") as f:
                data = f.read()
            res = load_manifest_bytes(data, name, now)
        except manifest.ManifestError as e:
            summary["errors"].append(f"{name}: {e}")
            continue
        except OSError:
            summary["errors"].append(f"{name}: could not be opened")
            continue
        if res["already_loaded"]:
            summary["already"] += 1
            continue
        summary["files"] += 1
        for k in ("added", "updated", "expired"):
            summary[k] += res[k]
    return summary


# --------------------------------------------------------------------------- live arrival note

def note_live_arrival(flight_key, date, arrival_ts):
    """The flight service gave a later arrival for this flight: remember it so the ride is not deleted too early."""
    if not arrival_ts:
        return
    with _lock:
        db = load_db()
        changed = False
        for r in db:
            if isinstance(r, dict) and r.get("date") == date and "".join(str(r.get("flight", "")).upper().split()) == flight_key:
                if r.get("live_arrival_ts") != int(arrival_ts):
                    r["live_arrival_ts"] = int(arrival_ts)
                    changed = True
        if changed:
            save_db(db)


# --------------------------------------------------------------------------- summary + background thread

def summary():
    db = load_db()
    tz = station_tz()
    dues = [d for d in (due_ts(r, tz) for r in db if isinstance(r, dict)) if d is not None]
    dates = sorted(r.get("date") for r in db if isinstance(r, dict) and r.get("date"))
    led = load_ledger()
    return {
        "rides": len(db),
        "first_date": dates[0] if dates else None,
        "last_date": dates[-1] if dates else None,
        "next_purge_ts": min(dues) if dues else None,
        "purge_after_minutes": purge_after_minutes(),
        "purged_total": int(led["stats"].get("purged_total", 0)),
        "last_load_ts": led["stats"].get("last_load_ts"),
        "files_loaded": len(led["files"]),
        "station_tz": station_tzname(),
    }


def _loop(purge_every, scan_every):
    last_scan = 0.0
    while True:
        try:
            purge()
            if scan_every and time.time() - last_scan >= scan_every:
                last_scan = time.time()
                scan_folder()
        except Exception as e:  # the thread must survive anything
            print(f"[store] background task failed: {type(e).__name__}", flush=True)
        time.sleep(purge_every)


def start_background():
    """Starts the clean-up / folder-watch thread once. Safe to call again."""
    global _thread
    if _thread is not None and _thread.is_alive():
        return
    purge_every = _env_int("PURGE_INTERVAL_SECONDS", 60, 1, 3600)
    scan_every = _env_int("AUTO_SCAN_MINUTES", 5, 0, 1440) * 60
    _thread = threading.Thread(target=_loop, args=(purge_every, scan_every), name="ride-store", daemon=True)
    _thread.start()
