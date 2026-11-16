"""Shows exactly how the dashboard looks a flight up, step by step. Use it when a flight says "No live data yet".

    python3 diagnose_flight.py "OO 5131" 2026-11-16 14:20 DFW
                               flight     date       time  airport   (date, time and airport are optional)

It makes 1 to 4 real requests to AirLabs (they count towards your monthly budget) and prints every request,
how many results came back, and which result was chosen. The API key is never printed.
Like the dashboard, it only looks up flights arriving today: leave the date out, or give today's date.
"""
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
os.chdir(BASE)
sys.path.insert(0, BASE)

import live  # noqa: E402

FIELDS = ("flight_iata", "flight_icao", "cs_flight_iata", "airline_iata", "dep_iata", "arr_iata", "arr_time", "arr_estimated",
          "arr_delayed", "status", "arr_terminal", "arr_gate")


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    live.load_env(os.path.join(BASE, ".env"))
    flight = argv[0]
    date = argv[1] if len(argv) > 1 else None
    hhmm = argv[2] if len(argv) > 2 else None
    airport = argv[3].upper() if len(argv) > 3 else None
    if not live.api_key():
        print("No FLIGHT_API_KEY in .env - nothing to test. Add the key and run this again.")
        return 1
    parts = live.split_code(flight)
    print(f"Flight {flight!r}: " + (f"airline {parts[0]} / {parts[1]}, number {parts[2]}" if parts else "not a valid flight number"))
    print(f"Rule: only flights arriving today ({live.today_str()}, station time) are looked up.  Budget: {live.usage()['calls']} of "
          f"{live.usage()['budget'] or 'unlimited'} requests used this month.\n")
    if date and date != live.today_str():
        print(f"{date} is not today, so the dashboard would not ask AirLabs about it and nothing was requested.\n"
              "Leave the date out (or use today's date) to see how the flight is looked up.")
        return 0

    def traced(endpoint, **params):
        print(f"  request  {endpoint}  {params}")
        data = live.fetch_json(endpoint, **params)
        resp = data.get("response") if isinstance(data, dict) else None
        rows = resp if isinstance(resp, list) else ([resp] if isinstance(resp, dict) else [])
        print(f"  answer   {len(rows)} result(s)")
        for e in rows[:3]:
            print("           " + ", ".join(f"{k}={e.get(k)}" for k in FIELDS if e.get(k) not in (None, "")))
        return data

    res = live.lookup(flight, date, hhmm, airport, force=True, fetch=traced)
    print("\nResult")
    for k in ("status", "checked_as", "operator", "eta", "arrived", "terminal", "gate", "baggage", "aircraft", "route", "tried", "detail"):
        if res.get(k) not in (None, "", []):
            print(f"  {k}: {res[k]}")
    if not airport:
        print("\nTip: add the airport (for example DFW) as the 4th argument to also search that airline's arrivals board.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
