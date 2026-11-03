#!/usr/bin/env python3
"""Geocode birth places for horoscope computation.

Resolution order for a place string like "Valliyur" or "Marietta, Georgia":

1. `places` overrides in docs/config.yml (hand-verified entries always win)
2. private/geocache.json (results from earlier lookups)
3. Nominatim (OpenStreetMap) — one polite request per second, cached

The timezone is taken from the override/cache, else looked up offline from the
coordinates with timezonefinder, else defaulted to Asia/Kolkata with a warning.

The cache is stored under private/ (git-ignored): it may hold city-level
locations of living people, which we deliberately do not publish raw.
"""

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

try:
    from timezonefinder import TimezoneFinder
except ImportError:  # pragma: no cover - optional dependency
    TimezoneFinder = None

USER_AGENT = "kula-family-tree/1.0 (static site generator; Nominatim usage per policy)"
DEFAULT_TZ = "Asia/Kolkata"

_cache = None
_finder = None


def _load_cache(path):
    global _cache
    if _cache is None:
        p = Path(path)
        _cache = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    return _cache


def _save_cache(path):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(_cache, ensure_ascii=False, indent=1, sort_keys=True),
                 encoding="utf-8")


def _nominatim(query):
    url = ("https://nominatim.openstreetmap.org/search?format=json&limit=1&q="
           + urllib.parse.quote(query))
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as resp:
        hits = json.loads(resp.read().decode("utf-8"))
    if not hits:
        return None
    hit = hits[0]
    return {"lat": float(hit["lat"]), "lon": float(hit["lon"]),
            "display": hit.get("display_name", query)}


def _tz_for(lat, lon):
    global _finder
    if TimezoneFinder is None:
        return None
    if _finder is None:
        _finder = TimezoneFinder()
    return _finder.timezone_at(lat=lat, lng=lon)


def geocode(place, config_places=None, cache_path="private/geocache.json",
            offline=False, warn=print):
    """Return {"lat", "lon", "tz", "display"} for a place, or None."""
    key = " ".join(str(place or "").split()).strip()
    if not key:
        return None

    overrides = config_places or {}
    if key in overrides:
        entry = dict(overrides[key])
        entry.setdefault("tz", DEFAULT_TZ)
        entry.setdefault("display", key)
        return entry

    cache = _load_cache(cache_path)
    if key in cache:
        return cache[key]

    if offline:
        if warn:
            warn(f"  WARNING: no cached geocode for '{key}' (offline mode)")
        return None

    hit = _nominatim(key)
    time.sleep(1.1)  # Nominatim usage policy: max 1 request/second
    if not hit:
        if warn:
            warn(f"  WARNING: could not geocode '{key}' — add it under places: in docs/config.yml")
        return None

    tz = _tz_for(hit["lat"], hit["lon"])
    if not tz:
        tz = DEFAULT_TZ
        if warn:
            warn(f"  WARNING: timezone unknown for '{key}', defaulting to {DEFAULT_TZ}")
    hit["tz"] = tz
    cache[key] = hit
    _save_cache(cache_path)
    return hit
