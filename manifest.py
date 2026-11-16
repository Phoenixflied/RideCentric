"""Reads RideCentric "Manifest" PDF reports (one file per airline and airport, a whole month at a time).

Every ride in the report looks like this once the PDF is turned into text (the exact line breaks do not matter):

    Account: ...
    Pickup: 03/05/2026 14:20      Drop: 03/05/2026 15:05
    Ride #: 12345678   Res Status: Confirmed   Flight OO 5131   # of Bags: 2
    Run Type: ARRIVAL             Total # of pax: 3

Only ARRIVAL rides are kept: each becomes one record for the dashboard. The pickup date and time on an
ARRIVAL ride are the flight's arrival date and time at the station (local time), which is what the
dashboard lists and what the automatic clean-up counts from.

No passenger names are read or stored.
"""
import io
import os
import re
from datetime import datetime

import airlines

MAX_PDF_BYTES = 25 * 1024 * 1024

# One pass over the text: every field is a "token", and a new ride starts when a field repeats.
# (The labels are matched in any letter case; the airline letters of the flight number are case-sensitive: "OO", "9E".)
_TOKEN = re.compile(
    r"(?P<account>Account\s*:)"
    r"|(?P<pickup>Pick\s*-?\s*up\s*:?\s*(?P<p_m>\d{1,2})/(?P<p_d>\d{1,2})/(?P<p_y>\d{4})\s+(?P<p_h>\d{1,2}):(?P<p_n>\d{2})\s*(?P<p_ap>[AaPp][Mm])?)"
    r"|(?P<drop>Drop(?:\s*-?\s*off)?\s*:?\s*\d{1,2}/\d{1,2}/\d{4}\s+\d{1,2}:\d{2})"
    r"|(?P<ride>Ride\s*#\s*:?\s*(?P<ride_no>\d{4,}))"
    r"|(?P<status>Res\s*Status\s*:?\s*(?P<status_word>[A-Za-z]+))"
    r"|(?P<flight>Flight\s*:?\s*(?:(?-i:(?P<fa3>[A-Z]{3}))|(?-i:(?P<fa2>[A-Z0-9]{2})))\s*(?P<fnum>\d{1,4})(?!\d))"
    r"|(?P<bags>\#\s*of\s*Bags\s*:?\s*(?P<bags_n>\d+))"
    r"|(?P<runtype>Run\s*Type\s*:?\s*(?P<run>ARRIVAL|DEPARTURE))"
    r"|(?P<pax>Total\s*\#\s*of\s*pax\s*:?\s*(?P<pax_n>\d+))",
    re.I)

_RANGE = re.compile(r"Date\s*Range\s*:?\s*(\d{1,2})/(\d{1,2})/(\d{4})\s*-\s*(\d{1,2})/(\d{1,2})/(\d{4})", re.I)


class ManifestError(Exception):
    """The file could not be read as a manifest. The message is safe to show to the user."""


def _stamp(m, d, y, h, n, ap):
    h = int(h)
    if ap:
        h = h % 12 + (12 if ap.lower() == "pm" else 0)
    return datetime(int(y), int(m), int(d), h, int(n))


def airport_from_name(filename):
    """'DFW SkyWest.pdf' -> 'DFW' (the report files are named '<AIRPORT> <Airline>')."""
    m = re.match(r"\s*([A-Za-z]{3})(?![A-Za-z])", os.path.basename(filename or ""))
    return m.group(1).upper() if m else None


