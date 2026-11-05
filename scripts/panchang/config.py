"""Configuration for the Kula Panchangam engine.

The engine is part of the Kula family-tree repository, so it reads its settings
from the same ``docs/config.yml`` that drives the public site.  A ``panchang:``
block is optional; every key falls back to the defaults below.

A standalone JSON config is also accepted (``python -m scripts.panchang
build --config my-panchang.json``), which is useful for testing another family
or a different ritual location.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import time
from pathlib import Path
from typing import Any

try:  # PyYAML is already a core dependency of the site importer.
    import yaml
except ImportError:  # pragma: no cover - only in a broken install
    yaml = None


class ConfigError(ValueError):
    """Raised when a config file is missing or malformed."""


# Repository root: <repo>/scripts/panchang/config.py -> <repo>
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = REPO_ROOT / "docs" / "config.yml"


def _time(value: str | time) -> time:
    if isinstance(value, time):
        return value
    try:
        return time.fromisoformat(str(value))
    except ValueError as exc:
        raise ConfigError(f"Invalid time {value!r}; expected HH:MM") from exc


def _bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


@dataclass
class LocationConfig:
    name: str = "Chennai"
    latitude: float = 13.0827
    longitude: float = 80.2707
    elevation_m: float = 10.0
    timezone: str = "Asia/Kolkata"

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "LocationConfig":
        data = data or {}
        return cls(
            name=str(data.get("name", "Chennai")),
            latitude=float(data.get("latitude", 13.0827)),
            longitude=float(data.get("longitude", 80.2707)),
            elevation_m=float(data.get("elevation_m", 10.0)),
            timezone=str(data.get("timezone", "Asia/Kolkata")),
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "latitude": self.latitude,
            "longitude": self.longitude,
            "elevation_m": self.elevation_m,
            "timezone": self.timezone,
        }


@dataclass
class IncludeConfig:
    amavasya: bool = True
    purnima: bool = True
    ekadasi: bool = False
    pradosham: bool = False
    shraddha: bool = True
    janma_nakshatra: bool = True
    gregorian_birthday: bool = False
    death_anniversary: bool = False
    festivals: bool = True
    living_members: bool = True
    deceased_members: bool = True
    private_members: bool = False

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "IncludeConfig":
        data = data or {}
        return cls(
            **{
                name: _bool(data.get(name), getattr(cls, name))
                for name in cls.__dataclass_fields__
            }
        )

    def as_dict(self) -> dict[str, bool]:
        return {name: getattr(self, name) for name in self.__dataclass_fields__}


@dataclass
class CalendarSettings:
    name: str = "Kula Family Panchangam"
    description: str = "Family shraddha, janma nakshatra and panchangam events"
    years: list[int] = field(default_factory=list)
    masa_system: str = "solar"  # solar | lunar_amanta | lunar_purnimanta
    death_tithi_reference: str = "aparahna"  # sunrise | aparahna | death_time
    birth_nakshatra_reference: str = "sunrise"  # sunrise | birth_time | noon
    nakshatra_reference: str = "sunrise"
    event_mode: str = "all-day"  # all-day | timed
    reminders_days: list[int] = field(default_factory=lambda: [1])
    aparahna_start: time = field(default_factory=lambda: time(13, 30))
    aparahna_end: time = field(default_factory=lambda: time(16, 0))
    pradosha_before_sunset_minutes: int = 90
    pradosha_after_sunset_minutes: int = 90
    include: IncludeConfig = field(default_factory=IncludeConfig)

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "CalendarSettings":
        data = data or {}

        def pick(name: str, default: Any) -> Any:
            return data.get(name, default)

        return cls(
            name=str(pick("name", cls.name)),
            description=str(pick("description", cls.description)),
            years=[int(y) for y in pick("years", []) or []],
            masa_system=str(pick("masa_system", cls.masa_system)),
            death_tithi_reference=str(
                pick("death_tithi_reference", cls.death_tithi_reference)
            ),
            birth_nakshatra_reference=str(
                pick("birth_nakshatra_reference", cls.birth_nakshatra_reference)
            ),
            nakshatra_reference=str(
                pick("nakshatra_reference", cls.nakshatra_reference)
            ),
            event_mode=str(pick("event_mode", cls.event_mode)),
            reminders_days=[int(d) for d in pick("reminders_days", [1]) or [1]],
            aparahna_start=_time(pick("aparahna_start", "13:30")),
            aparahna_end=_time(pick("aparahna_end", "16:00")),
            pradosha_before_sunset_minutes=_int(
                pick("pradosha_before_sunset_minutes", 90), 90
            ),
            pradosha_after_sunset_minutes=_int(
                pick("pradosha_after_sunset_minutes", 90), 90
            ),
            include=IncludeConfig.from_dict(data.get("include")),
        )

    def validate(self) -> None:
        if self.masa_system not in {"solar", "lunar_amanta", "lunar_purnimanta"}:
            raise ConfigError(
                "panchang.masa_system must be solar, lunar_amanta or lunar_purnimanta"
            )
        if self.death_tithi_reference not in {"sunrise", "aparahna", "death_time"}:
            raise ConfigError(
                "panchang.death_tithi_reference must be sunrise, aparahna or death_time"
            )
        if self.birth_nakshatra_reference not in {"sunrise", "noon", "birth_time"}:
            raise ConfigError(
                "panchang.birth_nakshatra_reference must be sunrise, noon or birth_time"
            )
        if self.nakshatra_reference not in {"sunrise", "noon", "birth_time"}:
            raise ConfigError(
                "panchang.nakshatra_reference must be sunrise, noon or birth_time"
            )
        if self.event_mode not in {"all-day", "timed"}:
            raise ConfigError("panchang.event_mode must be all-day or timed")
        if self.aparahna_end <= self.aparahna_start:
            raise ConfigError("panchang.aparahna_end must be after aparahna_start")

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "years": list(self.years),
            "masa_system": self.masa_system,
            "death_tithi_reference": self.death_tithi_reference,
            "birth_nakshatra_reference": self.birth_nakshatra_reference,
            "nakshatra_reference": self.nakshatra_reference,
            "event_mode": self.event_mode,
            "reminders_days": list(self.reminders_days),
            "aparahna_start": self.aparahna_start.strftime("%H:%M"),
            "aparahna_end": self.aparahna_end.strftime("%H:%M"),
            "include": self.include.as_dict(),
        }


@dataclass
class AstroSettings:
    ayanamsha: str = "lahiri"
    ephe_path: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "AstroSettings":
        data = data or {}
        return cls(
            ayanamsha=str(data.get("ayanamsha", "lahiri")),
            ephe_path=data.get("ephe_path"),
        )


@dataclass
class SourceSettings:
    # tree = docs/data/tree.json, csv = CSV/Sheets export, gramps = live Gramps Web
    kind: str = "tree"
    tree_path: str = "docs/data/tree.json"
    csv: str | None = None
    overrides: str = "docs/data/panchang-overrides.json"
    output_dir: str = "docs/data/panchang"
    feed_name: str = "panchang.ics"
    gramps_url: str = "http://localhost:8081"
    gramps_token_file: str = "~/.config/gramps-mcp/token.json"

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "SourceSettings":
        data = data or {}
        gramps = data.get("gramps") or {}
        return cls(
            kind=str(data.get("kind", "tree")),
            tree_path=str(data.get("tree_path", "docs/data/tree.json")),
            csv=data.get("csv"),
            overrides=str(
                data.get("overrides", "docs/data/panchang-overrides.json")
            ),
            output_dir=str(data.get("output_dir", "docs/data/panchang")),
            feed_name=str(data.get("feed_name", "panchang.ics")),
            gramps_url=str(gramps.get("url", "http://localhost:8081")),
            gramps_token_file=str(
                gramps.get("token_file", "~/.config/gramps-mcp/token.json")
            ),
        )


@dataclass
class ServerSettings:
    host: str = "127.0.0.1"
    port: int = 8082
    public_url: str | None = None
    feed_token: str | None = None
    cache_seconds: int = 300

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "ServerSettings":
        data = data or {}
        return cls(
            host=str(data.get("host", "127.0.0.1")),
            port=_int(data.get("port", 8082), 8082),
            public_url=data.get("public_url"),
            feed_token=data.get("feed_token"),
            cache_seconds=_int(data.get("cache_seconds", 300), 300),
        )


@dataclass
class GoogleSettings:
    calendar_id: str = "primary"
    credentials_file: str = "private/google-credentials.json"
    token_file: str = "private/google-token.json"
    service_account_file: str | None = None
    timezone: str = "Asia/Kolkata"

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "GoogleSettings":
        data = data or {}
        return cls(
            calendar_id=str(data.get("calendar_id", "primary")),
            credentials_file=str(
                data.get("credentials_file", "private/google-credentials.json")
            ),
            token_file=str(data.get("token_file", "private/google-token.json")),
            service_account_file=data.get("service_account_file"),
            timezone=str(data.get("timezone", "Asia/Kolkata")),
        )


@dataclass
class AppConfig:
    location: LocationConfig = field(default_factory=LocationConfig)
    calendar: CalendarSettings = field(default_factory=CalendarSettings)
    astro: AstroSettings = field(default_factory=AstroSettings)
    sources: SourceSettings = field(default_factory=SourceSettings)
    server: ServerSettings = field(default_factory=ServerSettings)
    google: GoogleSettings = field(default_factory=GoogleSettings)
    repo_root: Path = field(default_factory=lambda: REPO_ROOT)
    config_path: Path | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any], repo_root: Path = REPO_ROOT) -> "AppConfig":
        cfg = cls(
            location=LocationConfig.from_dict(data.get("location")),
            calendar=CalendarSettings.from_dict(data.get("calendar")),
            astro=AstroSettings.from_dict(data.get("astro")),
            sources=SourceSettings.from_dict(data.get("sources")),
            server=ServerSettings.from_dict(data.get("server")),
            google=GoogleSettings.from_dict(data.get("google")),
            repo_root=repo_root,
        )
        cfg.calendar.validate()
        return cfg

    # -- path helpers ------------------------------------------------------

    def resolve_path(self, value: str | None) -> Path | None:
        if not value:
            return None
        path = Path(value).expanduser()
        if not path.is_absolute():
            path = self.repo_root / path
        return path

    @property
    def tree_path(self) -> Path:
        return self.resolve_path(self.sources.tree_path) or self.repo_root / "docs/data/tree.json"

    @property
    def overrides_path(self) -> Path:
        return self.resolve_path(self.sources.overrides) or self.repo_root / "docs/data/panchang-overrides.json"

    @property
    def output_dir(self) -> Path:
        return self.resolve_path(self.sources.output_dir) or self.repo_root / "docs/data/panchang"

    @property
    def feed_name(self) -> str:
        name = self.sources.feed_name.strip() or "panchang.ics"
        return name if name.endswith(".ics") else f"{name}.ics"


def _extract_panchang_block(data: dict[str, Any]) -> dict[str, Any]:
    """Accept either a bare panchang config or a full site config."""

    block = data.get("panchang")
    if isinstance(block, dict):
        return block
    # A full site config without a panchang block still supplies the tree and
    # privacy settings; the panchang defaults are used.
    return {}


def _normalise(payload: dict[str, Any]) -> dict[str, Any]:
    """Accept a compact flat ``panchang:`` block as well as nested sections."""

    data = dict(payload)
    calendar_fields = {
        "name",
        "description",
        "years",
        "masa_system",
        "death_tithi_reference",
        "birth_nakshatra_reference",
        "nakshatra_reference",
        "event_mode",
        "reminders_days",
        "aparahna_start",
        "aparahna_end",
        "pradosha_before_sunset_minutes",
        "pradosha_after_sunset_minutes",
        "include",
    }
    if "calendar" not in data:
        data["calendar"] = {k: data[k] for k in calendar_fields if k in data}
    if "astro" not in data:
        data["astro"] = {
            k: data[k] for k in ("ayanamsha", "ephe_path") if k in data
        }
    return data


def load_config(path: str | Path | None = None) -> AppConfig:
    """Load configuration from YAML (site config) or JSON (standalone)."""

    config_path = Path(path).expanduser() if path else DEFAULT_CONFIG
    if not config_path.is_absolute():
        config_path = (Path.cwd() / config_path).resolve()
    if not config_path.exists():
        raise ConfigError(
            f"Config not found: {config_path}. Expected docs/config.yml."
        )
    text = config_path.read_text(encoding="utf-8")
    if config_path.suffix.lower() in {".yml", ".yaml"}:
        if yaml is None:  # pragma: no cover
            raise ConfigError("PyYAML is required to read docs/config.yml")
        try:
            data = yaml.safe_load(text) or {}
        except yaml.YAMLError as exc:
            raise ConfigError(f"Invalid YAML in {config_path}: {exc}") from exc
        if not isinstance(data, dict):
            raise ConfigError(f"Config root must be a mapping: {config_path}")
        repo_root = config_path.parent.parent
        payload = _extract_panchang_block(data)
    else:
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ConfigError(f"Invalid JSON in {config_path}: {exc}") from exc
        if not isinstance(data, dict):
            raise ConfigError(f"Config root must be an object: {config_path}")
        repo_root = config_path.parent
        payload = data.get("panchang") if isinstance(data.get("panchang"), dict) else data
    cfg = AppConfig.from_dict(_normalise(payload or {}), repo_root=repo_root)
    cfg.config_path = config_path
    return cfg


def find_config(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    candidates = [
        DEFAULT_CONFIG,
        Path.cwd() / "docs" / "config.yml",
        Path.cwd() / "config.yml",
        Path.cwd() / "panchang.json",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise ConfigError(
        "No config found. Expected docs/config.yml (or pass --config)."
    )
