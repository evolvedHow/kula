"""Swiss Ephemeris core: sidereal longitudes, tithi, nakshatra, sunrise.

All calculations use Lahiri ayanamsha and sidereal (nirayana) longitudes.  The
module is intentionally stateless apart from Swiss Ephemeris' global settings;
a lock serialises calls so the HTTP server can safely serve concurrent requests.

References
----------
* Tithi = floor(((Moon - Sun) mod 360) / 12) + 1
* Nakshatra = floor((Moon mod 360) / (360 / 27)) + 1
* Yoga = floor(((Moon + Sun) mod 360) / (360 / 27)) + 1
* Karana = floor(((Moon - Sun) mod 360) / 6) + 1
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import swisseph as swe

from .config import LocationConfig

# ---------------------------------------------------------------------------
# names
# ---------------------------------------------------------------------------

TITHI_NAMES = [
    "Pratipada",
    "Dwitiya",
    "Tritiya",
    "Chaturthi",
    "Panchami",
    "Shashthi",
    "Saptami",
    "Ashtami",
    "Navami",
    "Dashami",
    "Ekadasi",
    "Dwadasi",
    "Trayodasi",
    "Chaturdasi",
    "Purnima",
    "Pratipada",
    "Dwitiya",
    "Tritiya",
    "Chaturthi",
    "Panchami",
    "Shashthi",
    "Saptami",
    "Ashtami",
    "Navami",
    "Dashami",
    "Ekadasi",
    "Dwadasi",
    "Trayodasi",
    "Chaturdasi",
    "Amavasya",
]

TITHI_TAMIL = [
    "Pirathamai",
    "Thuthiyai",
    "Thrithiyai",
    "Chathurthi",
    "Panchami",
    "Shashti",
    "Sapthami",
    "Ashtami",
    "Navami",
    "Dasami",
    "Ekadasi",
    "Dwadasi",
    "Trayodasi",
    "Chathurdasi",
    "Pournami",
    "Pirathamai",
    "Thuthiyai",
    "Thrithiyai",
    "Chathurthi",
    "Panchami",
    "Shashti",
    "Sapthami",
    "Ashtami",
    "Navami",
    "Dasami",
    "Ekadasi",
    "Dwadasi",
    "Trayodasi",
    "Chathurdasi",
    "Amavasai",
]

NAKSHATRA_NAMES = [
    "Ashwini",
    "Bharani",
    "Krittika",
    "Rohini",
    "Mrigashirsha",
    "Ardra",
    "Punarvasu",
    "Pushya",
    "Ashlesha",
    "Magha",
    "Purva Phalguni",
    "Uttara Phalguni",
    "Hasta",
    "Chitra",
    "Swati",
    "Vishakha",
    "Anuradha",
    "Jyeshtha",
    "Mula",
    "Purva Ashadha",
    "Uttara Ashadha",
    "Shravana",
    "Dhanishtha",
    "Shatabhisha",
    "Purva Bhadrapada",
    "Uttara Bhadrapada",
    "Revati",
]

NAKSHATRA_TAMIL = [
    "Ashwini",
    "Bharani",
    "Karthigai",
    "Rohini",
    "Mrigashirisham",
    "Thiruvathirai",
    "Punarpoosam",
    "Poosam",
    "Ayilyam",
    "Magam",
    "Pooram",
    "Uthiram",
    "Hastham",
    "Chithirai",
    "Swathi",
    "Vishakam",
    "Anusham",
    "Kettai",
    "Moolam",
    "Pooradam",
    "Uthiradam",
    "Thiruvonam",
    "Avittam",
    "Sadayam",
    "Poorattathi",
    "Uthirattathi",
    "Revathi",
]

YOGA_NAMES = [
    "Vishkambha",
    "Priti",
    "Ayushman",
    "Saubhagya",
    "Shobhana",
    "Atiganda",
    "Sukarma",
    "Dhriti",
    "Shula",
    "Ganda",
    "Vriddhi",
    "Dhruva",
    "Vyaghata",
    "Harshana",
    "Vajra",
    "Siddhi",
    "Vyatipata",
    "Variyana",
    "Parigha",
    "Shiva",
    "Siddha",
    "Sadhya",
    "Shubha",
    "Shukla",
    "Brahma",
    "Indra",
    "Vaidhriti",
]

MOVABLE_KARANAS = ["Bava", "Balava", "Kaulava", "Taitila", "Gara", "Vanija", "Vishti"]

SOLAR_MONTHS = [
    "Mesha",
    "Vrishabha",
    "Mithuna",
    "Karka",
    "Simha",
    "Kanya",
    "Tula",
    "Vrishchika",
    "Dhanu",
    "Makara",
    "Kumbha",
    "Meena",
]

SOLAR_MONTHS_TAMIL = [
    "Chithirai",
    "Vaikasi",
    "Aani",
    "Aadi",
    "Avani",
    "Purattasi",
    "Aippasi",
    "Karthigai",
    "Margazhi",
    "Thai",
    "Maasi",
    "Panguni",
]

SOLAR_MONTHS_MALAYALAM = [
    "Medam",
    "Edavam",
    "Mithunam",
    "Karkidakam",
    "Chingam",
    "Kanni",
    "Thulam",
    "Vrischikam",
    "Dhanu",
    "Makaram",
    "Kumbham",
    "Meenam",
]

LUNAR_MONTHS = [
    "Chaitra",
    "Vaisakha",
    "Jyeshtha",
    "Ashadha",
    "Shravana",
    "Bhadrapada",
    "Ashwina",
    "Kartika",
    "Margashirsha",
    "Pausha",
    "Magha",
    "Phalguna",
]

# South Indian lunar month names follow the solar-month cycle closely.
LUNAR_MONTHS_TAMIL = SOLAR_MONTHS_TAMIL

WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

# Aliases accepted from CSVs, sidecars and Gramps attributes.
SOLAR_MASA_ALIASES: dict[str, int] = {}
for _i, _names in enumerate(
    zip(
        SOLAR_MONTHS,
        SOLAR_MONTHS_TAMIL,
        SOLAR_MONTHS_MALAYALAM,
    )
):
    for _name in _names:
        SOLAR_MASA_ALIASES[_name.lower()] = _i
SOLAR_MASA_ALIASES.update(
    {
        "karkataka": 3,
        "karkata": 3,
        "karkidaka": 3,
        "karkidakam": 3,
        "aadi": 3,
        "aadi masam": 3,
        "simha": 4,
        "chingam": 4,
        "avani": 4,
        "kanya": 5,
        "kanni": 5,
        "purattasi": 5,
        "tula": 6,
        "thulam": 6,
        "aippasi": 6,
        "vrischika": 7,
        "vrischikam": 7,
        "karthigai": 7,
        "dhanu": 8,
        "margazhi": 8,
        "makara": 9,
        "makaram": 9,
        "thai": 9,
        "kumbha": 10,
        "kumbham": 10,
        "maasi": 10,
        "meena": 11,
        "meenam": 11,
        "panguni": 11,
    }
)

LUNAR_MASA_ALIASES: dict[str, int] = {}
for _i, _name in enumerate(LUNAR_MONTHS):
    LUNAR_MASA_ALIASES[_name.lower()] = _i
LUNAR_MASA_ALIASES.update(
    {
        "chaitra": 0,
        "vaisakha": 1,
        "vaisakh": 1,
        "jyeshtha": 2,
        "jyeshta": 2,
        "ashadha": 3,
        "asadha": 3,
        "shravana": 4,
        "sravana": 4,
        "bhadrapada": 5,
        "bhadra": 5,
        "ashwina": 6,
        "ashwin": 6,
        "aswina": 6,
        "kartika": 7,
        "karthika": 7,
        "margashirsha": 8,
        "margasira": 8,
        "pausha": 9,
        "pusya": 9,
        "magha": 10,
        "phalguna": 11,
    }
)

TITHI_ALIASES = {
    name.lower(): i + 1
    for i, name in enumerate(
        [
            "Pratipada",
            "Dwitiya",
            "Tritiya",
            "Chaturthi",
            "Panchami",
            "Shashthi",
            "Saptami",
            "Ashtami",
            "Navami",
            "Dashami",
            "Ekadasi",
            "Dwadasi",
            "Trayodasi",
            "Chaturdasi",
            "Purnima",
        ]
    )
}
TITHI_ALIASES.update(
    {
        "pratama": 1,
        "prathama": 1,
        "dwitiya": 2,
        "dvitia": 2,
        "tritiya": 3,
        "chaturthi": 4,
        "panchami": 5,
        "shashti": 6,
        "sashti": 6,
        "saptami": 7,
        "ashtami": 8,
        "navami": 9,
        "dashami": 10,
        "dasami": 10,
        "ekadashi": 11,
        "ekadasi": 11,
        "dwadashi": 12,
        "dwadasi": 12,
        "trayodashi": 13,
        "trayodasi": 13,
        "chaturdashi": 14,
        "chaturdasi": 14,
        "pournami": 15,
        "purnima": 15,
        "amavasya": 30,
        "amavasai": 30,
        "amavasi": 30,
        "new moon": 30,
        "full moon": 15,
    }
)

NAKSHATRA_ALIASES: dict[str, int] = {}
for _i, _name in enumerate(NAKSHATRA_NAMES):
    NAKSHATRA_ALIASES[_name.lower()] = _i + 1
for _i, _name in enumerate(NAKSHATRA_TAMIL):
    NAKSHATRA_ALIASES.setdefault(_name.lower(), _i + 1)
NAKSHATRA_ALIASES.update(
    {
        "karthigai": 3,
        "krittika": 3,
        "rohini": 4,
        "mrigashira": 5,
        "mrigashirsha": 5,
        "thiruvathirai": 6,
        "ardra": 6,
        "punarvasu": 7,
        "punarpoosam": 7,
        "pushya": 8,
        "poosam": 8,
        "ashlesha": 9,
        "ayilyam": 9,
        "magha": 10,
        "magam": 10,
        "purva phalguni": 11,
        "pooram": 11,
        "uttara phalguni": 12,
        "uthiram": 12,
        "hasta": 13,
        "hastham": 13,
        "chitra": 14,
        "chithirai": 14,
        "swati": 15,
        "swathi": 15,
        "vishakha": 16,
        "vishakam": 16,
        "anuradha": 17,
        "anusham": 17,
        "jyeshtha": 18,
        "kettai": 18,
        "mula": 19,
        "moolam": 19,
        "purva ashadha": 20,
        "pooradam": 20,
        "uttara ashadha": 21,
        "uthiradam": 21,
        "shravana": 22,
        "thiruvonam": 22,
        "dhanishtha": 23,
        "avittam": 23,
        "shatabhisha": 24,
        "sadayam": 24,
        "purva bhadrapada": 25,
        "poorattathi": 25,
        "uttara bhadrapada": 26,
        "uthirattathi": 26,
        "revati": 27,
        "revathi": 27,
    }
)

# ---------------------------------------------------------------------------
# exceptions / state
# ---------------------------------------------------------------------------


class AstronomyError(RuntimeError):
    pass


_LOCK = threading.RLock()
_CONFIGURED = False
_AYANAMSHA_MODES = {
    "lahiri": swe.SIDM_LAHIRI,
    "chitrapaksha": swe.SIDM_LAHIRI,
    "raman": swe.SIDM_RAMAN,
    "krishnamurti": swe.SIDM_KRISHNAMURTI,
    "kp": swe.SIDM_KRISHNAMURTI,
    "yukteshwar": swe.SIDM_YUKTESHWAR,
    "fagan": swe.SIDM_FAGAN_BRADLEY,
}


def configure(ayanamsha: str = "lahiri", ephe_path: str | None = None) -> None:
    """Set Swiss Ephemeris global state.  Safe to call repeatedly."""

    global _CONFIGURED
    with _LOCK:
        if ephe_path:
            swe.set_ephe_path(ephe_path)
        mode = _AYANAMSHA_MODES.get(ayanamsha.lower())
        if mode is None:
            raise AstronomyError(
                f"Unknown ayanamsha {ayanamsha!r}; use one of {sorted(_AYANAMSHA_MODES)}"
            )
        swe.set_sid_mode(mode, 0, 0)
        _CONFIGURED = True


def _ensure_configured() -> None:
    if not _CONFIGURED:
        configure()


def timezone_for(location: LocationConfig) -> ZoneInfo:
    try:
        return ZoneInfo(location.timezone)
    except ZoneInfoNotFoundError as exc:
        raise AstronomyError(f"Unknown timezone {location.timezone!r}") from exc


def _calc(jd: float, body: int) -> tuple[float, float]:
    _ensure_configured()
    try:
        values, flags = swe.calc_ut(
            jd, body, swe.FLG_SWIEPH | swe.FLG_SIDEREAL
        )
    except Exception:
        values, flags = swe.calc_ut(
            jd, body, swe.FLG_MOSEPH | swe.FLG_SIDEREAL
        )
    if flags < 0:
        raise AstronomyError(f"Swiss Ephemeris error for body {body}")
    return float(values[0]), float(values[1])


def sun_longitude(jd: float) -> float:
    return _calc(jd, swe.SUN)[0] % 360.0


def moon_longitude(jd: float) -> float:
    return _calc(jd, swe.MOON)[0] % 360.0


def sun_moon_difference(jd: float) -> float:
    return (moon_longitude(jd) - sun_longitude(jd)) % 360.0


def to_jd(dt: datetime) -> float:
    if dt.tzinfo is None:
        raise AstronomyError("Datetime must be timezone-aware")
    utc = dt.astimezone(timezone.utc)
    hours = utc.hour + utc.minute / 60.0 + utc.second / 3600.0 + utc.microsecond / 3.6e9
    return swe.julday(utc.year, utc.month, utc.day, hours)


def from_jd(jd: float, tz: ZoneInfo) -> datetime:
    year, month, day, hour = swe.revjul(jd, swe.GREG_CAL)
    utc = datetime(year, month, day, tzinfo=timezone.utc) + timedelta(hours=hour)
    return utc.astimezone(tz)


def local_midnight(day: date, tz: ZoneInfo) -> datetime:
    return datetime(day.year, day.month, day.day, tzinfo=tz)


# ---------------------------------------------------------------------------
# states
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TithiState:
    index: int
    name: str
    tamil_name: str
    paksha: str
    fraction: float
    difference: float

    @property
    def label(self) -> str:
        if self.index == 30:
            return "Amavasya"
        if self.index == 15:
            return "Purnima"
        return f"{self.paksha} {self.name}"

    def as_dict(self) -> dict:
        return {
            "index": self.index,
            "name": self.name,
            "label": self.label,
            "tamil_name": self.tamil_name,
            "paksha": self.paksha,
            "fraction": round(self.fraction, 5),
            "difference_deg": round(self.difference, 5),
        }


@dataclass(frozen=True)
class NakshatraState:
    index: int
    name: str
    tamil_name: str
    pada: int
    longitude: float

    def as_dict(self) -> dict:
        return {
            "index": self.index,
            "name": self.name,
            "tamil_name": self.tamil_name,
            "pada": self.pada,
            "longitude_deg": round(self.longitude, 5),
        }


@dataclass(frozen=True)
class YogaState:
    index: int
    name: str

    def as_dict(self) -> dict:
        return {"index": self.index, "name": self.name}


@dataclass(frozen=True)
class KaranaState:
    index: int
    name: str

    def as_dict(self) -> dict:
        return {"index": self.index, "name": self.name}


@dataclass(frozen=True)
class MasaState:
    name: str
    tamil_name: str
    malayalam_name: str
    index: int
    system: str
    adhika: bool = False
    start: datetime | None = None
    end: datetime | None = None

    @property
    def label(self) -> str:
        prefix = "Adhika " if self.adhika else ""
        return f"{prefix}{self.name} ({self.tamil_name})"

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "tamil_name": self.tamil_name,
            "malayalam_name": self.malayalam_name,
            "index": self.index,
            "system": self.system,
            "adhika": self.adhika,
            "label": self.label,
            "start": self.start.isoformat() if self.start else None,
            "end": self.end.isoformat() if self.end else None,
        }


def tithi_state(jd: float) -> TithiState:
    diff = sun_moon_difference(jd)
    index = int(diff / 12.0) + 1
    if index > 30:
        index = 30
    paksha = "Sukla" if index <= 15 else "Krishna"
    return TithiState(
        index=index,
        name=TITHI_NAMES[index - 1],
        tamil_name=TITHI_TAMIL[index - 1],
        paksha=paksha,
        fraction=(diff % 12.0) / 12.0,
        difference=diff,
    )


def nakshatra_state(jd: float) -> NakshatraState:
    lon = moon_longitude(jd)
    span = 360.0 / 27.0
    index = int(lon / span) + 1
    if index > 27:
        index = 27
    pada = int((lon % span) / (span / 4.0)) + 1
    return NakshatraState(
        index=index,
        name=NAKSHATRA_NAMES[index - 1],
        tamil_name=NAKSHATRA_TAMIL[index - 1],
        pada=pada,
        longitude=lon,
    )


def yoga_state(jd: float) -> YogaState:
    total = (sun_longitude(jd) + moon_longitude(jd)) % 360.0
    index = int(total / (360.0 / 27.0)) + 1
    if index > 27:
        index = 27
    return YogaState(index=index, name=YOGA_NAMES[index - 1])


def karana_state(jd: float) -> KaranaState:
    diff = sun_moon_difference(jd)
    index = int(diff / 6.0) + 1
    if index > 60:
        index = 60
    if index == 1:
        name = "Kimstughna"
    elif index >= 58:
        name = {58: "Shakuni", 59: "Chatushpada", 60: "Naga"}[index]
    else:
        name = MOVABLE_KARANAS[(index - 2) % 7]
    return KaranaState(index=index, name=name)


# ---------------------------------------------------------------------------
# sunrise / sunset / ritual windows
# ---------------------------------------------------------------------------


def _geopos(location: LocationConfig) -> tuple[float, float, float]:
    return (location.longitude, location.latitude, location.elevation_m)


def _rise_trans(
    day: date,
    location: LocationConfig,
    event: int,
    tz: ZoneInfo,
) -> datetime:
    _ensure_configured()
    _LOCAL = local_midnight(day, tz)
    jd0 = to_jd(_LOCAL)
    with _LOCK:
        swe.set_topo(location.longitude, location.latitude, location.elevation_m)
        try:
            result = swe.rise_trans(
                jd0,
                swe.SUN,
                event,
                _geopos(location),
            )
        except Exception as exc:  # pragma: no cover - defensive
            raise AstronomyError(f"Sunrise/sunset calculation failed: {exc}") from exc
    flag, times = result[0], result[1]
    if flag < 0:
        raise AstronomyError(
            f"Sun event {event} does not occur on {day} at {location.name}"
        )
    return from_jd(float(times[0]), tz)


def sunrise(day: date, location: LocationConfig) -> datetime:
    tz = timezone_for(location)
    return _rise_trans(day, location, swe.CALC_RISE, tz)


def sunset(day: date, location: LocationConfig) -> datetime:
    tz = timezone_for(location)
    return _rise_trans(day, location, swe.CALC_SET, tz)


def solar_noon(day: date, location: LocationConfig) -> datetime:
    """Meridian transit if Swiss Ephemeris supports it, else sunrise/sunset midpoint."""

    tz = timezone_for(location)
    _ensure_configured()
    jd0 = to_jd(local_midnight(day, tz))
    transit = getattr(swe, "CALC_MTRANS", None)
    if transit is not None:
        with _LOCK:
            swe.set_topo(location.longitude, location.latitude, location.elevation_m)
            try:
                result = swe.rise_trans(
                    jd0,
                    swe.SUN,
                    transit,
                    _geopos(location),
                )
                if result[0] >= 0:
                    return from_jd(float(result[1][0]), tz)
            except Exception:
                pass
    rise = sunrise(day, location)
    sets = sunset(day, location)
    return rise + (sets - rise) / 2


def at_local_time(day: date, clock: time, location: LocationConfig) -> datetime:
    tz = timezone_for(location)
    return datetime(day.year, day.month, day.day, clock.hour, clock.minute, tzinfo=tz)


def aparahna_window(
    day: date, location: LocationConfig, start: time, end: time
) -> tuple[datetime, datetime]:
    return (
        at_local_time(day, start, location),
        at_local_time(day, end, location),
    )


def pradosha_window(
    day: date,
    location: LocationConfig,
    before_minutes: int,
    after_minutes: int,
) -> tuple[datetime, datetime]:
    sets = sunset(day, location)
    return (
        sets - timedelta(minutes=before_minutes),
        sets + timedelta(minutes=after_minutes),
    )


# ---------------------------------------------------------------------------
# tithi / nakshatra boundaries
# ---------------------------------------------------------------------------


def _find_boundary(
    jd: float,
    state_fn,
    direction: int,
    max_days: float = 2.5,
    step_days: float = 0.125,
) -> float | None:
    """Find the nearest point where ``state_fn`` changes value."""

    current = state_fn(jd)
    previous = jd
    probe = jd
    limit = max_days / step_days
    for _ in range(int(limit) + 1):
        probe += direction * step_days
        if state_fn(probe) != current:
            lo, hi = sorted((previous, probe))
            for _ in range(60):
                mid = (lo + hi) / 2.0
                if state_fn(mid) == current:
                    lo = mid
                else:
                    hi = mid
            return (lo + hi) / 2.0
        previous = probe
    return None


def tithi_bounds(
    jd: float, location: LocationConfig
) -> tuple[datetime | None, datetime | None]:
    tz = timezone_for(location)
    start = _find_boundary(jd, lambda j: tithi_state(j).index, -1)
    end = _find_boundary(jd, lambda j: tithi_state(j).index, +1)
    return (
        from_jd(start, tz) if start is not None else None,
        from_jd(end, tz) if end is not None else None,
    )


def nakshatra_bounds(
    jd: float, location: LocationConfig
) -> tuple[datetime | None, datetime | None]:
    tz = timezone_for(location)
    start = _find_boundary(jd, lambda j: nakshatra_state(j).index, -1)
    end = _find_boundary(jd, lambda j: nakshatra_state(j).index, +1)
    return (
        from_jd(start, tz) if start is not None else None,
        from_jd(end, tz) if end is not None else None,
    )


# ---------------------------------------------------------------------------
# lunar phases / solar ingresses
# ---------------------------------------------------------------------------


def _signed_angle(value: float) -> float:
    return ((value + 180.0) % 360.0) - 180.0


def _find_phase_crossing(jd: float, target: float, direction: int) -> float | None:
    """Find a crossing of ``(moon - sun) == target`` near ``jd``."""

    def offset(j: float) -> float:
        return _signed_angle(sun_moon_difference(j) - target)

    step = 0.125
    probe = jd
    previous = offset(probe)
    for _ in range(int(40 / step)):
        probe += direction * step
        current = offset(probe)
        crossed = (
            previous < 0.0 <= current
            if direction > 0
            else current < 0.0 <= previous
        )
        if crossed:
            lo, hi = sorted((probe - direction * step, probe))
            for _ in range(60):
                mid = (lo + hi) / 2.0
                if offset(mid) < 0.0:
                    lo = mid
                else:
                    hi = mid
            return (lo + hi) / 2.0
        previous = current
    return None


def new_moon_near(dt: datetime, direction: int = 0) -> datetime:
    """Return the previous (direction=-1), next (+1) or nearest (0) new moon."""

    tz = dt.tzinfo if isinstance(dt.tzinfo, ZoneInfo) else timezone.utc
    jd = to_jd(dt)
    candidates: list[float] = []
    if direction <= 0:
        found = _find_phase_crossing(jd, 0.0, -1)
        if found is not None:
            candidates.append(found)
            candidates.append(found - 29.53)
    if direction >= 0:
        found = _find_phase_crossing(jd, 0.0, +1)
        if found is not None:
            candidates.append(found)
            candidates.append(found + 29.53)
    if not candidates:
        raise AstronomyError("Could not locate a new moon")
    if direction == 0:
        chosen = min(candidates, key=lambda j: abs(j - jd))
    elif direction < 0:
        valid = [j for j in candidates if j <= jd]
        chosen = max(valid) if valid else min(candidates)
    else:
        valid = [j for j in candidates if j >= jd]
        chosen = min(valid) if valid else max(candidates)
    return from_jd(chosen, tz)


def full_moon_near(dt: datetime, direction: int = 0) -> datetime:
    tz = dt.tzinfo if isinstance(dt.tzinfo, ZoneInfo) else timezone.utc
    jd = to_jd(dt)
    candidates: list[float] = []
    if direction <= 0:
        found = _find_phase_crossing(jd, 180.0, -1)
        if found is not None:
            candidates.append(found)
            candidates.append(found - 29.53)
    if direction >= 0:
        found = _find_phase_crossing(jd, 180.0, +1)
        if found is not None:
            candidates.append(found)
            candidates.append(found + 29.53)
    if not candidates:
        raise AstronomyError("Could not locate a full moon")
    if direction == 0:
        chosen = min(candidates, key=lambda j: abs(j - jd))
    elif direction < 0:
        valid = [j for j in candidates if j <= jd]
        chosen = max(valid) if valid else min(candidates)
    else:
        valid = [j for j in candidates if j >= jd]
        chosen = min(valid) if valid else max(candidates)
    return from_jd(chosen, tz)


def _solar_ingress_after(dt: datetime) -> datetime:
    """Return the next sidereal solar ingress (30° boundary)."""

    tz = dt.tzinfo if isinstance(dt.tzinfo, ZoneInfo) else timezone.utc
    jd = to_jd(dt)
    target = (int(sun_longitude(jd) / 30.0) + 1) * 30.0
    if target >= 360.0:
        target -= 360.0

    def offset(j: float) -> float:
        return _signed_angle(sun_longitude(j) - target)

    step = 0.25
    probe = jd
    previous = offset(probe)
    for _ in range(int(45 / step)):
        probe += step
        current = offset(probe)
        if previous < 0.0 <= current:
            lo, hi = sorted((probe - step, probe))
            for _ in range(60):
                mid = (lo + hi) / 2.0
                if offset(mid) < 0.0:
                    lo = mid
                else:
                    hi = mid
            return from_jd((lo + hi) / 2.0, tz)
        previous = current
    raise AstronomyError("Could not find next solar ingress")


def _solar_ingress_before(dt: datetime) -> datetime:
    """Return the previous sidereal solar ingress (30° boundary)."""

    tz = dt.tzinfo if isinstance(dt.tzinfo, ZoneInfo) else timezone.utc
    jd = to_jd(dt)
    sign = int(sun_longitude(jd) / 30.0)
    target = sign * 30.0

    def offset(j: float) -> float:
        return _signed_angle(sun_longitude(j) - target)

    step = 0.25
    probe = jd
    previous = offset(probe)
    for _ in range(int(45 / step)):
        probe -= step
        current = offset(probe)
        if current < 0.0 <= previous:
            lo, hi = sorted((probe, probe + step))
            for _ in range(60):
                mid = (lo + hi) / 2.0
                if offset(mid) < 0.0:
                    lo = mid
                else:
                    hi = mid
            return from_jd((lo + hi) / 2.0, tz)
        previous = current
    raise AstronomyError("Could not find previous solar ingress")


def solar_sign(jd: float) -> int:
    return int(sun_longitude(jd) / 30.0) % 12


def solar_masa(jd: float, location: LocationConfig) -> MasaState:
    sign = solar_sign(jd)
    tz = timezone_for(location)
    at = from_jd(jd, tz)
    try:
        start = _solar_ingress_before(at)
        end = _solar_ingress_after(at)
    except AstronomyError:
        start = end = None
    return MasaState(
        name=SOLAR_MONTHS[sign],
        tamil_name=SOLAR_MONTHS_TAMIL[sign],
        malayalam_name=SOLAR_MONTHS_MALAYALAM[sign],
        index=sign,
        system="solar",
        start=start,
        end=end,
    )


def lunar_masa(
    jd: float, location: LocationConfig, system: str = "lunar_amanta"
) -> MasaState:
    tz = timezone_for(location)
    at = from_jd(jd, tz)
    previous = new_moon_near(at, -1)
    following = new_moon_near(at, +1)
    sign_prev = solar_sign(to_jd(previous))
    sign_next = solar_sign(to_jd(following))
    month_index = (sign_prev - 11) % 12
    adhika = sign_prev == sign_next
    if system == "lunar_purnimanta" and tithi_state(jd).index > 15:
        month_index = (month_index + 1) % 12
    return MasaState(
        name=LUNAR_MONTHS[month_index],
        tamil_name=LUNAR_MONTHS_TAMIL[month_index],
        malayalam_name=SOLAR_MONTHS_MALAYALAM[month_index],
        index=month_index,
        system=system,
        adhika=adhika,
        start=previous,
        end=following,
    )


def masa_state(
    jd: float, location: LocationConfig, system: str = "solar"
) -> MasaState:
    if system == "solar":
        return solar_masa(jd, location)
    return lunar_masa(jd, location, system)


# ---------------------------------------------------------------------------
# normalisation helpers
# ---------------------------------------------------------------------------


def parse_tithi(value: str | int | None, paksha: str | None = None) -> int | None:
    """Resolve a tithi name/number to 1..30.

    ``paksha`` disambiguates names such as Panchami.  A bare name defaults to
    the Sukla paksha only when no paksha is supplied; callers should normally
    pass the paksha stored alongside the name.
    """

    if value is None or value == "":
        return None
    if isinstance(value, int):
        index = value
    else:
        text = str(value).strip().lower()
        if text.isdigit():
            index = int(text)
        else:
            index = TITHI_ALIASES.get(text)
            if index is None:
                # allow "shukla panchami" / "krishna panchami"
                parts = text.replace("-", " ").split()
                for part in parts:
                    if part in {"sukla", "shukla", "valarpirai"}:
                        paksha = "Sukla"
                    elif part in {"krishna", "theipirai"}:
                        paksha = "Krishna"
                    elif part in TITHI_ALIASES:
                        index = TITHI_ALIASES[part]
                if index is None:
                    return None
    if not 1 <= index <= 30:
        return None
    if paksha:
        p = paksha.strip().lower()
        if p in {"sukla", "shukla", "valarpirai", "waxing"} and index > 15:
            # Names like "Panchami" plus Sukla mean the first fortnight.
            if index >= 16 and index <= 29:
                index -= 15
            elif index == 30:
                index = 15
        elif p in {"krishna", "theipirai", "waning"} and index <= 15:
            if index == 15:
                index = 30
            else:
                index += 15
    return index


def tithi_name(index: int) -> str:
    return TITHI_NAMES[index - 1]


def parse_nakshatra(value: str | int | None) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value, int):
        return value if 1 <= value <= 27 else None
    text = str(value).strip().lower()
    if text.isdigit():
        n = int(text)
        return n if 1 <= n <= 27 else None
    return NAKSHATRA_ALIASES.get(text)


def parse_solar_masa(value: str | int | None) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value, int):
        return value % 12
    text = str(value).strip().lower()
    if text.isdigit():
        return int(text) % 12
    return SOLAR_MASA_ALIASES.get(text)


def parse_lunar_masa(value: str | int | None) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value, int):
        return value % 12
    text = str(value).strip().lower()
    if text.isdigit():
        return int(text) % 12
    return LUNAR_MASA_ALIASES.get(text)


def format_time(dt: datetime | None) -> str:
    if dt is None:
        return "—"
    return dt.strftime("%H:%M")
