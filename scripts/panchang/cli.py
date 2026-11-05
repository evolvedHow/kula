"""Command-line interface for the Kula Panchangam engine.

Examples
--------
    python -m scripts.panchang day
    python -m scripts.panchang day --date 2026-08-17
    python -m scripts.panchang list --year 2026
    python -m scripts.panchang list --year 2026 --kind shraddha
    python -m scripts.panchang explain C008 --year 2026
    python -m scripts.panchang amavasya --year 2026
    python -m scripts.panchang build --years 2026,2027
    python -m scripts.panchang serve --build
    python -m scripts.panchang sync-google --years 2026 --dry-run
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

from . import __version__
from .config import AppConfig, ConfigError, find_config, load_config
from .engine import find_amavasya_days, get_daily_panchang, scan_range, scan_year
from .ics import ics_filename, write_ics
from .matcher import build_events, explain_member
from .models import FamilyData, FamilyMember, PanchangEvent
from .sources import load_family


# ---------------------------------------------------------------------------
# formatting helpers
# ---------------------------------------------------------------------------


def _parse_date(value: str) -> date:
    try:
        from dateutil import parser as date_parser

        return date_parser.parse(value, dayfirst=True).date()
    except Exception as exc:
        raise argparse.ArgumentTypeError(f"Invalid date {value!r}") from exc


def _years(value: str | None, config: AppConfig) -> list[int]:
    if value:
        years: list[int] = []
        for part in value.replace(" ", ",").split(","):
            if not part:
                continue
            if "-" in part:
                start, end = part.split("-", 1)
                years.extend(range(int(start), int(end) + 1))
            else:
                years.append(int(part))
        return sorted(set(years))
    if config.calendar.years:
        return sorted(set(config.calendar.years))
    today = date.today()
    return [today.year, today.year + 1]


def _event_lines(events: Iterable[PanchangEvent]) -> list[str]:
    lines = []
    for event in events:
        tithi = (event.tithi or {}).get("label") or ""
        masa = (event.masa or {}).get("label") or ""
        extras = " · ".join(x for x in (tithi, masa) if x)
        line = f"{event.date.isoformat()}  {event.date.strftime('%a')}  {event.kind:<17} {event.summary}"
        if extras:
            line += f"  [{extras}]"
        if event.festivals:
            line += f"  🎉 {', '.join(event.festivals)}"
        lines.append(line)
    return lines


def _print_json(data) -> None:
    print(json.dumps(data, indent=2, ensure_ascii=False, default=str))


def _event_payload(events: list[PanchangEvent], config: AppConfig, years: list[int]) -> dict:
    return {
        "schema": "kula-panchang/v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "years": years,
        "location": config.location.as_dict(),
        "calendar": config.calendar.as_dict(),
        "counts": _counts(events),
        "events": [event.to_dict() for event in events],
    }


def _counts(events: list[PanchangEvent]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for event in events:
        counts[event.kind] = counts.get(event.kind, 0) + 1
    return dict(sorted(counts.items()))


# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------


def cmd_day(args, config: AppConfig) -> int:
    day = args.date or date.today()
    daily = get_daily_panchang(day, config.location, config.calendar)
    if args.json:
        _print_json(daily.to_dict())
        return 0
    print(f"{daily.day.strftime('%A, %d %B %Y')} — {daily.location.name}")
    print(f"Sunrise {daily.sunrise.strftime('%H:%M')}  Sunset {daily.sunset.strftime('%H:%M')}  "
          f"Solar noon {daily.solar_noon.strftime('%H:%M')} ({daily.location.timezone})")
    print(f"Tithi (sunrise):  {daily.tithi_sunrise.label} ({daily.tithi_sunrise.tamil_name})")
    print(f"Tithi (aparahna): {daily.tithi_aparahna.label}")
    if daily.tithi_start and daily.tithi_end:
        print(f"Tithi window:     {daily.tithi_start.strftime('%d %b %H:%M')} – {daily.tithi_end.strftime('%d %b %H:%M')}")
    print(f"Nakshatra:        {daily.nakshatra.name} ({daily.nakshatra.tamil_name}), pada {daily.nakshatra.pada}")
    if daily.nakshatra_start and daily.nakshatra_end:
        print(f"Nakshatra window: {daily.nakshatra_start.strftime('%d %b %H:%M')} – {daily.nakshatra_end.strftime('%d %b %H:%M')}")
    print(f"Yoga:             {daily.yoga.name}")
    print(f"Karana:           {daily.karana.name}")
    print(f"Solar masa:       {daily.solar_masa.label}")
    print(f"Lunar masa:       {daily.lunar_masa.label} (amanta: {daily.lunar_masa_amanta.label})")
    print(f"Aparahna:         {daily.aparahna_start.strftime('%H:%M')} – {daily.aparahna_end.strftime('%H:%M')}")
    if daily.festivals:
        print(f"Festivals:        {', '.join(daily.festivals)}")
    if daily.warnings:
        print("\nWarnings:")
        for warning in daily.warnings:
            print(f"  • {warning}")
    return 0


def cmd_month(args, config: AppConfig) -> int:
    year = args.year or date.today().year
    month = args.month or date.today().month
    start = date(year, month, 1)
    next_month = date(year + (month == 12), 1 if month == 12 else month + 1, 1)
    days = scan_range(start, next_month - timedelta(days=1), config.location, config.calendar)
    if args.json:
        _print_json([d.to_dict() for d in days])
        return 0
    print(f"{start.strftime('%B %Y')} — {config.location.name}")
    print(f"{'Date':<12} {'Day':<4} {'Tithi (sunrise)':<24} {'Nakshatra':<20} Festivals")
    for day in days:
        print(
            f"{day.day.isoformat():<12} {day.day.strftime('%a'):<4} "
            f"{day.tithi_sunrise.label:<24} {day.nakshatra.name:<20} "
            f"{', '.join(day.festivals)}"
        )
    return 0


def cmd_list(args, config: AppConfig) -> int:
    years = _years(str(args.year) if args.year else None, config)
    family = load_family(config, source=args.source, csv_path=args.csv)
    events, warnings = build_events(config, family, years)
    if args.kind:
        wanted = {k.strip().lower() for k in args.kind.split(",")}
        events = [e for e in events if e.kind.lower() in wanted]
    if args.person:
        needle = args.person.lower()
        events = [
            e
            for e in events
            if needle in (e.person_id or "").lower() or needle in (e.person_name or "").lower()
        ]
    if args.month:
        events = [e for e in events if e.date.month == args.month]
    if args.json:
        _print_json(_event_payload(events, config, years))
        return 0
    if not events:
        print("No events matched.")
        return 0
    print("\n".join(_event_lines(events)))
    if args.warnings:
        print("\nWarnings:")
        for warning in warnings:
            print(f"  • {warning}")
    print(f"\n{len(events)} event(s) — {config.location.name}, {config.calendar.masa_system} masa")
    return 0


def _find_member(family: FamilyData, query: str) -> list[FamilyMember]:
    needle = query.strip().lower()
    exact = [
        m
        for m in family.members
        if m.pid.lower() == needle or m.name.lower() == needle
    ]
    if exact:
        return exact
    return [m for m in family.members if needle in m.name.lower()]


def cmd_explain(args, config: AppConfig) -> int:
    family = load_family(config, source=args.source, csv_path=args.csv)
    matches = _find_member(family, args.person)
    if not matches:
        print(f"No family member matched {args.person!r}.", file=sys.stderr)
        return 2
    if len(matches) > 1:
        print(f"{len(matches)} people matched {args.person!r}:", file=sys.stderr)
        for member in matches:
            born = member.birth_date.isoformat() if member.birth_date else "?"
            died = member.death_date.isoformat() if member.death_date else "—"
            print(f"  {member.pid:<8} {member.name}  ({born} – {died})", file=sys.stderr)
        print("Use the PID to disambiguate.", file=sys.stderr)
        return 2
    member = matches[0]
    year = args.year or date.today().year
    result = explain_member(config, member, year)
    if args.json:
        _print_json(result)
        return 0

    person = result["person"]
    print(f"{person['name']} ({person['pid']}) — {person['status']}")
    if person["gotra"]:
        print(f"Gotram: {person['gotra']}")
    print(f"Birth: {person['birth_date']}    Death: {person['death_date']}    Location: {person['location']}")
    for label, key in (("Death", "death"), ("Birth", "birth")):
        info = result.get(key)
        if not info:
            continue
        print(f"\n{label} panchangam (recorded {info['date']}):")
        if info.get("tithi"):
            t = info["tithi"]
            print(f"  Tithi:      {t['label']} ({t['tamil_name']})")
        if info.get("masa"):
            m = info["masa"]
            print(f"  Masa:       {m['label']} [{m['system']}]")
        if info.get("nakshatra"):
            n = info["nakshatra"]
            print(f"  Nakshatra:  {n['name']} ({n['tamil_name']})" + (f", pada {n['pada']}" if n["pada"] else ""))
        print(f"  Source:     {info['source']} ({info['confidence']})")
    print(f"\n{year} events:")
    if not result["events"]:
        print("  (none)")
    for event in result["events"]:
        print(f"  {event['date']}  {event['kind']:<17} {event['summary']}")
        if event.get("festivals"):
            print(f"      Festivals: {', '.join(event['festivals'])}")
    if result.get("festivals_on_event_dates"):
        print(f"\nFestivals on the {year} event date(s): {', '.join(result['festivals_on_event_dates'])}")
    if result["warnings"]:
        print("\nWarnings:")
        for warning in dict.fromkeys(result["warnings"]):
            print(f"  • {warning}")
    return 0


def cmd_amavasya(args, config: AppConfig) -> int:
    year = args.year or date.today().year
    days = find_amavasya_days(year, config.location, config.calendar)
    if args.json:
        _print_json([day.to_dict() for day in days])
        return 0
    print(f"Amavasya tarpanam days in {year} — {config.location.name} (aparahna rule)")
    for day in days:
        print(
            f"{day.day.isoformat()}  {day.day.strftime('%a')}  "
            f"{day.solar_masa.tamil_name:<12}  tithi@sunrise {day.tithi_sunrise.label:<20} "
            f"tithi@aparahna {day.tithi_aparahna.label}"
        )
    print(f"\n{len(days)} Amavasya day(s).")
    return 0


def _write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False, default=str) + "\n", encoding="utf-8")


def _build_artifacts(
    config: AppConfig,
    years: list[int],
    family: FamilyData,
    *,
    write_daily: bool = False,
    write_members: bool = False,
) -> dict:
    events, warnings = build_events(config, family, years)
    out = config.output_dir
    out.mkdir(parents=True, exist_ok=True)
    feed_name = config.feed_name

    combined = _event_payload(events, config, years)
    _write_json(out / "panchang.json", combined)
    write_ics(
        out / feed_name,
        events,
        config.calendar,
        name=config.calendar.name,
        description=config.calendar.description,
        timezone_name=config.location.timezone,
    )

    per_year: dict[str, dict] = {}
    for year in years:
        year_events = [event for event in events if event.date.year == year]
        payload = _event_payload(year_events, config, [year])
        _write_json(out / f"panchang-{year}.json", payload)
        write_ics(
            out / ics_filename(year, feed_name),
            year_events,
            config.calendar,
            name=f"{config.calendar.name} {year}",
            description=config.calendar.description,
            timezone_name=config.location.timezone,
        )
        per_year[str(year)] = {
            "events": len(year_events),
            "counts": _counts(year_events),
            "ics": ics_filename(year, feed_name),
            "json": f"panchang-{year}.json",
        }

        if write_daily:
            daily = scan_year(year, config.location, config.calendar, include_bounds=False)
            _write_json(
                out / f"daily-{year}.json",
                {
                    "schema": "kula-panchang-daily/v1",
                    "year": year,
                    "location": config.location.as_dict(),
                    "generated_at": datetime.now(timezone.utc).isoformat(),
                    "days": [day.to_dict() for day in daily],
                },
            )

        if write_members:
            members = [explain_member(config, member, year) for member in family.members]
            _write_json(
                out / f"members-{year}.json",
                {
                    "schema": "kula-panchang-members/v1",
                    "year": year,
                    "generated_at": datetime.now(timezone.utc).isoformat(),
                    "members": members,
                },
            )

    index = {
        "schema": "kula-panchang-index/v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "calendar": config.calendar.name,
        "description": config.calendar.description,
        "location": config.location.as_dict(),
        "masa_system": config.calendar.masa_system,
        "source": family.source,
        "source_metadata": family.metadata,
        "years": years,
        "feed": feed_name,
        "counts": _counts(events),
        "total_events": len(events),
        "per_year": per_year,
        "warnings": list(dict.fromkeys(warnings)),
    }
    _write_json(out / "index.json", index)
    return {"events": events, "warnings": warnings, "index": index}


def cmd_build(args, config: AppConfig) -> int:
    years = _years(args.years, config)
    family = load_family(config, source=args.source, csv_path=args.csv)
    result = _build_artifacts(
        config,
        years,
        family,
        write_daily=args.daily,
        write_members=args.members,
    )
    index = result["index"]
    print(f"Wrote {index['total_events']} events to {config.output_dir}")
    print(f"  Feed: {config.output_dir / config.feed_name}")
    for year in years:
        info = index["per_year"][str(year)]
        print(f"  {year}: {info['events']} events — {info['ics']}, {info['json']}")
    print(f"  Source: {family.source} ({len(family.members)} members)")
    if result["warnings"]:
        print(f"  {len(result['warnings'])} warning(s); use --warnings on `list` to inspect.")
    return 0


def cmd_serve(args, config: AppConfig) -> int:
    if args.build:
        family = load_family(config, source=args.source, csv_path=args.csv)
        _build_artifacts(config, _years(args.years, config), family)
    from .server import serve

    serve(config, host=args.host, port=args.port)
    return 0


def cmd_sync_google(args, config: AppConfig) -> int:
    from .google_calendar import sync

    years = _years(args.years, config)
    family = load_family(config, source=args.source, csv_path=args.csv)
    events, warnings = build_events(config, family, years)
    summary = sync(
        config,
        events,
        calendar_id=args.calendar,
        dry_run=args.dry_run,
        prune=args.prune,
    )
    _print_json(summary)
    if warnings and args.warnings:
        print("Warnings:", file=sys.stderr)
        for warning in warnings:
            print(f"  • {warning}", file=sys.stderr)
    return 0


def cmd_validate(args, config: AppConfig) -> int:
    """Quick sanity checks used by the test suite and CI."""

    checks: list[tuple[str, bool, str]] = []
    day = date(1994, 8, 11)
    daily = get_daily_panchang(day, config.location, config.calendar)
    checks.append(
        (
            "1994-08-11 aparahna tithi is Sukla Panchami",
            daily.tithi_aparahna.index == 5 and daily.tithi_aparahna.paksha == "Sukla",
            daily.tithi_aparahna.label,
        )
    )
    checks.append(
        (
            "1994-08-11 solar masa is Karka",
            daily.solar_masa.name == "Karka",
            daily.solar_masa.label,
        )
    )
    festival_day = get_daily_panchang(date(2026, 8, 17), config.location, config.calendar)
    checks.append(
        (
            "2026-08-17 is Garuda Panchami",
            any("Garuda" in festival for festival in festival_day.festivals),
            ", ".join(festival_day.festivals) or "none",
        )
    )
    amavasya = find_amavasya_days(2026, config.location, config.calendar)
    checks.append(
        (
            "2026 has 12 or 13 Amavasya tarpanam days",
            12 <= len(amavasya) <= 13,
            f"{len(amavasya)} days",
        )
    )
    ok = True
    for name, passed, detail in checks:
        print(f"{'PASS' if passed else 'FAIL'}  {name}: {detail}")
        ok = ok and passed
    return 0 if ok else 1


# ---------------------------------------------------------------------------
# parser
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--config", help="YAML site config or standalone JSON config")
    common.add_argument("--source", choices=["tree", "csv", "gramps"], help="family data source")
    common.add_argument("--csv", help="CSV path or Sheets CSV URL (with --source csv)")
    common.add_argument("--warnings", action="store_true", help="print calculation warnings")

    parser = argparse.ArgumentParser(
        prog="kula-panchang",
        description="Panchangam and family tithi engine for the Kula family tree.",
        parents=[common],
    )
    parser.add_argument("--version", action="version", version=f"kula-panchang {__version__}")
    sub = parser.add_subparsers(dest="command")

    day = sub.add_parser("day", parents=[common], help="show the panchangam for one day")
    day.add_argument("--date", type=_parse_date, help="YYYY-MM-DD (default: today)")
    day.add_argument("--json", action="store_true")
    day.set_defaults(func=cmd_day)

    month = sub.add_parser("month", parents=[common], help="show a month of panchangam")
    month.add_argument("--year", type=int)
    month.add_argument("--month", type=int)
    month.add_argument("--json", action="store_true")
    month.set_defaults(func=cmd_month)

    listing = sub.add_parser("list", parents=[common], help="list calendar events")
    listing.add_argument("--year", type=int, help="year (default: config years or current)")
    listing.add_argument("--month", type=int)
    listing.add_argument("--kind", help="comma-separated kinds, e.g. shraddha,amavasya")
    listing.add_argument("--person", help="PID or name fragment")
    listing.add_argument("--json", action="store_true")
    listing.set_defaults(func=cmd_list)

    explain = sub.add_parser("explain", parents=[common], help="explain one person's tithi")
    explain.add_argument("person", help="PID (e.g. C008) or name fragment")
    explain.add_argument("--year", type=int)
    explain.add_argument("--json", action="store_true")
    explain.set_defaults(func=cmd_explain)

    amavasya = sub.add_parser("amavasya", parents=[common], help="list Amavasya tarpanam days")
    amavasya.add_argument("--year", type=int)
    amavasya.add_argument("--json", action="store_true")
    amavasya.set_defaults(func=cmd_amavasya)

    build = sub.add_parser("build", parents=[common], help="build ICS/JSON artifacts")
    build.add_argument("--years", help="e.g. 2026 or 2026,2027 or 2026-2027")
    build.add_argument("--daily", action="store_true", help="also write full daily panchangam JSON (large)")
    build.add_argument("--members", action="store_true", help="also write per-person explanation JSON (large)")
    build.set_defaults(func=cmd_build)

    serve = sub.add_parser("serve", parents=[common], help="serve the generated feed locally")
    serve.add_argument("--build", action="store_true", help="rebuild before serving")
    serve.add_argument("--years")
    serve.add_argument("--host")
    serve.add_argument("--port", type=int)
    serve.set_defaults(func=cmd_serve)

    sync = sub.add_parser("sync-google", parents=[common], help="push events to Google Calendar")
    sync.add_argument("--years")
    sync.add_argument("--calendar", help="Google calendar id (default: primary)")
    sync.add_argument("--dry-run", action="store_true")
    sync.add_argument("--prune", action="store_true", help="delete stale kula-panchang events")
    sync.set_defaults(func=cmd_sync_google)

    validate = sub.add_parser("validate", parents=[common], help="run engine sanity checks")
    validate.set_defaults(func=cmd_validate)

    return parser


COMMANDS = {
    "day",
    "month",
    "list",
    "explain",
    "amavasya",
    "build",
    "serve",
    "sync-google",
    "validate",
}


def main(argv: list[str] | None = None) -> int:
    # Default to `day` when no subcommand is given, so both
    # `panchangam --date 2026-08-17` and `panchangam day --date ...` work.
    resolved = list(sys.argv[1:] if argv is None else argv)
    if not any(token in COMMANDS for token in resolved):
        if not any(token in {"-h", "--help", "--version"} for token in resolved):
            resolved = ["day", *resolved]

    parser = build_parser()
    args = parser.parse_args(resolved)
    try:
        config = load_config(args.config or find_config())
    except ConfigError as exc:
        print(f"Config error: {exc}", file=sys.stderr)
        return 2
    try:
        return args.func(args, config)
    except (FileNotFoundError, ValueError, RuntimeError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
