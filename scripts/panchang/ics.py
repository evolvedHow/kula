"""iCalendar (RFC 5545) export for panchangam events.

The generated feed is a normal ``.ics`` file that Google Calendar, Apple
Calendar and Outlook can subscribe to.  It uses all-day events by default so a
shraddha or janma-nakshatra date appears on the correct civil day in the
family's timezone without a misleading clock time.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from icalendar import Calendar, Event as ICalEvent, Timezone

from .config import CalendarSettings
from .models import PanchangEvent


def _tz(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError as exc:
        raise ValueError(f"Unknown timezone {name!r}") from exc


def _alarm(vevent: ICalEvent, days: int) -> None:
    if days <= 0:
        return
    from icalendar import Alarm

    alarm = Alarm()
    alarm.add("action", "DISPLAY")
    alarm.add("description", "Kula Panchangam reminder")
    alarm.add("trigger", timedelta(days=-days))
    vevent.add_component(alarm)


def event_to_vevent(
    event: PanchangEvent,
    calendar_settings: CalendarSettings,
    calendar_timezone: str,
) -> ICalEvent:
    vevent = ICalEvent()
    vevent.add("uid", event.uid)
    vevent.add("dtstamp", datetime.now(timezone.utc))
    vevent.add("summary", event.summary)
    vevent.add("description", event.description)
    vevent.add("location", event.location.name)
    vevent.add("categories", [event.kind, *event.festivals])
    vevent.add("transp", "TRANSPARENT")
    vevent.add("x-kula-kind", event.kind)
    vevent.add("x-kula-confidence", event.confidence)
    if event.person_id:
        vevent.add("x-kula-person-id", event.person_id)
    if event.person_name:
        vevent.add("x-kula-person-name", event.person_name)
    if event.gotra:
        vevent.add("x-kula-gotra", event.gotra)

    if event.all_day or event.start is None:
        vevent.add("dtstart", event.date)
        vevent.add("dtend", event.date + timedelta(days=1))
    else:
        start = event.start
        end = event.end or (start + timedelta(hours=1))
        if start.tzinfo is None:
            start = start.replace(tzinfo=_tz(calendar_timezone))
        if end.tzinfo is None:
            end = end.replace(tzinfo=_tz(calendar_timezone))
        vevent.add("dtstart", start)
        vevent.add("dtend", end)

    for days in calendar_settings.reminders_days:
        _alarm(vevent, int(days))
    return vevent


def build_calendar(
    events: list[PanchangEvent],
    settings: CalendarSettings,
    *,
    name: str | None = None,
    description: str | None = None,
    timezone_name: str | None = None,
) -> Calendar:
    tz_name = timezone_name or (events[0].location.timezone if events else settings.name)
    cal = Calendar()
    cal.add("prodid", "-//Kula Panchangam//kula-panchang//EN")
    cal.add("version", "2.0")
    cal.add("calscale", "GREGORIAN")
    cal.add("method", "PUBLISH")
    cal.add("x-wr-calname", name or settings.name)
    cal.add("x-wr-caldesc", description or settings.description)
    cal.add("x-wr-timezone", tz_name)
    cal.add("x-published-ttl", "PT12H")
    if events:
        cal.add_component(Timezone.from_tzinfo(_tz(tz_name)))
    for event in events:
        cal.add_component(event_to_vevent(event, settings, tz_name))
    return cal


def calendar_to_bytes(calendar: Calendar) -> bytes:
    return calendar.to_ical()


def write_ics(
    path: Path,
    events: list[PanchangEvent],
    settings: CalendarSettings,
    *,
    name: str | None = None,
    description: str | None = None,
    timezone_name: str | None = None,
) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        calendar_to_bytes(
            build_calendar(
                events,
                settings,
                name=name,
                description=description,
                timezone_name=timezone_name,
            )
        )
    )
    return path


def event_to_google(event: PanchangEvent, settings: CalendarSettings, calendar_timezone: str) -> dict:
    """Convert an event to the Google Calendar API ``events.insert`` body."""

    body: dict = {
        "summary": event.summary,
        "description": event.description,
        "location": event.location.name,
        "iCalUID": event.uid,
        "extendedProperties": {
            "private": {
                "kula_source": "kula-panchang",
                "kula_kind": event.kind,
                "kula_confidence": event.confidence,
            }
        },
    }
    if event.person_id:
        body["extendedProperties"]["private"]["kula_person_id"] = event.person_id
    if event.all_day or event.start is None:
        body["start"] = {"date": event.date.isoformat()}
        body["end"] = {"date": (event.date + timedelta(days=1)).isoformat()}
    else:
        tz = _tz(calendar_timezone)
        start = event.start if event.start.tzinfo else event.start.replace(tzinfo=tz)
        end = event.end or (start + timedelta(hours=1))
        if end.tzinfo is None:
            end = end.replace(tzinfo=tz)
        body["start"] = {"dateTime": start.isoformat(), "timeZone": calendar_timezone}
        body["end"] = {"dateTime": end.isoformat(), "timeZone": calendar_timezone}
    body["reminders"] = {
        "useDefault": False,
        "overrides": [
            {"method": "popup", "minutes": 9 * 60 * d}
            for d in settings.reminders_days
            if d > 0
        ],
    }
    return body


def ics_filename(year: int | None, feed_name: str = "panchang.ics") -> str:
    if year is None:
        return feed_name
    stem = feed_name[:-4] if feed_name.lower().endswith(".ics") else feed_name
    return f"{stem}-{year}.ics"
