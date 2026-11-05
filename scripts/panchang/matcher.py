"""Match family members to the panchangam and build calendar events.

Rules implemented here
----------------------
* A deceased member's annual shraddha is the day in the target year when the
  death masa is current at sunrise and the death tithi prevails during
  aparahna (13:30-16:00 by default).
* A living member's janma nakshatra day is the day in the target year when the
  birth masa is current and the birth nakshatra prevails at the chosen
  reference time (sunrise by default).
* Every lunar month contributes one Amavasya tarpanam day.

When the source only has a date (no time), the tithi is taken at aparahna for
deaths and at sunrise for births.  Every such assumption is recorded in the
event warnings and confidence field rather than silently guessed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, time
from typing import Iterable

from . import astronomy as astro
from .config import AppConfig, CalendarSettings, LocationConfig
from .sources import load_family
from .models import FamilyData, FamilyMember, PanchangEvent
from .engine import (
    DailyPanchang,
    find_amavasya_days,
    get_daily_panchang,
    scan_year,
    tithi_present_during_aparahna,
    tithi_window_on_day,
)

_YEAR_CACHE: dict[tuple, list[DailyPanchang]] = {}


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------


def _clock(dt: datetime | None) -> str:
    return dt.strftime("%H:%M") if dt else "—"


def _date_text(value: date | None) -> str:
    return value.isoformat() if value else "unknown"


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def _location_key(location: LocationConfig) -> tuple:
    return (
        location.latitude,
        location.longitude,
        location.elevation_m,
        location.timezone,
        location.name,
    )


def _year_key(year: int, settings: CalendarSettings, location: LocationConfig) -> tuple:
    return (
        year,
        _location_key(location),
        settings.masa_system,
        settings.aparahna_start,
        settings.aparahna_end,
        settings.pradosha_before_sunset_minutes,
        settings.pradosha_after_sunset_minutes,
    )


def clear_cache() -> None:
    _YEAR_CACHE.clear()


def _days_for_year(
    year: int, location: LocationConfig, settings: CalendarSettings
) -> list[DailyPanchang]:
    key = _year_key(year, settings, location)
    if key not in _YEAR_CACHE:
        _YEAR_CACHE[key] = scan_year(
            year, location, settings, include_bounds=False
        )
    return _YEAR_CACHE[key]


def _tithi_from_index(index: int) -> astro.TithiState:
    paksha = "Sukla" if index <= 15 else "Krishna"
    return astro.TithiState(
        index=index,
        name=astro.TITHI_NAMES[index - 1],
        tamil_name=astro.TITHI_TAMIL[index - 1],
        paksha=paksha,
        fraction=0.0,
        difference=0.0,
    )


def _nakshatra_from_index(index: int) -> astro.NakshatraState:
    return astro.NakshatraState(
        index=index,
        name=astro.NAKSHATRA_NAMES[index - 1],
        tamil_name=astro.NAKSHATRA_TAMIL[index - 1],
        pada=0,
        longitude=0.0,
    )


def _masa_from_index(index: int, system: str, adhika: bool = False) -> astro.MasaState:
    index %= 12
    if system == "solar":
        return astro.MasaState(
            name=astro.SOLAR_MONTHS[index],
            tamil_name=astro.SOLAR_MONTHS_TAMIL[index],
            malayalam_name=astro.SOLAR_MONTHS_MALAYALAM[index],
            index=index,
            system="solar",
            adhika=False,
        )
    return astro.MasaState(
        name=astro.LUNAR_MONTHS[index],
        tamil_name=astro.LUNAR_MONTHS_TAMIL[index],
        malayalam_name=astro.SOLAR_MONTHS_MALAYALAM[index],
        index=index,
        system=system,
        adhika=adhika,
    )


def _resolve_masa(
    value: str | int | None,
    system: str,
    fallback: astro.MasaState | None,
) -> tuple[astro.MasaState | None, list[str]]:
    warnings: list[str] = []
    if value is None or value == "":
        return fallback, warnings
    if system == "solar":
        index = astro.parse_solar_masa(value)
    else:
        index = astro.parse_lunar_masa(value)
    if index is None:
        warnings.append(
            f"Could not interpret masa {value!r} as {system}; using the date-derived value."
        )
        return fallback, warnings
    if fallback:
        fallback_index = (
            astro.parse_solar_masa(fallback.name)
            if system == "solar"
            else astro.parse_lunar_masa(fallback.name)
        )
        if fallback_index == index and fallback.system == system:
            return fallback, warnings
    return _masa_from_index(index, system), warnings


def _reference(
    day: date,
    location: LocationConfig,
    settings: CalendarSettings,
    mode: str,
    clock: time | None,
    for_death: bool,
) -> tuple[datetime, str, list[str]]:
    warnings: list[str] = []
    tz = astro.timezone_for(location)
    if mode == "death_time" and for_death:
        if clock:
            return datetime(day.year, day.month, day.day, clock.hour, clock.minute, tzinfo=tz), "death_time", warnings
        warnings.append("Death time not known; tithi computed at aparahna instead.")
        mode = "aparahna"
    if mode == "birth_time" and not for_death:
        if clock:
            return datetime(day.year, day.month, day.day, clock.hour, clock.minute, tzinfo=tz), "birth_time", warnings
        warnings.append("Birth time not known; nakshatra computed at sunrise instead.")
        mode = "sunrise"

    if mode == "sunrise":
        return astro.sunrise(day, location), "sunrise", warnings
    if mode == "noon":
        return datetime(day.year, day.month, day.day, 12, 0, tzinfo=tz), "noon", warnings
    # default: aparahna midpoint
    start, end = astro.aparahna_window(
        day, location, settings.aparahna_start, settings.aparahna_end
    )
    return start + (end - start) / 2, "aparahna", warnings


# ---------------------------------------------------------------------------
# derived member astrology
# ---------------------------------------------------------------------------


@dataclass
class AstroPoint:
    date: date | None
    reference: datetime | None
    tithi: astro.TithiState | None
    masa: astro.MasaState | None
    nakshatra: astro.NakshatraState | None
    source: str
    confidence: str
    # The amanta lunar month is kept even when the configured masa system is
    # solar.  It disambiguates a tithi that occurs twice in one solar month
    # (e.g. Sukla Panchami in Karka/Aadi in 2026).
    lunar_masa: astro.MasaState | None = None
    warnings: list[str] = field(default_factory=list)


@dataclass
class MemberAstro:
    member: FamilyMember
    location: LocationConfig
    death: AstroPoint | None = None
    birth: AstroPoint | None = None
    warnings: list[str] = field(default_factory=list)


def resolve_member(member: FamilyMember, config: AppConfig) -> MemberAstro:
    settings = config.calendar
    location = member.location or config.location
    warnings: list[str] = []

    death = None
    if member.is_deceased:
        death = _resolve_death(member, config, location)
        warnings.extend(death.warnings)

    birth = None
    if member.birth_date or member.birth_nakshatra or member.birth_masa:
        birth = _resolve_birth(member, config, location)
        warnings.extend(birth.warnings)

    return MemberAstro(
        member=member,
        location=location,
        death=death,
        birth=birth,
        warnings=warnings,
    )


def _resolve_death(
    member: FamilyMember, config: AppConfig, location: LocationConfig
) -> AstroPoint:
    settings = config.calendar
    warnings: list[str] = []
    source = "derived"
    confidence = "medium"
    reference = None
    tithi = masa = nakshatra = lunar_masa = None
    death_date = member.death_date

    if death_date:
        mode = settings.death_tithi_reference
        if member.death_time:
            mode = "death_time"
        reference, used_mode, ref_warnings = _reference(
            death_date, location, settings, mode, member.death_time, for_death=True
        )
        warnings.extend(ref_warnings)
        jd_ref = astro.to_jd(reference)
        jd_sunrise = astro.to_jd(astro.sunrise(death_date, location))
        tithi = astro.tithi_state(jd_ref)
        nakshatra = astro.nakshatra_state(jd_ref)
        masa_system = member.death_masa_system or settings.masa_system
        masa = astro.masa_state(jd_sunrise, location, masa_system)
        lunar_masa = astro.lunar_masa(jd_sunrise, location, "lunar_amanta")
        source = f"derived from death date at {used_mode}"
        confidence = "high" if used_mode == "death_time" else "medium"
        if used_mode != "death_time" and not member.death_time:
            warnings.append(
                "Death time is unknown. The tithi is computed at aparahna, the "
                "ritual reference, not at sunrise. Set death_time in the sidecar "
                "to make this exact."
            )
    elif not (member.death_tithi or member.death_masa):
        warnings.append("No death date, tithi or masa is available.")
        return AstroPoint(
            date=None,
            reference=None,
            tithi=None,
            masa=None,
            nakshatra=None,
            source="unavailable",
            confidence="low",
            warnings=warnings,
        )

    # Explicit sidecar / Gramps overrides win over derived values.
    explicit_tithi = astro.parse_tithi(member.death_tithi, member.death_paksha)
    if explicit_tithi is not None:
        if tithi and explicit_tithi != tithi.index:
            warnings.append(
                f"Sidecar death tithi {explicit_tithi} overrides derived tithi {tithi.index}."
            )
        tithi = _tithi_from_index(explicit_tithi)
        source = "sidecar/Gramps override"
        confidence = "high"
    elif member.death_tithi:
        warnings.append(f"Could not interpret death tithi {member.death_tithi!r}.")

    masa_system = member.death_masa_system or settings.masa_system
    explicit_masa, masa_warnings = _resolve_masa(member.death_masa, masa_system, masa)
    warnings.extend(masa_warnings)
    if explicit_masa is not None and explicit_masa is not masa:
        if masa and explicit_masa.name != masa.name:
            warnings.append(
                f"Sidecar death masa {explicit_masa.name} overrides derived masa {masa.name}."
            )
        masa = explicit_masa
        source = "sidecar/Gramps override"
        confidence = "high"

    explicit_nakshatra = astro.parse_nakshatra(
        member.raw.get("metadata", {}).get("death_nakshatra")
    )
    if explicit_nakshatra:
        nakshatra = _nakshatra_from_index(explicit_nakshatra)

    if tithi and not masa:
        warnings.append("Death tithi is known but masa is unknown; matching will be tithi-only.")
    if masa and not tithi:
        warnings.append("Death masa is known but tithi is unknown; shraddha cannot be dated.")

    return AstroPoint(
        date=death_date,
        reference=reference,
        tithi=tithi,
        masa=masa,
        nakshatra=nakshatra,
        source=source,
        confidence=confidence,
        lunar_masa=lunar_masa,
        warnings=warnings,
    )


def _resolve_birth(
    member: FamilyMember, config: AppConfig, location: LocationConfig
) -> AstroPoint:
    settings = config.calendar
    warnings: list[str] = []
    source = "derived"
    confidence = "medium"
    reference = None
    tithi = masa = nakshatra = lunar_masa = None
    birth_date = member.birth_date

    if birth_date:
        mode = settings.birth_nakshatra_reference
        if member.birth_time:
            mode = "birth_time"
        reference, used_mode, ref_warnings = _reference(
            birth_date, location, settings, mode, member.birth_time, for_death=False
        )
        warnings.extend(ref_warnings)
        jd_ref = astro.to_jd(reference)
        jd_sunrise = astro.to_jd(astro.sunrise(birth_date, location))
        nakshatra = astro.nakshatra_state(jd_ref)
        tithi = astro.tithi_state(jd_ref)
        masa_system = member.birth_masa_system or settings.masa_system
        masa = astro.masa_state(jd_sunrise, location, masa_system)
        lunar_masa = astro.lunar_masa(jd_sunrise, location, "lunar_amanta")
        source = f"derived from birth date at {used_mode}"
        confidence = "high" if used_mode == "birth_time" else "medium"
        if used_mode != "birth_time" and not member.birth_time:
            warnings.append(
                "Birth time is unknown. Janma nakshatra is computed at sunrise; "
                "set birth_time in the sidecar for an exact result."
            )
    elif not (member.birth_nakshatra or member.birth_masa):
        return AstroPoint(
            date=None,
            reference=None,
            tithi=None,
            masa=None,
            nakshatra=None,
            source="unavailable",
            confidence="low",
            warnings=["No birth date or nakshatra is available."],
        )

    explicit_nakshatra = astro.parse_nakshatra(member.birth_nakshatra)
    if explicit_nakshatra is not None:
        if nakshatra and explicit_nakshatra != nakshatra.index:
            warnings.append(
                f"Sidecar birth nakshatra {explicit_nakshatra} overrides derived nakshatra {nakshatra.index}."
            )
        nakshatra = _nakshatra_from_index(explicit_nakshatra)
        source = "sidecar/Gramps override"
        confidence = "high"
    elif member.birth_nakshatra:
        warnings.append(f"Could not interpret birth nakshatra {member.birth_nakshatra!r}.")

    masa_system = member.birth_masa_system or settings.masa_system
    explicit_masa, masa_warnings = _resolve_masa(member.birth_masa, masa_system, masa)
    warnings.extend(masa_warnings)
    if explicit_masa is not None and explicit_masa is not masa:
        if masa and explicit_masa.name != masa.name:
            warnings.append(
                f"Sidecar birth masa {explicit_masa.name} overrides derived masa {masa.name}."
            )
        masa = explicit_masa
        source = "sidecar/Gramps override"
        confidence = "high"

    if nakshatra and not masa:
        warnings.append("Birth nakshatra is known but masa is unknown; matching will be nakshatra-only.")
    if masa and not nakshatra:
        warnings.append("Birth masa is known but nakshatra is unknown.")

    return AstroPoint(
        date=birth_date,
        reference=reference,
        tithi=tithi,
        masa=masa,
        nakshatra=nakshatra,
        source=source,
        confidence=confidence,
        lunar_masa=lunar_masa,
        warnings=warnings,
    )


# ---------------------------------------------------------------------------
# matching
# ---------------------------------------------------------------------------


def _day_masa(day: DailyPanchang, system: str) -> astro.MasaState:
    if system == "solar":
        return day.solar_masa
    if system == "lunar_amanta":
        return day.lunar_masa_amanta
    if system == "lunar_purnimanta":
        return astro.lunar_masa(astro.to_jd(day.sunrise), day.location, system)
    return day.lunar_masa_amanta


def _masa_matches(day: DailyPanchang, target: astro.MasaState, *, check_adhika: bool = True) -> bool:
    current = _day_masa(day, target.system)
    if current.name.lower() != target.name.lower():
        return False
    if check_adhika and current.adhika != target.adhika:
        return False
    return True


def find_shraddha_day(
    member: FamilyMember,
    info: MemberAstro,
    year: int,
    days: list[DailyPanchang],
) -> tuple[DailyPanchang | None, list[str], str]:
    warnings: list[str] = []
    if not info.death or not info.death.tithi or not info.death.masa:
        return None, ["Death tithi and masa are required to locate a shraddha."], "low"
    target_tithi = info.death.tithi.index
    target_masa = info.death.masa
    target_lunar = info.death.lunar_masa
    if info.death.date:
        try:
            anniversary = date(year, info.death.date.month, info.death.date.day)
        except ValueError:
            anniversary = date(year, 3, 1)
    else:
        anniversary = date(year, 1, 1)

    def score_day(day: DailyPanchang) -> int:
        score = 2 if day.tithi_aparahna.index == target_tithi else 1
        if target_lunar and day.lunar_masa_amanta.name == target_lunar.name:
            # A tithi can occur twice in one solar month.  The lunar month of
            # the original death is the reliable tie-breaker (e.g. Shravana
            # Sukla Panchami, not Ashadha Sukla Panchami).
            score += 2
        return score

    candidates: list[tuple[int, DailyPanchang]] = []
    for day in days:
        if not _masa_matches(day, target_masa):
            continue
        if tithi_present_during_aparahna(day, target_tithi):
            candidates.append((score_day(day), day))

    if candidates:
        candidates.sort(
            key=lambda item: (
                -item[0],
                abs((item[1].day - anniversary).days),
                item[1].day,
            )
        )
        score, chosen = candidates[0]
        if len(candidates) > 1:
            warnings.append(
                f"{len(candidates)} {target_masa.label} days carried {info.death.tithi.label}; "
                "the closest to the death anniversary"
                + (f" in {target_lunar.label}" if target_lunar else "")
                + " is used."
            )
        if chosen.tithi_aparahna.index != target_tithi:
            warnings.append(
                "The tithi touches aparahna but does not span its midpoint; "
                "the date is still the best match for the aparahna rule."
            )
        confidence = "high" if score >= 2 else "medium"
        return chosen, warnings, confidence

    # Try the normal (non-Adhika) month if the death was in an Adhika month,
    # and vice versa.  Some families follow the Nija-month rule.
    relaxed: list[tuple[int, DailyPanchang]] = []
    for day in days:
        if not _masa_matches(day, target_masa, check_adhika=False):
            continue
        if tithi_present_during_aparahna(day, target_tithi):
            relaxed.append((score_day(day), day))
    if relaxed:
        relaxed.sort(
            key=lambda item: (
                -item[0],
                abs((item[1].day - anniversary).days),
                item[1].day,
            )
        )
        warnings.append(
            "No day matched the Adhika/Nija masa flag exactly; a same-name month "
            "was used. Verify the family's Adhika-masa rule."
        )
        return relaxed[0][1], warnings, "low"

    warnings.append(
        f"No {target_masa.label} day in {year} had {info.death.tithi.label} "
        "during aparahna. Check the death tithi/masa or the sidecar override."
    )
    return None, warnings, "low"


def find_janma_day(
    member: FamilyMember,
    info: MemberAstro,
    year: int,
    days: list[DailyPanchang],
    settings: CalendarSettings,
) -> tuple[DailyPanchang | None, list[str], str]:
    warnings: list[str] = []
    if not info.birth or not info.birth.nakshatra or not info.birth.masa:
        return None, ["Birth nakshatra and masa are required to locate a janma nakshatra day."], "low"
    target_nakshatra = info.birth.nakshatra.index
    target_masa = info.birth.masa
    target_lunar = info.birth.lunar_masa
    if info.birth.date:
        try:
            anniversary = date(year, info.birth.date.month, info.birth.date.day)
        except ValueError:
            anniversary = date(year, 3, 1)
    else:
        anniversary = date(year, 1, 1)
    reference_mode = settings.nakshatra_reference
    if member.birth_time and reference_mode == "birth_time":
        reference_mode = "birth_time"

    def nakshatra_index(day: DailyPanchang) -> int:
        if reference_mode == "sunrise":
            return day.nakshatra.index
        if reference_mode == "noon":
            noon = datetime(day.day.year, day.day.month, day.day.day, 12, 0, tzinfo=astro.timezone_for(day.location))
            return astro.nakshatra_state(astro.to_jd(noon)).index
        if reference_mode == "birth_time" and member.birth_time:
            at = datetime(
                day.day.year,
                day.day.month,
                day.day.day,
                member.birth_time.hour,
                member.birth_time.minute,
                tzinfo=astro.timezone_for(day.location),
            )
            return astro.nakshatra_state(astro.to_jd(at)).index
        return day.nakshatra.index

    def score_day(day: DailyPanchang) -> int:
        score = 2 if nakshatra_index(day) == target_nakshatra else 1
        if target_lunar and day.lunar_masa_amanta.name == target_lunar.name:
            score += 2
        return score

    candidates: list[tuple[int, DailyPanchang]] = []
    for day in days:
        if not _masa_matches(day, target_masa):
            continue
        if nakshatra_index(day) == target_nakshatra or day.nakshatra.index == target_nakshatra:
            candidates.append((score_day(day), day))

    if candidates:
        candidates.sort(
            key=lambda item: (
                -item[0],
                abs((item[1].day - anniversary).days),
                item[1].day,
            )
        )
        score, chosen = candidates[0]
        if len(candidates) > 1:
            warnings.append(
                f"{len(candidates)} days in {target_masa.label} carry {info.birth.nakshatra.name}; "
                "the occurrence closest to the birthday"
                + (f" in {target_lunar.label}" if target_lunar else "")
                + " is used."
            )
        confidence = "high" if score >= 2 else "medium"
        return chosen, warnings, confidence

    relaxed: list[tuple[int, DailyPanchang]] = []
    for day in days:
        if not _masa_matches(day, target_masa, check_adhika=False):
            continue
        if nakshatra_index(day) == target_nakshatra or day.nakshatra.index == target_nakshatra:
            relaxed.append((score_day(day), day))
    if relaxed:
        relaxed.sort(
            key=lambda item: (
                -item[0],
                abs((item[1].day - anniversary).days),
                item[1].day,
            )
        )
        warnings.append(
            "No day matched the Adhika/Nija masa flag exactly; a same-name month was used."
        )
        return relaxed[0][1], warnings, "low"

    # Last resort: the nakshatra is known but the masa is ambiguous.  Search
    # the whole year and flag it clearly.
    whole_year = [
        (score_day(day), day)
        for day in days
        if nakshatra_index(day) == target_nakshatra
    ]
    if whole_year:
        whole_year.sort(
            key=lambda item: (
                -item[0],
                abs((item[1].day - anniversary).days),
                item[1].day,
            )
        )
        warnings.append(
            "Birth masa could not be matched; the nakshatra occurrence closest "
            "to the birthday is used. Add birth_masa to the overrides to confirm."
        )
        return whole_year[0][1], warnings, "low"

    warnings.append(
        f"No {target_masa.label} day in {year} carried {info.birth.nakshatra.name}."
    )
    return None, warnings, "low"


# ---------------------------------------------------------------------------
# event construction
# ---------------------------------------------------------------------------


def _event_description(
    summary: str,
    member: FamilyMember | None,
    day: DailyPanchang,
    info: AstroPoint | None,
    *,
    extra: list[str] | None = None,
    confidence: str = "high",
) -> str:
    lines = [summary, ""]
    if member:
        lines.append(f"Person: {member.name} ({member.pid})")
        if member.gotra_label:
            lines.append(f"Gotram: {member.gotra_label}")
    if info:
        if info.date:
            lines.append(f"Recorded date: {_date_text(info.date)}")
        if info.tithi:
            lines.append(f"Tithi: {info.tithi.label} ({info.tithi.tamil_name})")
        if info.masa:
            lines.append(f"Masa: {info.masa.label} [{info.masa.system}]")
        if info.nakshatra:
            lines.append(
                f"Nakshatra: {info.nakshatra.name} ({info.nakshatra.tamil_name})"
                + (f", pada {info.nakshatra.pada}" if info.nakshatra.pada else "")
            )
    lines.append(
        f"Sunrise: {_clock(day.sunrise)}  Sunset: {_clock(day.sunset)}  "
        f"({day.location.timezone})"
    )
    lines.append(
        f"Aparahna: {_clock(day.aparahna_start)}-{_clock(day.aparahna_end)}  "
        f"Location: {day.location.name}"
    )
    if day.tithi_start and day.tithi_end:
        lines.append(
            f"Tithi window: {day.tithi_start.strftime('%d %b %H:%M')} - "
            f"{day.tithi_end.strftime('%d %b %H:%M')}"
        )
    if day.festivals:
        lines.append(f"Festivals: {', '.join(day.festivals)}")
    if extra:
        lines.extend(extra)
    lines.append("")
    lines.append(f"Confidence: {confidence}")
    lines.append(f"Source: {info.source if info else 'panchangam'}")
    return "\n".join(lines)


def _shraddha_event(
    member: FamilyMember,
    info: MemberAstro,
    day: DailyPanchang,
    year: int,
    confidence: str,
    settings: CalendarSettings,
) -> PanchangEvent:
    death = info.death
    gotra = f" ({member.gotra_label})" if member.gotra_label else ""
    summary = f"Shraddha / Tarpanam: {member.name}{gotra}"
    extra = [
        f"Death: {_date_text(death.date)}" if death else "",
        f"Death tithi: {death.tithi.label}" if death and death.tithi else "",
        f"Death masa: {death.masa.label}" if death and death.masa else "",
        f"Lunar masa at death: {death.lunar_masa.label}" if death and death.lunar_masa else "",
        f"Gotram: {member.gotra_label}" if member.gotra_label else "",
        f"Age at death: {member.age_at_death()}" if member.age_at_death() is not None else "",
    ]
    extra = [line for line in extra if line]
    description = _event_description(
        summary, member, day, death, extra=extra, confidence=confidence
    )
    window = tithi_window_on_day(day, info.death.tithi.index) if info.death and info.death.tithi else None
    start, end = (window or (day.aparahna_start, day.aparahna_end))
    return PanchangEvent(
        date=day.day,
        kind="shraddha",
        summary=summary,
        description=description,
        location=day.location,
        all_day=settings.event_mode == "all-day",
        start=start,
        end=end,
        person_id=member.pid,
        person_name=member.name,
        gotra=member.gotra,
        tithi=info.death.tithi.as_dict() if info.death and info.death.tithi else None,
        masa=info.death.masa.as_dict() if info.death and info.death.masa else None,
        nakshatra=info.death.nakshatra.as_dict() if info.death and info.death.nakshatra else None,
        festivals=list(day.festivals),
        details={
            "year": year,
            "death_date": _date_text(death.date) if death else None,
            "death_reference": death.reference.isoformat() if death and death.reference else None,
            "death_source": death.source if death else None,
            "aparahna_start": day.aparahna_start.isoformat(),
            "aparahna_end": day.aparahna_end.isoformat(),
            "tithi_window": [start.isoformat(), end.isoformat()],
            "ritual": "Shraddha / Tarpanam",
        },
        warnings=list(info.warnings),
        confidence=confidence,
        uid=f"kula-panchang-{_slug(member.pid)}-shraddha-{year}@kula.local",
    )


def _janma_event(
    member: FamilyMember,
    info: MemberAstro,
    day: DailyPanchang,
    year: int,
    confidence: str,
    settings: CalendarSettings,
) -> PanchangEvent:
    birth = info.birth
    summary = f"Janma Nakshatra: {member.name} - {info.birth.nakshatra.name if info.birth and info.birth.nakshatra else '?'}"
    extra = [
        f"Birth: {_date_text(birth.date)}" if birth else "",
        f"Birth nakshatra: {birth.nakshatra.name}" if birth and birth.nakshatra else "",
        f"Birth masa: {birth.masa.label}" if birth and birth.masa else "",
        f"Lunar masa at birth: {birth.lunar_masa.label}" if birth and birth.lunar_masa else "",
        f"Gotram: {member.gotra_label}" if member.gotra_label else "",
    ]
    extra = [line for line in extra if line]
    description = _event_description(
        summary, member, day, birth, extra=extra, confidence=confidence
    )
    return PanchangEvent(
        date=day.day,
        kind="janma_nakshatra",
        summary=summary,
        description=description,
        location=day.location,
        all_day=settings.event_mode == "all-day",
        start=day.sunrise,
        end=day.sunset,
        person_id=member.pid,
        person_name=member.name,
        gotra=member.gotra,
        tithi=birth.tithi.as_dict() if birth and birth.tithi else None,
        masa=birth.masa.as_dict() if birth and birth.masa else None,
        nakshatra=birth.nakshatra.as_dict() if birth and birth.nakshatra else None,
        festivals=list(day.festivals),
        details={
            "year": year,
            "birth_date": _date_text(birth.date) if birth else None,
            "birth_reference": birth.reference.isoformat() if birth and birth.reference else None,
            "birth_source": birth.source if birth else None,
            "nakshatra_start": day.nakshatra_start.isoformat() if day.nakshatra_start else None,
            "nakshatra_end": day.nakshatra_end.isoformat() if day.nakshatra_end else None,
            "ritual": "Janma Nakshatra",
        },
        warnings=list(info.warnings),
        confidence=confidence,
        uid=f"kula-panchang-{_slug(member.pid)}-janma-{year}@kula.local",
    )


def _amavasya_event(day: DailyPanchang, settings: CalendarSettings) -> PanchangEvent:
    solar = day.solar_masa
    summary = f"Amavasya Tarpanam ({solar.tamil_name} Masa)"
    extra = [
        f"Solar masa: {solar.label}",
        f"Lunar masa (amanta): {day.lunar_masa_amanta.label}",
        f"Lunar masa (purnimanta): {astro.lunar_masa(astro.to_jd(day.sunrise), day.location, 'lunar_purnimanta').label}",
        f"Tithi at aparahna: {day.tithi_aparahna.label}",
        f"Tithi window: {day.tithi_start.strftime('%d %b %H:%M') if day.tithi_start else '—'} - "
        f"{day.tithi_end.strftime('%d %b %H:%M') if day.tithi_end else '—'}",
    ]
    description = _event_description(
        summary, None, day, None, extra=extra, confidence="high"
    )
    return PanchangEvent(
        date=day.day,
        kind="amavasya",
        summary=summary,
        description=description,
        location=day.location,
        all_day=settings.event_mode == "all-day",
        start=day.aparahna_start,
        end=day.aparahna_end,
        tithi=day.tithi_sunrise.as_dict(),
        masa=solar.as_dict(),
        nakshatra=day.nakshatra.as_dict(),
        festivals=list(day.festivals),
        details={
            "solar_masa": solar.as_dict(),
            "lunar_masa_amanta": day.lunar_masa_amanta.as_dict(),
            "aparahna_amavasya": day.flags.get("aparahna_amavasya", False),
            "ritual": "Amavasya Tarpanam",
        },
        confidence="high",
        uid=f"kula-panchang-amavasya-{day.day.isoformat()}@kula.local",
    )


def _simple_event(
    day: DailyPanchang,
    kind: str,
    summary: str,
    settings: CalendarSettings,
    extra: list[str] | None = None,
) -> PanchangEvent:
    description = _event_description(
        summary, None, day, None, extra=extra, confidence="high"
    )
    return PanchangEvent(
        date=day.day,
        kind=kind,
        summary=summary,
        description=description,
        location=day.location,
        all_day=settings.event_mode == "all-day",
        start=day.sunrise,
        end=day.sunset,
        tithi=day.tithi_sunrise.as_dict(),
        masa=day.solar_masa.as_dict(),
        nakshatra=day.nakshatra.as_dict(),
        festivals=list(day.festivals),
        details={"ritual": summary, **({"notes": extra} if extra else {})},
        confidence="high",
        uid=f"kula-panchang-{kind}-{day.day.isoformat()}@kula.local",
    )


# ---------------------------------------------------------------------------
# year builder
# ---------------------------------------------------------------------------


def build_events(
    config: AppConfig,
    family: FamilyData | None = None,
    years: Iterable[int] | None = None,
    *,
    source: str = "auto",
    csv_path: str | None = None,
) -> tuple[list[PanchangEvent], list[str]]:
    settings = config.calendar
    if family is None:
        family = load_family(config, source=source, csv_path=csv_path)
    if years is None:
        years = settings.years or [date.today().year, date.today().year + 1]
    years = sorted({int(y) for y in years})

    warnings: list[str] = list(family.warnings)
    events: list[PanchangEvent] = []

    # Scan each distinct location once per year.
    locations: dict[tuple, LocationConfig] = {
        _location_key(config.location): config.location
    }
    for member in family.members:
        if member.location:
            locations[_location_key(member.location)] = member.location
    days_by_year_location: dict[tuple[int, tuple], list[DailyPanchang]] = {}
    for year in years:
        for key, location in locations.items():
            days_by_year_location[(year, key)] = _days_for_year(year, location, settings)

    for year in years:
        default = days_by_year_location[(year, _location_key(config.location))]
        default_by_date = {day.day: day for day in default}

        if settings.include.amavasya:
            for day in find_amavasya_days(year, config.location, settings):
                events.append(_amavasya_event(day, settings))
        if settings.include.purnima:
            for day in default:
                if day.is_purnima:
                    events.append(
                        _simple_event(
                            day,
                            "purnima",
                            f"Purnima ({day.solar_masa.tamil_name} Masa)",
                            settings,
                            extra=[f"Lunar masa (amanta): {day.lunar_masa_amanta.label}"],
                        )
                    )
        if settings.include.ekadasi:
            for day in default:
                if day.is_ekadasi:
                    events.append(
                        _simple_event(
                            day,
                            "ekadasi",
                            f"Ekadasi Vratam ({day.tithi_sunrise.paksha})",
                            settings,
                        )
                    )
        if settings.include.pradosham:
            for day in default:
                if day.is_pradosham:
                    events.append(
                        _simple_event(
                            day,
                            "pradosham",
                            "Pradosham",
                            settings,
                            extra=[
                                f"Pradosha window: {_clock(day.pradosha_start)}-{_clock(day.pradosha_end)}",
                                f"Tithi at pradosha: {astro.tithi_state(astro.to_jd(day.pradosha_start + (day.pradosha_end - day.pradosha_start) / 2)).label}",
                            ],
                        )
                    )
        if settings.include.festivals:
            for day in default:
                for festival in day.festivals:
                    # Amavasya festivals are folded into the Amavasya event.
                    if "amavasya" in festival.lower() and settings.include.amavasya:
                        continue
                    events.append(
                        _simple_event(day, "festival", festival, settings)
                    )

        for member in family.members:
            location = member.location or config.location
            days = days_by_year_location[(year, _location_key(location))]
            info = resolve_member(member, config)
            warnings.extend(f"{member.name} ({member.pid}): {w}" for w in info.warnings)

            if member.is_deceased and settings.include.shraddha:
                day, match_warnings, confidence = find_shraddha_day(
                    member, info, year, days
                )
                warnings.extend(f"{member.name} ({member.pid}): {w}" for w in match_warnings)
                if day:
                    events.append(
                        _shraddha_event(member, info, day, year, confidence, settings)
                    )

            if member.is_living and settings.include.janma_nakshatra:
                day, match_warnings, confidence = find_janma_day(
                    member, info, year, days, settings
                )
                warnings.extend(f"{member.name} ({member.pid}): {w}" for w in match_warnings)
                if day:
                    events.append(
                        _janma_event(member, info, day, year, confidence, settings)
                    )

            if settings.include.gregorian_birthday and member.birth_date:
                try:
                    birthday = date(year, member.birth_date.month, member.birth_date.day)
                except ValueError:
                    birthday = date(year, 3, 1)
                day = default_by_date.get(birthday) or get_daily_panchang(
                    birthday, config.location, settings
                )
                events.append(
                    _simple_event(
                        day,
                        "gregorian_birthday",
                        f"Birthday: {member.name}",
                        settings,
                        extra=[f"Born: {_date_text(member.birth_date)}"],
                    )
                )

            if settings.include.death_anniversary and member.death_date:
                try:
                    anniversary = date(year, member.death_date.month, member.death_date.day)
                except ValueError:
                    anniversary = date(year, 3, 1)
                day = default_by_date.get(anniversary) or get_daily_panchang(
                    anniversary, config.location, settings
                )
                events.append(
                    _simple_event(
                        day,
                        "death_anniversary",
                        f"Death Anniversary: {member.name}",
                        settings,
                        extra=[f"Died: {_date_text(member.death_date)}"],
                    )
                )

    # Stable ordering: date, then all-day/person/family events before generic.
    kind_order = {
        "shraddha": 0,
        "amavasya": 1,
        "janma_nakshatra": 2,
        "gregorian_birthday": 3,
        "death_anniversary": 4,
        "purnima": 5,
        "ekadasi": 6,
        "pradosham": 7,
        "festival": 8,
    }
    events.sort(key=lambda e: (e.date, kind_order.get(e.kind, 99), e.summary))
    # De-duplicate by UID (the same panchang day is shared across locations).
    seen: set[str] = set()
    unique: list[PanchangEvent] = []
    for event in events:
        if event.uid in seen:
            continue
        seen.add(event.uid)
        unique.append(event)
    return unique, warnings


def explain_member(config: AppConfig, member: FamilyMember, year: int) -> dict:
    """Return a human-readable explanation of a member's derived tithi."""

    info = resolve_member(member, config)
    days = _days_for_year(year, info.location, config.calendar)
    result: dict = {
        "person": {
            "pid": member.pid,
            "name": member.name,
            "status": member.status,
            "gotra": member.gotra_label or None,
            "birth_date": _date_text(member.birth_date),
            "death_date": _date_text(member.death_date),
            "location": info.location.name,
        },
        "death": None,
        "birth": None,
        "events": [],
        "warnings": list(info.warnings),
    }
    if info.death:
        result["death"] = {
            "date": _date_text(info.death.date),
            "reference": info.death.reference.isoformat() if info.death.reference else None,
            "source": info.death.source,
            "confidence": info.death.confidence,
            "tithi": info.death.tithi.as_dict() if info.death.tithi else None,
            "masa": info.death.masa.as_dict() if info.death.masa else None,
            "lunar_masa": info.death.lunar_masa.as_dict() if info.death.lunar_masa else None,
            "nakshatra": info.death.nakshatra.as_dict() if info.death.nakshatra else None,
        }
        if member.is_deceased:
            day, match_warnings, confidence = find_shraddha_day(
                member, info, year, days
            )
            result["warnings"].extend(match_warnings)
            if day:
                event = _shraddha_event(
                    member, info, day, year, confidence, config.calendar
                )
                result["events"].append(event.to_dict())
    if info.birth:
        result["birth"] = {
            "date": _date_text(info.birth.date),
            "reference": info.birth.reference.isoformat() if info.birth.reference else None,
            "source": info.birth.source,
            "confidence": info.birth.confidence,
            "tithi": info.birth.tithi.as_dict() if info.birth.tithi else None,
            "masa": info.birth.masa.as_dict() if info.birth.masa else None,
            "lunar_masa": info.birth.lunar_masa.as_dict() if info.birth.lunar_masa else None,
            "nakshatra": info.birth.nakshatra.as_dict() if info.birth.nakshatra else None,
        }
        if member.is_living and config.calendar.include.janma_nakshatra:
            day, match_warnings, confidence = find_janma_day(
                member, info, year, days, config.calendar
            )
            result["warnings"].extend(match_warnings)
            if day:
                event = _janma_event(
                    member, info, day, year, confidence, config.calendar
                )
                result["events"].append(event.to_dict())
    # Festival cross-check for the death date's tithi/masa in the target year.
    result["festivals_on_event_dates"] = sorted(
        {
            festival
            for event in result["events"]
            for festival in event.get("festivals", [])
        }
    )
    return result
