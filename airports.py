"""Airport coordinates and names (airports.json: major airports from Natural Earth, public domain)."""
import json
import os

_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "airports.json")
_cache = None


def all_airports():
    """{'DFW': {'name': ..., 'lat': ..., 'lng': ...}, ...}"""
    global _cache
    if _cache is None:
        try:
            with open(_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            _cache = data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            _cache = {}
    return _cache


def get(iata):
    return all_airports().get(str(iata or "").strip().upper())
