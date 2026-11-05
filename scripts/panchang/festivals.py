"""Small, extensible festival rule set.

Rules are intentionally declarative: a festival is identified by masa, paksha
and tithi, or by a solar sankranti.  Add a rule here when the family observes a
new festival; the daily engine and the ICS feed pick it up automatically.
"""

from __future__ import annotations

from dataclasses import dataclass
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
    # The single reference instant whose tithi decides the festival day.
    # sunrise is the South Indian panchang convention; Amavasya observances
    # use the aparahna (ritual) tithi instead.  Using one instant keeps a
    # festival on exactly one day even when its tithi spans two sunrises.
    reference: str = "sunrise"  # sunrise | noon | aparahna | sunset
    description: str = ""

    def matches(self, day: "DailyPanchang") -> bool:
        if self.sankranti:
            if not day.is_sankranti or not day.solar_masa.end:
                return False
            target = _solar_index(self.masa)
            if target is None:
                return False
            # Evaluate an hour after the ingress instant.  At the exact
            # boundary the Sun's longitude is numerically ambiguous
            # (29.999… vs 30.000…), which can flip the sign between Swiss
            # Ephemeris builds; an hour later the Sun is ~0.04° past it.
            ingress_sign = astro.solar_sign(astro.to_jd(day.solar_masa.end) + 1.0 / 24.0)
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

        if self.paksha:
            expected = "Sukla" if self.tithi <= 15 else "Krishna"
            if self.paksha != expected:
                return False
        return _tithi_at_reference(day, self.reference) == self.tithi


_REFERENCE_ATTRS = {
    "sunrise": "sunrise",
    "noon": "solar_noon",
    "aparahna": "aparahna_mid",
    "aparahna_start": "aparahna_start",
    "aparahna_end": "aparahna_end",
    "sunset": "sunset",
}


def _tithi_at_reference(day: "DailyPanchang", reference: str) -> int:
    attr = _REFERENCE_ATTRS.get(reference, "sunrise")
    if attr == "aparahna_mid":
        # The midpoint is what the daily engine uses for its aparahna tithi.
        return day.tithi_aparahna.index
    moment = getattr(day, attr, day.sunrise)
    return astro.tithi_state(astro.to_jd(moment)).index


def _solar_index(name: str | None) -> int | None:
    if not name:
        return None
    return astro.parse_solar_masa(name)


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
        reference="aparahna",
        description="Pitru Paksha closing Amavasya.",
    ),
    FestivalRule(
        "Deepavali",
        "lunar_amanta",
        "Kartika",
        "Krishna",
        30,
        reference="aparahna",
    ),
    FestivalRule(
        "Aadi Amavasai",
        "solar",
        "Karka",
        "Krishna",
        30,
        reference="aparahna",
        description="Tamil Aadi month Amavasya; tarpanam.",
    ),
    FestivalRule(
        "Thai Amavasai",
        "solar",
        "Makara",
        "Krishna",
        30,
        reference="aparahna",
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

