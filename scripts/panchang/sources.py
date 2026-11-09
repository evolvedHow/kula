"""Family data sources for the panchangam engine.

The public site is built from the relatives Google Sheet, and the importer
writes the normalised result to ``docs/data/tree.json``.  That file is the
default and preferred source here: it already contains the dates, the living
status, the gotra and (when a birth time and place are known) the Moon's
nakshatra from :mod:`scripts.horoscope`.

A CSV or Google-Sheets CSV export is also supported for ad-hoc work.

A small overrides file (``docs/data/panchang-overrides.json``) can add exact
birth/death times, an explicitly recorded tithi/masa, or a ritual location.
Overrides never change the family tree itself.
"""

from __future__ import annotations

import csv
import io
import json
import re
import urllib.request
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any

from .config import AppConfig, LocationConfig
from .models import FamilyData, FamilyMember

_EXCEL_EPOCH = datetime(1899, 12, 30)
_TIME_RE = re.compile(r"(?<!\d)(\d{1,2})[:.](\d{1,2})(?::\d{2})?(?!\d)")
_SERIAL_RE = re.compile(r"^\d{4,6}(?:\.\d+)?$")


# ---------------------------------------------------------------------------
# dates and small helpers
# ---------------------------------------------------------------------------


def parse_date_time(value: Any) -> tuple[date | None, time | None, bool]:
    """Parse a sheet/tree date string into ``(date, time, had_time)``.

    The Google Sheet stores dates in several human formats.  ``tree.json`` keeps
    the display string rather than a canonical timestamp, so this function is
    deliberately tolerant.  A missing time, or an explicit midnight, is treated
    as "time unknown" for the purpose of the panchangam.
    """

    if isinstance(value, datetime):
        clock = value.time().replace(microsecond=0)
        return value.date(), (None if clock == time(0, 0) else clock), clock != time(0, 0)
    if isinstance(value, date):
        return value, None, False
    text = str(value or "").strip()
    if not text:
        return None, None, False

    # Excel / Google Sheets serial date.
    if _SERIAL_RE.fullmatch(text):
        serial = float(text)
        # A bare 4-digit number such as "1946" is a year, not a serial.
        if len(text.split(".")[0]) >= 5 or "." in text:
            days = int(serial)
            minutes = round((serial - days) * 1440)
            dt = _EXCEL_EPOCH + timedelta(days=days, minutes=minutes)
            clock = dt.time().replace(microsecond=0)
            has_time = clock != time(0, 0)
            return dt.date(), (clock if has_time else None), has_time

    has_time = bool(_TIME_RE.search(text))
    clock = None
    if has_time:
        match = _TIME_RE.search(text)
        hour, minute = int(match.group(1)), int(match.group(2))
        if hour > 23 or minute > 59:
            has_time = False
        else:
            clock = time(hour, minute)
            if clock == time(0, 0):
                # Midnight in a sheet usually means "no time recorded".
                has_time = False
                clock = None

    try:
        from dateutil import parser as date_parser

        dt = date_parser.parse(text, dayfirst=True, fuzzy=True)
        return dt.date(), clock, has_time
    except Exception:
        return None, None, False


def _parse_time(value: Any) -> time | None:
    if isinstance(value, time):
        return value
    if not value:
        return None
    match = _TIME_RE.search(str(value))
    if not match:
        return None
    try:
        return time(int(match.group(1)), int(match.group(2)))
    except ValueError:
        return None


