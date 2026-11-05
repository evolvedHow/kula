"""Daily Panchangam calculations and year scans."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Iterable

from . import astronomy as astro
from .config import AppConfig, CalendarSettings, LocationConfig


@dataclass
class DailyPanchang:
    day: date
    location: LocationConfig
    sunrise: datetime
    sunset: datetime
    solar_noon: datetime
    aparahna_start: datetime
    aparahna_end: datetime
    tithi_sunrise: astro.TithiState
    tithi_aparahna: astro.TithiState
    nakshatra: astro.NakshatraState
    yoga: astro.YogaState
    karana: astro.KaranaState
    solar_masa: astro.MasaState
    lunar_masa: astro.MasaState
    lunar_masa_amanta: astro.MasaState
    tithi_start: datetime | None = None
    tithi_end: datetime | None = None
    nakshatra_start: datetime | None = None
    nakshatra_end: datetime | None = None
    pradosha_start: datetime | None = None
    pradosha_end: datetime | None = None
    festivals: list[str] = field(default_factory=list)
    flags: dict[str, bool] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)

    @property
    def weekday(self) -> str:
        return astro.WEEKDAYS[self.day.weekday()]

    @property
    def is_amavasya(self) -> bool:
        return self.flags.get("amavasya", False)

    @property
    def is_purnima(self) -> bool:
        return self.flags.get("purnima", False)

    @property
    def is_ekadasi(self) -> bool:
        return self.flags.get("ekadasi", False)

    @property
    def is_pradosham(self) -> bool:
        return self.flags.get("pradosham", False)

    @property
    def is_sankranti(self) -> bool:
        return self.flags.get("sankranti", False)

    def to_dict(self) -> dict:
        return {
            "date": self.day.isoformat(),
            "weekday": self.weekday,
            "location": {
                "name": self.location.name,
                "latitude": self.location.latitude,
                "longitude": self.location.longitude,
                "elevation_m": self.location.elevation_m,
                "timezone": self.location.timezone,
            },
            "sunrise": self.sunrise.isoformat(),
            "sunset": self.sunset.isoformat(),
            "solar_noon": self.solar_noon.isoformat(),
            "aparahna": {
                "start": self.aparahna_start.isoformat(),
                "end": self.aparahna_end.isoformat(),
            },
            "tithi": {
                "sunrise": self.tithi_sunrise.as_dict(),
                "aparahna": self.tithi_aparahna.as_dict(),
                "start": self.tithi_start.isoformat() if self.tithi_start else None,
                "end": self.tithi_end.isoformat() if self.tithi_end else None,
            },
            "nakshatra": {
                **self.nakshatra.as_dict(),
                "start": self.nakshatra_start.isoformat() if self.nakshatra_start else None,
                "end": self.nakshatra_end.isoformat() if self.nakshatra_end else None,
            },
            "yoga": self.yoga.as_dict(),
            "karana": self.karana.as_dict(),
            "solar_masa": self.solar_masa.as_dict(),
            "lunar_masa": self.lunar_masa.as_dict(),
            "lunar_masa_amanta": self.lunar_masa_amanta.as_dict(),
            "pradosha": {
                "start": self.pradosha_start.isoformat() if self.pradosha_start else None,
                "end": self.pradosha_end.isoformat() if self.pradosha_end else None,
            },
            "festivals": list(self.festivals),
            "flags": dict(self.flags),
            "warnings": list(self.warnings),
        }


def configure_astronomy(config: AppConfig) -> None:
    astro.configure(
        ayanamsha=config.astro.ayanamsha,
        ephe_path=config.astro.ephe_path,
    )


def get_daily_panchang(
    day: date,
    location: LocationConfig | None = None,
    settings: CalendarSettings | None = None,
    *,
    include_bounds: bool = True,
    include_festivals: bool = True,
) -> DailyPanchang:
    location = location or LocationConfig()
    settings = settings or CalendarSettings()
    astro.configure()
    tz = astro.timezone_for(location)

    rise = astro.sunrise(day, location)
    sets = astro.sunset(day, location)
    noon = astro.solar_noon(day, location)
    ap_start, ap_end = astro.aparahna_window(
        day, location, settings.aparahna_start, settings.aparahna_end
    )
    pradosha_start, pradosha_end = astro.pradosha_window(
        day,
        location,
        settings.pradosha_before_sunset_minutes,
        settings.pradosha_after_sunset_minutes,
    )

    jd_rise = astro.to_jd(rise)
    tithi_rise = astro.tithi_state(jd_rise)
    tithi_ap = astro.tithi_state(astro.to_jd(ap_start + (ap_end - ap_start) / 2))
    nakshatra = astro.nakshatra_state(jd_rise)
    yoga = astro.yoga_state(jd_rise)
    karana = astro.karana_state(jd_rise)
    solar = astro.solar_masa(jd_rise, location)
    lunar_amanta = astro.lunar_masa(jd_rise, location, "lunar_amanta")
    if settings.masa_system == "lunar_purnimanta":
        lunar = astro.lunar_masa(jd_rise, location, "lunar_purnimanta")
    else:
        lunar = lunar_amanta

    tithi_start = tithi_end = nakshatra_start = nakshatra_end = None
    warnings: list[str] = []
    if include_bounds:
        tithi_start, tithi_end = astro.tithi_bounds(jd_rise, location)
        nakshatra_start, nakshatra_end = astro.nakshatra_bounds(jd_rise, location)
        if tithi_rise.index != tithi_ap.index:
            warnings.append(
                f"Tithi changes during aparahna: {tithi_rise.label} -> {tithi_ap.label}"
            )

    # Pradosham is Trayodasi at sunset.  Evaluate at the midpoint of the
    # pradosha window so a tithi that changes just after sunset is still caught.
    pradosha_mid = pradosha_start + (pradosha_end - pradosha_start) / 2
    pradosha_tithi = astro.tithi_state(astro.to_jd(pradosha_mid))
    flags = {
        "amavasya": tithi_rise.index == 30,
        "purnima": tithi_rise.index == 15,
        "ekadasi": tithi_rise.index in {11, 26},
        "pradosham": pradosha_tithi.index in {13, 28},
        "sankranti": bool(solar.end and solar.end.astimezone(tz).date() == day),
        "aparahna_amavasya": tithi_ap.index == 30,
        "aparahna_purnima": tithi_ap.index == 15,
    }

    daily = DailyPanchang(
        day=day,
        location=location,
        sunrise=rise,
        sunset=sets,
        solar_noon=noon,
        aparahna_start=ap_start,
        aparahna_end=ap_end,
        tithi_sunrise=tithi_rise,
        tithi_aparahna=tithi_ap,
        nakshatra=nakshatra,
        yoga=yoga,
        karana=karana,
        solar_masa=solar,
        lunar_masa=lunar,
        lunar_masa_amanta=lunar_amanta,
        tithi_start=tithi_start,
        tithi_end=tithi_end,
        nakshatra_start=nakshatra_start,
        nakshatra_end=nakshatra_end,
        pradosha_start=pradosha_start,
        pradosha_end=pradosha_end,
        flags=flags,
        warnings=warnings,
    )

    if include_festivals:
        from .festivals import match_festivals

        daily.festivals = match_festivals(daily)
    return daily


def year_days(year: int) -> Iterable[date]:
    current = date(year, 1, 1)
    end = date(year, 12, 31)
    while current <= end:
        yield current
        current += timedelta(days=1)


def scan_year(
    year: int,
    location: LocationConfig | None = None,
    settings: CalendarSettings | None = None,
    *,
    include_bounds: bool = False,
) -> list[DailyPanchang]:
    location = location or LocationConfig()
    settings = settings or CalendarSettings()
    return [
        get_daily_panchang(
            day,
            location,
            settings,
            include_bounds=include_bounds,
            include_festivals=True,
        )
        for day in year_days(year)
    ]


def scan_range(
    start: date,
    end: date,
    location: LocationConfig | None = None,
    settings: CalendarSettings | None = None,
    *,
    include_bounds: bool = False,
) -> list[DailyPanchang]:
    location = location or LocationConfig()
    settings = settings or CalendarSettings()
    result: list[DailyPanchang] = []
    current = start
    while current <= end:
        result.append(
            get_daily_panchang(
                current,
                location,
                settings,
                include_bounds=include_bounds,
                include_festivals=True,
            )
        )
        current += timedelta(days=1)
    return result


def find_amavasya_days(
    year: int,
    location: LocationConfig | None = None,
    settings: CalendarSettings | None = None,
) -> list[DailyPanchang]:
    """Return one Amavasya day per lunar month, using the aparahna rule.

    For tarpanam the relevant test is whether Amavasya prevails during
    aparahna.  A day where Amavasya only touches aparahna still counts.  If a
    rare month has no such day, the day whose sunrise tithi is Amavasya is
    used instead.
    """

    location = location or LocationConfig()
    settings = settings or CalendarSettings()
    days = scan_range(
        date(year, 1, 1) - timedelta(days=2),
        date(year, 12, 31) + timedelta(days=2),
        location,
        settings,
        include_bounds=False,
    )

    # A continuous run of Amavasya days is one lunar month.  Pick the day in
    # the run where Amavasya is strongest at aparahna; prefer an exact
    # aparahna Amavasya, then a sunrise Amavasya.
    runs: list[list[DailyPanchang]] = []
    for day in days:
        if not (day.flags.get("aparahna_amavasya") or day.is_amavasya):
            continue
        if runs and (day.day - runs[-1][-1].day).days == 1:
            runs[-1].append(day)
        else:
            runs.append([day])

    result: list[DailyPanchang] = []
    for run in runs:
        chosen = next(
            (day for day in run if day.flags.get("aparahna_amavasya")),
            next((day for day in run if day.is_amavasya), run[0]),
        )
        if chosen.day.year == year and chosen not in result:
            result.append(chosen)
    return sorted(result, key=lambda day: day.day)


def tithi_window_on_day(
    day: DailyPanchang,
    tithi_index: int,
) -> tuple[datetime, datetime] | None:
    """Return the part of the day's aparahna window when a tithi prevails."""

    states = {
        "start": astro.tithi_state(astro.to_jd(day.aparahna_start)),
        "mid": day.tithi_aparahna,
        "end": astro.tithi_state(astro.to_jd(day.aparahna_end)),
    }
    if not any(s.index == tithi_index for s in states.values()):
        return None
    if states["start"].index == states["end"].index:
        return (day.aparahna_start, day.aparahna_end)
    # The tithi changes within aparahna.  Report the half-window containing it.
    if states["start"].index == tithi_index:
        return (day.aparahna_start, day.aparahna_start + (day.aparahna_end - day.aparahna_start) / 2)
    if states["end"].index == tithi_index:
        return (day.aparahna_start + (day.aparahna_end - day.aparahna_start) / 2, day.aparahna_end)
    return (day.aparahna_start, day.aparahna_end)


def tithi_present_during_aparahna(day: DailyPanchang, tithi_index: int) -> bool:
    start = astro.tithi_state(astro.to_jd(day.aparahna_start)).index
    end = astro.tithi_state(astro.to_jd(day.aparahna_end)).index
    return tithi_index in {start, day.tithi_aparahna.index, end}
