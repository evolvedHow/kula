#!/usr/bin/env python3
"""Vedic birth chart (jatagam) computation via Swiss Ephemeris.

Given a birth datetime (local to the birthplace) plus latitude/longitude and a
timezone, this module computes the sidereal (Lahiri ayanamsa) positions of the
nine grahas and the lagna, and derives the Moon's rashi / nakshatra / pada.

The output is a compact JSON-ready dict shaped for the South Indian square
chart renderer in docs/assets/chart.js:

    {
      "engine": "swisseph-lahiri/2.10.03",
      "lagna": "Vrishabha",
      "moon": {"rashi": "Meena", "nakshatra": "Uttara Bhadrapada", "pada": 2},
      "planets": {
        "Su": {"name": "Sun", "rasi": "Mesha", "deg": 12.34,
               "nakshatra": "Ashwini", "pada": 2, "retro": false},
        ...
      },
      "rasis": {"Mesha": ["Su", "Me"], "Vrishabha": ["La", "Mo"], ...}
    }

Only computed when the GEDCOM supplies a birth date AND time AND place; the
importer skips chart generation otherwise (the UI then hides the Jatagam
button).

This module needs the project virtualenv:  .venv/bin/python scripts/import_gedcom.py
"""

import re
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

try:
    import swisseph as swe
except ImportError:  # pragma: no cover - importer degrades gracefully
    swe = None

# South Indian chart order: rasis clockwise from Mesha. The renderer fixes
# each rasi to a box, so this list is mainly for naming and index maths.
RASIS = [
    "Mesha", "Vrishabha", "Mithuna", "Kataka", "Simha", "Kanya",
    "Tula", "Vrischika", "Dhanus", "Makara", "Kumbha", "Meena",
]

NAKSHATRAS = [
    "Ashwini", "Bharani", "Krittika", "Rohini", "Mrigashira", "Ardra",
    "Punarvasu", "Pushya", "Ashlesha", "Magha", "Purva Phalguni",
    "Uttara Phalguni", "Hasta", "Chitra", "Swati", "Vishakha", "Anuradha",
    "Jyeshtha", "Mula", "Purva Ashadha", "Uttara Ashadha", "Shravana",
    "Dhanishta", "Shatabhisha", "Purva Bhadrapada", "Uttara Bhadrapada",
    "Revati",
]

# Grahas in the traditional South Indian display order.
GRAHAS = [
    ("Su", "Sun", "SUN"),
    ("Mo", "Moon", "MOON"),
    ("Ma", "Mars", "MARS"),
    ("Me", "Mercury", "MERCURY"),
    ("Ju", "Jupiter", "JUPITER"),
    ("Ve", "Venus", "VENUS"),
    ("Sa", "Saturn", "SATURN"),
    ("Ra", "Rahu", "MEAN_NODE"),
]

EXCEL_EPOCH = datetime(1899, 12, 30)  # Excel/Sheets serial day 0
MONTHS = {m.lower(): i + 1 for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July",
     "August", "September", "October", "November", "December"])}
# Accept 3-letter abbreviations too ("Aug", "Sept", ...).
for _name, _num in list(MONTHS.items()):
    MONTHS.setdefault(_name[:3], _num)
MONTHS.setdefault("sept", 9)