def _bool(value: Any, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on", "y"}


def _location(value: Any, fallback: LocationConfig) -> LocationConfig:
    if isinstance(value, LocationConfig):
        return value
    if isinstance(value, dict):
        merged = {**fallback.as_dict(), **{k: v for k, v in value.items() if v is not None}}
        return LocationConfig.from_dict(merged)
    if isinstance(value, str) and value.strip().lower() == fallback.name.strip().lower():
        return fallback
    return fallback


def _text(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("string") or value.get("value") or "")
    return str(value or "")


def _status_from_person(person: dict[str, Any]) -> str:
    if person.get("living") is False or person.get("death"):
        return "Deceased"
    if person.get("living") is True:
        return "Living"
    raw = str((person.get("attributes") or {}).get("STATUS") or "").strip().lower()
    return "Deceased" if raw.startswith("deceased") else "Living"


def _display_path(path: Path, root: Path) -> str:
    """Keep published metadata free of absolute build-machine paths."""

    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


# ---------------------------------------------------------------------------
# overrides
# ---------------------------------------------------------------------------


def load_overrides(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"defaults": {}, "people": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid overrides JSON in {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"Overrides root must be an object: {path}")
    people = data.get("people")
    if people is None:
        people = {
            key: value
            for key, value in data.items()
            if key not in {"schema", "defaults"} and isinstance(value, dict)
        }
    return {"defaults": data.get("defaults") or {}, "people": people or {}}


def _apply_override(member: FamilyMember, override: dict[str, Any]) -> None:
    """Merge the fields that are safe to override, in place."""

    if not override:
        return
    for field in (
        "name",
        "status",
        "gotra",
        "tradition",
        "birth_place",
        "death_place",
        "birth_masa",
        "death_masa",
        "death_paksha",
        "death_tithi",
        "death_masa_system",
        "birth_nakshatra",
        "birth_masa_system",
    ):
        if override.get(field) not in (None, ""):
            setattr(member, field, override[field])
    for field in ("birth_date", "death_date"):
        if override.get(field):
            parsed, _, _ = parse_date_time(override[field])
            if parsed:
                setattr(member, field, parsed)
    for field in ("birth_time", "death_time"):
        if override.get(field):
            parsed = _parse_time(override[field])
            if parsed:
                setattr(member, field, parsed)
    if override.get("location"):
        member.location = _location(override["location"], member.location or LocationConfig())
    if override.get("private") is not None:
        member.private = _bool(override["private"], member.private)
    if override.get("include") is not None:
        member.include = _bool(override["include"], member.include)
    if override.get("notes"):
        member.notes.extend(str(n) for n in override["notes"])
    member.raw["overrides"] = override


def _from_override_only(
    pid: str,
    override: dict[str, Any],
    default_location: LocationConfig,
    defaults: dict[str, Any],
) -> FamilyMember | None:
    """Build a member that exists only in the overrides file.

    This is useful for a spouse or ancestor who is not yet in the sheet, or for
    testing the engine without publishing anything.
    """

    if not override.get("name"):
        return None
    member = FamilyMember(
        pid=pid,
        name=str(override["name"]),
        status=str(override.get("status", "Living")),
        gotra=override.get("gotra", defaults.get("gotra")),
        tradition=override.get("tradition", defaults.get("tradition")),
        location=_location(override.get("location"), default_location),
        private=_bool(override.get("private"), False),
        include=_bool(override.get("include"), True),
        source="overrides",
    )
    _apply_override(member, override)
    return member


# ---------------------------------------------------------------------------
# docs/data/tree.json (the site build)
# ---------------------------------------------------------------------------


def load_from_tree(config: AppConfig, path: Path | None = None) -> FamilyData:
    path = path or config.tree_path
    if not path.exists():
        raise FileNotFoundError(
            f"Family tree data not found: {path}. Run scripts/import_sheet.py first."
        )
    try:
        tree = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid tree JSON in {path}: {exc}") from exc

    overrides = load_overrides(config.overrides_path)
    defaults = overrides["defaults"]
    sidecar_people = overrides["people"]
    default_location = _location(defaults.get("location"), config.location)
    default_gotra = defaults.get("gotra")
    default_tradition = defaults.get("tradition")
    default_masa_system = defaults.get("masa_system") or config.calendar.masa_system

    members: list[FamilyMember] = []
    warnings: list[str] = []
    skipped = 0
    skipped_private = 0

    for person in tree.get("people") or []:
        pid = str(person.get("id") or (person.get("attributes") or {}).get("PID") or "")
        if not pid:
            continue
        if person.get("hidden"):
            skipped_private += 1
            continue
        override = sidecar_people.get(pid) or {}

        attributes = person.get("attributes") or {}
        birth = person.get("birth") or {}
        death = person.get("death") or {}
        vedic = person.get("vedic") or {}
        chart = vedic.get("chart") or {}
        moon = chart.get("moon") or {}

        birth_date, birth_time, birth_has_time = parse_date_time(
            birth.get("date") or attributes.get("DOB")
        )
        death_date, death_time, death_has_time = parse_date_time(
            death.get("date") or attributes.get("DOD")
        )

        status = _status_from_person(person)
        member = FamilyMember(
            pid=pid,
            name=str(((person.get("name") or {}).get("display")) or attributes.get("FULL_NAME") or pid),
            status=status,
            gender=str(person.get("gender") or "") or None,
            gotra=override.get("gotra", vedic.get("gotra") or default_gotra),
            birth_date=birth_date,
            death_date=death_date,
            birth_time=birth_time if birth_has_time else None,
            death_time=death_time if death_has_time else None,
            birth_place=birth.get("place") or attributes.get("POB") or None,
            death_place=death.get("place") or attributes.get("POD") or None,
            birth_nakshatra=override.get(
                "birth_nakshatra",
                vedic.get("nakshatra") or moon.get("nakshatra"),
            ),
            birth_masa=override.get("birth_masa"),
            death_masa=override.get("death_masa"),
            death_paksha=override.get("death_paksha"),
            death_tithi=override.get("death_tithi"),
            death_masa_system=override.get(
                "death_masa_system", defaults.get("masa_system", default_masa_system)
            ),
            birth_masa_system=override.get(
                "birth_masa_system", defaults.get("masa_system", default_masa_system)
            ),
            location=_location(override.get("location"), default_location),
            tradition=override.get("tradition", defaults.get("tradition", default_tradition)),
            private=bool(person.get("hidden")),
            include=_bool(override.get("include"), True),
            source="tree",
            raw={
                "tree_id": pid,
                "ref_name": person.get("ref_name"),
                "generation": person.get("generation"),
                "chart": chart or None,
                "attributes": attributes,
                "metadata": {},
            },
        )
        _apply_override(member, override)

        if member.private and not config.calendar.include.private_members:
            skipped_private += 1
            continue
        if not member.include:
            continue
        if member.is_deceased:
            if not config.calendar.include.deceased_members:
                continue
            has_data = bool(
                member.death_date
                or member.death_tithi
                or (member.death_masa and member.death_paksha)
            )
        else:
            if not config.calendar.include.living_members:
                continue
            has_data = bool(member.birth_date or member.birth_nakshatra)
        if not has_data:
            skipped += 1
            continue
        members.append(member)

    # Members that exist only in the overrides file.
    tree_ids = {str(p.get("id")) for p in tree.get("people") or []}
    for pid, override in sidecar_people.items():
        if pid in tree_ids:
            continue
        member = _from_override_only(pid, override, default_location, defaults)
        if member and member.include:
            members.append(member)

    if skipped:
        warnings.append(
            f"{skipped} people had no usable birth/death date or astro metadata and were skipped."
        )
    if skipped_private:
        warnings.append(f"{skipped_private} private/hidden people were skipped.")
    warnings.append(
        f"Loaded {len(members)} family members from {_display_path(path, config.repo_root)}."
    )
    return FamilyData(
        members=members,
        source="tree",
        warnings=warnings,
        metadata={
            "tree": _display_path(path, config.repo_root),
            "generated_at": tree.get("generated_at"),
            "people_count": len(tree.get("people") or []),
            "family_count": len(tree.get("families") or []),
            "overrides": _display_path(config.overrides_path, config.repo_root),
        },
    )


# ---------------------------------------------------------------------------
# CSV / Google Sheets export
# ---------------------------------------------------------------------------


def _read_csv_text(path_or_url: str) -> str:
    if re.match(r"^https?://", path_or_url):
        with urllib.request.urlopen(path_or_url, timeout=60) as response:
            raw = response.read()
    else:
        raw = Path(path_or_url).expanduser().read_bytes()
    return raw.decode("utf-8-sig")


def _row_value(row: dict[str, str], *names: str) -> str | None:
    for name in names:
        key = name.strip().lower().replace(" ", "_")
        if key in row and row[key] not in (None, ""):
            return row[key]
    return None


def load_from_csv(config: AppConfig, path_or_url: str) -> FamilyData:
    text = _read_csv_text(path_or_url)
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise ValueError("CSV has no header row")
    field_map = {name: name.strip().lower().replace(" ", "_") for name in reader.fieldnames}
    overrides = load_overrides(config.overrides_path)
    defaults = overrides["defaults"]
    sidecar_people = overrides["people"]
    default_location = _location(defaults.get("location"), config.location)
    default_masa_system = defaults.get("masa_system") or config.calendar.masa_system

    members: list[FamilyMember] = []
    warnings: list[str] = []
    for raw_row in reader:
        row = {field_map.get(k, k): v for k, v in raw_row.items() if k is not None}
        pid = _row_value(row, "pid", "id", "gramps_id", "person_id")
        name = _row_value(row, "name", "full_name", "display")
        if not pid or not name:
            continue
        override = sidecar_people.get(pid) or {}
        birth_date, birth_time, birth_has_time = parse_date_time(
            _row_value(row, "birth_date", "dob", "date_of_birth")
        )
        death_date, death_time, death_has_time = parse_date_time(
            _row_value(row, "death_date", "dod", "date_of_death")
        )
        status = _row_value(row, "status") or ("Deceased" if death_date else "Living")
        location = _location(override.get("location"), default_location)
        latitude = _row_value(row, "latitude", "location_latitude")
        longitude = _row_value(row, "longitude", "location_longitude")
        if latitude and longitude:
            location = LocationConfig(
                name=_row_value(row, "location_name") or location.name,
                latitude=float(latitude),
                longitude=float(longitude),
                elevation_m=float(_row_value(row, "elevation_m") or location.elevation_m),
                timezone=_row_value(row, "timezone", "location_timezone") or location.timezone,
            )
        member = FamilyMember(
            pid=pid,
            name=name,
            status=status,
            gender=_row_value(row, "gender", "sex"),
            gotra=override.get("gotra", _row_value(row, "gotra", "gotram") or defaults.get("gotra")),
            birth_date=birth_date,
            death_date=death_date,
            birth_time=birth_time if birth_has_time else None,
            death_time=death_time if death_has_time else None,
            birth_place=_row_value(row, "birth_place", "place_of_birth", "pob"),
            death_place=_row_value(row, "death_place", "place_of_death", "pod"),
            birth_masa=override.get("birth_masa", _row_value(row, "birth_masa")),
            birth_nakshatra=override.get(
                "birth_nakshatra", _row_value(row, "birth_nakshatra", "birth_star", "nakshatra")
            ),
            death_masa=override.get("death_masa", _row_value(row, "death_masa")),
            death_paksha=override.get("death_paksha", _row_value(row, "death_paksha")),
            death_tithi=override.get("death_tithi", _row_value(row, "death_tithi", "tithi")),
            death_masa_system=override.get(
                "death_masa_system",
                _row_value(row, "death_masa_system") or default_masa_system,
            ),
            birth_masa_system=override.get(
                "birth_masa_system",
                _row_value(row, "birth_masa_system") or default_masa_system,
            ),
            location=location,
            tradition=override.get(
                "tradition", _row_value(row, "tradition") or defaults.get("tradition")
            ),
            notes=[_row_value(row, "notes") or ""] if _row_value(row, "notes") else [],
            private=_bool(_row_value(row, "private"), False),
            include=_bool(override.get("include", _row_value(row, "include")), True),
            source="csv",
            raw={"row": row, "metadata": {}},
        )
        _apply_override(member, override)
        if member.private and not config.calendar.include.private_members:
            continue
        if not member.include:
            continue
        members.append(member)
    warnings.append(f"Loaded {len(members)} family members from CSV: {path_or_url}")
    return FamilyData(members=members, source="csv", warnings=warnings, metadata={"csv": path_or_url})


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------


def load_family(
    config: AppConfig,
    source: str | None = None,
    csv_path: str | None = None,
) -> FamilyData:
    kind = (source or config.sources.kind or "tree").lower()
    if kind not in {"tree", "csv"}:
        raise ValueError("source must be tree or csv")
    if kind == "tree":
        return load_from_tree(config)
    path = csv_path or config.sources.csv
    if not path:
        raise ValueError("CSV source selected but no --csv path/URL was provided")
    return load_from_csv(config, path)
