"""Kula Panchangam: sidereal panchangam and family tithi engine.

The package is intentionally framework-free.  The public site imports the
``docs/data/panchang/*.json`` files it writes; the CLI is also usable on its own.

Quick start::

    from scripts.panchang import load_config, load_family, build_events

    config = load_config()
    family = load_family(config)
    events, warnings = build_events(config, family, [2026])
"""

from __future__ import annotations

__version__ = "0.1.0"

from .config import AppConfig, ConfigError, load_config  # noqa: E402
from .engine import get_daily_panchang, find_amavasya_days, scan_range, scan_year  # noqa: E402
from .matcher import build_events, explain_member, resolve_member  # noqa: E402
from .models import FamilyData, FamilyMember, PanchangEvent  # noqa: E402
from .sources import load_family  # noqa: E402

__all__ = [
    "__version__",
    "AppConfig",
    "ConfigError",
    "load_config",
    "get_daily_panchang",
    "find_amavasya_days",
    "scan_range",
    "scan_year",
    "build_events",
    "explain_member",
    "resolve_member",
    "FamilyData",
    "FamilyMember",
    "PanchangEvent",
    "load_family",
]