def parse_text(text, source="", airport=None):
    """Turns the text of a manifest into rides. Returns a report dict; never raises on odd content."""
    text = re.sub(r"[ \t ]+", " ", text or "")
    airport = airport or airport_from_name(source)
    rep = {"rides": [], "arrivals": 0, "departures": 0, "cancelled": 0, "no_flight": 0, "incomplete": 0,
           "date_from": None, "date_to": None, "airport": airport, "source": os.path.basename(source or "")}
    rng = _RANGE.search(text)
    if rng:
        a, b = rng.group(1, 2, 3), rng.group(4, 5, 6)
        rep["date_from"], rep["date_to"] = f"{a[2]}-{int(a[0]):02d}-{int(a[1]):02d}", f"{b[2]}-{int(b[0]):02d}-{int(b[1]):02d}"

    seen = {}

    def flush():
        if not seen:
            return
        rec = dict(seen)
        seen.clear()
        if "ride" not in rec and "pickup" not in rec:
            return  # a stray header / footer line, not a ride
        run = (rec.get("run") or "").upper()
        if run == "DEPARTURE":
            rep["departures"] += 1
            return
        if "ride" not in rec or "pickup" not in rec:
            rep["incomplete"] += 1
            return
        if (rec.get("status") or "").lower().startswith("cancel"):
            rep["cancelled"] += 1
            return
        if "flight" not in rec:
            rep["no_flight"] += 1
            return
        if run != "ARRIVAL":
            rep["incomplete"] += 1  # no Run Type at all: do not guess
            return
        rep["arrivals"] += 1
        code, num = rec["flight"]
        if len(code) == 3:  # written with the 3-letter code (SKW 5131): show the usual 2-character code
            code = airlines.iata_of(code) or code
        when = rec["pickup"]
        rep["rides"].append({
            "id": f"PDF-{rec['ride']}",
            "flight": f"{code} {num}",
            "arrival_time": when.strftime("%H:%M"),
            "date": when.strftime("%Y-%m-%d"),
            "ride_no": rec["ride"],
            "passenger": "N/A",
            "terminal": "TBD",
            "gate": "TBD",
            "status": "SCHEDULED",
            "run_type": "ARRIVAL",
            "airport": airport,
            "pax": rec.get("pax"),
            "bags": rec.get("bags"),
            "source": rep["source"],
        })

    for m in _TOKEN.finditer(text):
        if m.group("account"):
            flush()
            continue
        if m.group("pickup"):
            key, val = "pickup", None
            try:
                val = _stamp(m.group("p_m"), m.group("p_d"), m.group("p_y"), m.group("p_h"), m.group("p_n"), m.group("p_ap"))
            except ValueError:
                key = "bad"
        elif m.group("drop"):
            key, val = "drop", True
        elif m.group("ride"):
            key, val = "ride", m.group("ride_no")
        elif m.group("status"):
            key, val = "status", m.group("status_word")
        elif m.group("flight"):
            key, val = "flight", ((m.group("fa3") or m.group("fa2")).upper(), m.group("fnum"))
        elif m.group("bags"):
            key, val = "bags", int(m.group("bags_n"))
        elif m.group("runtype"):
            key, val = "run", m.group("run").upper()
        elif m.group("pax"):
            key, val = "pax", int(m.group("pax_n"))
        else:
            continue
        if key == "bad":
            flush()
            seen["pickup_bad"] = True
            continue
        if key in seen:
            flush()  # the same field again: this is the next ride
        seen[key] = val
    flush()
    return rep


def parse_pdf(data, source=""):
    """Reads a PDF (bytes) and returns the same report as parse_text(). Raises ManifestError for unusable files."""
    if not isinstance(data, (bytes, bytearray)) or not bytes(data[:5]).startswith(b"%PDF"):
        raise ManifestError("That file is not a PDF.")
    if len(data) > MAX_PDF_BYTES:
        raise ManifestError("That PDF is too large (limit 25 MB).")
    try:
        import pdfplumber
        with pdfplumber.open(io.BytesIO(bytes(data))) as pdf:
            text = "\n".join((page.extract_text() or "") for page in pdf.pages)
    except Exception:
        raise ManifestError("That PDF could not be read (damaged or password protected).") from None
    if not text.strip():
        raise ManifestError("That PDF has no readable text (a scanned picture?). Export the manifest from RideCentric as PDF again.")
    rep = parse_text(text, source)
    if not rep["rides"] and not (rep["arrivals"] or rep["departures"] or rep["cancelled"]):
        raise ManifestError("No rides were found. Is this a RideCentric Manifest report?")
    return rep
