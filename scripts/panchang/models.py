"""Shared data models for family members and generated calendar events."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time

from .config import LocationConfig


@dataclass
class FamilyMember:
    pid: str
    name: str
    status: str = "Living"  # Living | Deceased
    gender: str | None = None
    gotra: str | None = None
    birth_date: date | None = None
    death_date: date | None = None
    birth_time: time | None = None
    death_time: time | None = None
    birth_place: str | None = None
    death_place: str | None = None
    birth_masa: str | None = None
    birth_nakshatra: str | None = None
    death_masa: str | None = None
    death_paksha: str | None = None
    death_tithi: str | int | None = None
    death_masa_system: str | None = None
    birth_masa_system: str | None = None
    location: LocationConfig | None = None
    tradition: str | None = None
    notes: list[str] = field(default_factory=list)
    private: bool = False
    include: bool = True
    source: str = "gramps"
    raw: dict = field(default_factory=dict)

    @property
    def is_deceased(self) -> bool:
        return self.status.strip().lower() in {"deceased", "dead", "expired", "late"}

    @property
    def is_living(self) -> bool:
        return not self.is_deceased

    @property
    def gotra_label(self) -> str:
        if not self.gotra:
            return ""
        gotra = self.gotra.strip()
        if gotra.lower().endswith("gotram") or gotra.lower().endswith("gotra"):
            return gotra
        return f"{gotra} Gotram"

    def age_at_death(self) -> int | None:
        if not self.birth_date or not self.death_date:
            return None
        return (
            self.death_date.year
            - self.birth_date.year
            - ((self.death_date.month, self.death_date.day) < (self.birth_date.month, self.birth_date.day))
        )


@dataclass
class PanchangEvent:
    date: date
    kind: str
    summary: str
    description: str
    location: LocationConfig
    all_day: bool = True
    start: datetime | None = None
    end: datetime | None = None
    person_id: str | None = None
    person_name: str | None = None
    gotra: str | None = None
    tithi: dict | None = None
    masa: dict | None = None
    nakshatra: dict | None = None
    festivals: list[str] = field(default_factory=list)
    details: dict = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    confidence: str = "high"
    uid: str = ""

    def to_dict(self) -> dict:
        return {
            "uid": self.uid,
            "date": self.date.isoformat(),
            "kind": self.kind,
            "summary": self.summary,
            "description": self.description,
            "location": {
                "name": self.location.name,
                "latitude": self.location.latitude,
                "longitude": self.location.longitude,
                "elevation_m": self.location.elevation_m,
                "timezone": self.location.timezone,
            },
            "all_day": self.all_day,
            "start": self.start.isoformat() if self.start else None,
            "end": self.end.isoformat() if self.end else None,
            "person_id": self.person_id,
            "person_name": self.person_name,
            "gotra": self.gotra,
            "tithi": self.tithi,
            "masa": self.masa,
            "nakshatra": self.nakshatra,
            "festivals": list(self.festivals),
            "details": self.details,
            "warnings": list(self.warnings),
            "confidence": self.confidence,
        }


@dataclass
class FamilyData:
    members: list[FamilyMember]
    source: str
    warnings: list[str] = field(default_factory=list)
    metadata: dict = field(default_factory=dict)
