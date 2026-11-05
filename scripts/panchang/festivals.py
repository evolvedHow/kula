"""Small, extensible festival rule set.

Rules are intentionally declarative: a festival is identified by masa, paksha
and tithi, or by a solar sankranti.  Add a rule here when the family observes a
new festival; the daily engine and the ICS feed pick it up automatically.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import time
from typing import TYPE_CHECKING

from . import astronomy as astro

if TYPE_CHECKING:  # pragma: no cover
    from .engine import DailyPanchang


@dataclass(frozen=True)
class FestivalRule:
    name: str
    masa_system: str  # lunar_amanta | solar
    masa: str | None = None
    paksha: str | None = None
    tithi: int | None = None
    sankranti: bool = False
    description: str = ""

    def matches(self, day: "DailyPanchang") -> bool:
        if self.sankranti:
            if not day.is_sankranti or not day.solar_masa.end:
                return False
            target = _solar_index(self.masa)
            if target is None:
                return False
            ingress_sign = astro.solar_sign(astro.to_jd(day.solar_masa.end))
            return ingress_sign == target

        if self.tithi is None:
            return False

        if self.masa_system == "lunar_amanta":
            if day.lunar_masa_amanta.name.lower() != (self.masa or "").lower():
                return False
        elif self.masa_system == "solar":
            if day.solar_masa.name.lower() != (self.masa or "").lower():
                return False
        else:
            return False

        # Festivals are observed on the day the tithi prevails at sunrise or
        # during the morning/aparhna puja window, not only at one instant.
        observed = _observed_tithi_indices(day)
        if self.tithi not in observed:
            return False
        if self.paksha:
            expected = "Sukla" if self.tithi <= 15 else "Krishna"
            if self.paksha != expected:
                return False
        return True


def _solar_index(name: str | None) -> int | None:
    if not name:
        return None
    return astro.parse_solar_masa(name)


def _observed_tithi_indices(day: "DailyPanchang") -> set[int]:
    indices = {
        day.tithi_sunrise.index,
        day.tithi_aparahna.index,
        astro.tithi_state(astro.to_jd(day.aparahna_start)).index,
        astro.tithi_state(astro.to_jd(day.aparahna_end)).index,
    }
    tz = astro.timezone_for(day.location)
    morning = day.day
    puja = astro.at_local_time(morning, time(9, 0), day.location)
    indices.add(astro.tithi_state(astro.to_jd(puja)).index)
    return indices


RULES: tuple[FestivalRule, ...] = (
    FestivalRule(
        "Garuda Panchami (Naga Panchami)",
        "lunar_amanta",
        "Shravana",
        "Sukla",
        5,
        description="Shravana Sukla Panchami; family thithi remembrance.",
    ),
    FestivalRule(
        "Vinayaka Chaturthi",
        "lunar_amanta",
        "Bhadrapada",
        "Sukla",
        4,
    ),
    FestivalRule(
        "Krishna Janmashtami",
        "lunar_amanta",
        "Bhadrapada",
        "Krishna",
        8,
    ),
    FestivalRule(
        "Mahalaya Amavasya",
        "lunar_amanta",
        "Bhadrapada",
        "Krishna",
        30,
        description="Pitru Paksha closing Amavasya.",
    ),
    FestivalRule(
        "Deepavali",
        "lunar_amanta",
        "Kartika",
        "Krishna",
        30,
    ),
    FestivalRule(
        "Aadi Amavasai",
        "solar",
        "Karka",
        "Krishna",
        30,
        description="Tamil Aadi month Amavasya; tarpanam.",
    ),
    FestivalRule(
        "Thai Amavasai",
        "solar",
        "Makara",
        "Krishna",
        30,
        description="Tamil Thai month Amavasya; tarpanam.",
    ),
    FestivalRule(
        "Pongal",
        "solar",
        "Makara",
        sankranti=True,
        description="Makara Sankranti / Thai 1.",
    ),
    FestivalRule(
        "Puthandu (Tamil New Year)",
        "solar",
        "Mesha",
        sankranti=True,
        description="Mesha Sankranti / Chithirai 1.",
    ),
)


def match_festivals(day: "DailyPanchang") -> list[str]:
    return [rule.name for rule in RULES if rule.matches(day)]


def festival_details(day: "DailyPanchang") -> list[dict]:
    return [
        {
            "name": rule.name,
            "masa_system": rule.masa_system,
            "masa": rule.masa,
            "paksha": rule.paksha,
            "tithi": rule.tithi,
            "sankranti": rule.sankranti,
            "description": rule.description,
        }
        for rule in RULES
        if rule.matches(day)
    ]