def parse_birth(value):
    """Parse a DOB cell into (display_text, naive_local_datetime, has_time).

    Accepts:
      * Excel/Sheets serial numbers ("38652.6042" -> date + fraction-of-day)
      * "15/08/1950 14:30", "15-08-1950 2:30 pm"
      * "15 Aug 1950 14:30", "August 15, 1950 2:30 PM"
      * ISO "1950-08-15 14:30"
      * the sheet's custom text format "Jan/1/1895 00:00:"
      * date-only variants of the above (has_time=False)

    A serial with no fractional part, or a text date with no time component,
    means "unknown birth time" and returns has_time=False. Midnight (00:00)
    entered explicitly is indistinguishable from no-time in serial form, so
    charts are not generated for whole-number serials.
    """
    text = str(value or "").strip()
    if not text:
        return None, None, False

    # Excel serial (Google Sheets exports real date/time cells this way).
    # A fractional part means it's definitely a serial with a time. A whole
    # number is a serial only with 5+ digits (dates after 18 May 1927), so a
    # bare year like "1946" is not misread; enter pre-1927 births as text.
    is_serial = bool(re.fullmatch(r"\d{4,6}\.\d+", text)) or bool(
        re.fullmatch(r"\d{5,6}", text))
    if is_serial:
        serial = float(text)
        days = int(serial)
        # Round the fractional day to the nearest minute to kill float noise.
        minutes = round((serial - days) * 1440)
        has_time = minutes > 0
        dt = EXCEL_EPOCH + timedelta(days=days, minutes=minutes)
        display = dt.strftime("%-d %b %Y") + (dt.strftime(", %H:%M") if has_time else "")
        return display, dt, has_time

    # Text forms.
    m = re.match(
        r"^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{4})"
        r"(?:[,\s]+(\d{1,2})[:.](\d{2})(?:\s*([ap]m))?)?$",
        text, re.IGNORECASE)
    if m:
        day, month, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if not 1 <= month <= 12:
            return text, None, False
        hh, mm, ap = m.group(4), m.group(5), m.group(6)
        has_time = hh is not None
        hour = int(hh) if has_time else 0
        minute = int(mm) if has_time else 0
        if ap:
            hour = hour % 12 + (12 if ap.lower() == "pm" else 0)
        try:
            dt = datetime(year, month, day, hour, minute)
        except ValueError:
            return text, None, False
        display = dt.strftime("%-d %b %Y") + (dt.strftime(", %H:%M") if has_time else "")
        return display, dt, has_time

    m = re.match(
        r"^(\d{4})-(\d{1,2})-(\d{1,2})"
        r"(?:[T,\s]+(\d{1,2}):(\d{2}))?$", text)
    if m:
        year, month, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
        has_time = m.group(4) is not None
        try:
            dt = datetime(year, month, day,
                          int(m.group(4) or 0), int(m.group(5) or 0))
        except ValueError:
            return text, None, False
        display = dt.strftime("%-d %b %Y") + (dt.strftime(", %H:%M") if has_time else "")
        return display, dt, has_time

    # The original family sheet's custom text format, e.g.
    # "Jan/1/1895 00:00:" (month/day/year, optional trailing colon/seconds).
    m = re.match(
        r"^([A-Za-z]{3,9})/(\d{1,2})/(\d{4})"
        r"(?:[,\s]+(\d{1,2}):(\d{2})(?::\d{2})?)?\s*:?$",
        text, re.IGNORECASE)
    if m:
        month = MONTHS.get(m.group(1).lower())
        day, year = int(m.group(2)), int(m.group(3))
        if not month:
            return text, None, False
        has_time = m.group(4) is not None
        hour = int(m.group(4) or 0)
        minute = int(m.group(5) or 0)
        try:
            dt = datetime(year, month, day, hour, minute)
        except ValueError:
            return text, None, False
        display = dt.strftime("%-d %b %Y") + (dt.strftime(", %H:%M") if has_time else "")
        return display, dt, has_time

    m = re.match(
        r"^(?:([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})|(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4}))"
        r"(?:[,\s]+(\d{1,2})[:.](\d{2})(?:\s*([ap]m))?)?$",
        text, re.IGNORECASE)
    if m:
        if m.group(1):
            mon_name, day, year = m.group(1), int(m.group(2)), int(m.group(3))
        else:
            day, mon_name, year = int(m.group(4)), m.group(5), int(m.group(6))
        month = MONTHS.get(mon_name.lower())
        if not month:
            return text, None, False
        hh, mm, ap = m.group(7), m.group(8), m.group(9)
        has_time = hh is not None
        hour = int(hh) if has_time else 0
        minute = int(mm) if has_time else 0
        if ap:
            hour = hour % 12 + (12 if ap.lower() == "pm" else 0)
        try:
            dt = datetime(year, month, day, hour, minute)
        except ValueError:
            return text, None, False
        display = dt.strftime("%-d %b %Y") + (dt.strftime(", %H:%M") if has_time else "")
        return display, dt, has_time

    # Unparseable: keep the text, no datetime.
    return text, None, False


def nakshatra_pada(lon):
    """Sidereal longitude -> (nakshatra name, pada 1-4)."""
    segment = 360.0 / 27.0       # 13°20'
    pada_span = segment / 4.0    # 3°20'
    idx = int(lon / segment) % 27
    pada = int((lon - idx * segment) / pada_span) + 1
    return NAKSHATRAS[idx], min(pada, 4)


def compute_chart(local_dt, lat, lon, tz_name):
    """Compute the sidereal chart. local_dt is a naive datetime in tz_name.

    Returns the chart dict described in the module docstring, or None when
    Swiss Ephemeris is unavailable.
    """
    if swe is None:
        return None
    aware = local_dt.replace(tzinfo=ZoneInfo(tz_name))
    utc = aware.astimezone(ZoneInfo("UTC"))
    hour = utc.hour + utc.minute / 60.0
    jd = swe.julday(utc.year, utc.month, utc.day, hour)

    swe.set_sid_mode(swe.SIDM_LAHIRI)
    flags = swe.FLG_SIDEREAL | swe.FLG_SPEED

    planets = {}
    rasis = {}
    rahu_lon = None
    for code, name, const in GRAHAS:
        pos, serr = swe.calc_ut(jd, getattr(swe, const), flags)
        glon = pos[0] % 360.0
        if code == "Ra":
            rahu_lon = glon
        rasi_idx = int(glon // 30)
        nak, pada = nakshatra_pada(glon)
        planets[code] = {
            "name": name,
            "rasi": RASIS[rasi_idx],
            "deg": round(glon % 30.0, 2),
            "nakshatra": nak,
            "pada": pada,
            "retro": pos[3] < 0,
        }
        rasis.setdefault(RASIS[rasi_idx], []).append(code)

    # Ketu is always opposite Rahu.
    ke_lon = (rahu_lon + 180.0) % 360.0
    ke_rasi_idx = int(ke_lon // 30)
    nak, pada = nakshatra_pada(ke_lon)
    planets["Ke"] = {
        "name": "Ketu",
        "rasi": RASIS[ke_rasi_idx],
        "deg": round(ke_lon % 30.0, 2),
        "nakshatra": nak,
        "pada": pada,
        "retro": True,  # Ketu, like Rahu, is always retrograde in mean motion
    }
    rasis.setdefault(RASIS[ke_rasi_idx], []).append("Ke")

    # Lagna (ascendant) on the sidereal zodiac.
    ascmc = swe.houses_ex(jd, lat, lon, b"P", swe.FLG_SIDEREAL)[1]
    lagna_lon = ascmc[0] % 360.0
    lagna = RASIS[int(lagna_lon // 30)]
    rasis.setdefault(lagna, []).insert(0, "La")

    mo = planets["Mo"]
    return {
        "engine": f"swisseph-lahiri/{swe.version}",
        "lagna": lagna,
        "lagna_deg": round(lagna_lon % 30.0, 2),
        "moon": {"rashi": mo["rasi"], "nakshatra": mo["nakshatra"], "pada": mo["pada"]},
        "planets": planets,
        "rasis": rasis,
    }
