#!/usr/bin/env python3
"""Tests for the panchangam and family tithi engine.

Run with the project virtualenv so pyswisseph is available:

    .venv/bin/python -m unittest scripts.test_panchang -v
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

from icalendar import Calendar

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.panchang.config import load_config  # noqa: E402
from scripts.panchang.engine import (  # noqa: E402
    find_amavasya_days,
    get_daily_panchang,
)
from scripts.panchang.ics import write_ics  # noqa: E402
from scripts.panchang.matcher import build_events, explain_member  # noqa: E402
from scripts.panchang.sources import load_family, parse_date_time  # noqa: E402


class AstronomyTests(unittest.TestCase):
    """The core sidereal calculations, checked against known family dates."""

    @classmethod
    def setUpClass(cls):
        cls.config = load_config()

    def test_1994_death_panchangam(self):
        # Lakshmi Ganapathy (C008) died on 11 Aug 1994.  The sunrise tithi is
        # Chaturthi, but the ritual aparahna tithi is Panchami, in solar
        # Karka (Aadi) and lunar Shravana.
        day = get_daily_panchang(
            date(1994, 8, 11), self.config.location, self.config.calendar
        )
        self.assertEqual(day.tithi_sunrise.paksha, "Sukla")
        self.assertEqual(day.tithi_sunrise.index, 4)
        self.assertEqual(day.tithi_aparahna.index, 5)
        self.assertEqual(day.tithi_aparahna.label, "Sukla Panchami")
        self.assertEqual(day.solar_masa.name, "Karka")
        self.assertEqual(day.lunar_masa_amanta.name, "Shravana")

    def test_garuda_panchami_2026(self):
        day = get_daily_panchang(
            date(2026, 8, 17), self.config.location, self.config.calendar
        )
        self.assertEqual(day.tithi_aparahna.label, "Sukla Panchami")
        self.assertEqual(day.solar_masa.name, "Karka")
        self.assertEqual(day.lunar_masa_amanta.name, "Shravana")
        self.assertIn(day.sunrise.hour, {5, 6})
        self.assertTrue(any("Garuda" in name for name in day.festivals))

    def test_amavasya_days_2026(self):
        days = find_amavasya_days(2026, self.config.location, self.config.calendar)
        self.assertEqual(len(days), 12)
        self.assertEqual(days, sorted(days, key=lambda d: d.day))
        self.assertEqual(len({d.day for d in days}), 12)
        self.assertIn(date(2026, 11, 8), [d.day for d in days])
        for day in days:
            self.assertTrue(
                day.flags.get("aparahna_amavasya") or day.is_amavasya,
                f"{day.day} is not an Amavasya day",
            )


class FamilyMatchingTests(unittest.TestCase):
    """End-to-end resolution of a person in docs/data/tree.json."""

    @classmethod
    def setUpClass(cls):
        cls.config = load_config()
        cls.family = load_family(cls.config)
        cls.events, cls.warnings = build_events(cls.config, cls.family, [2026])
        cls.c008 = next(m for m in cls.family.members if m.pid == "C008")

    def test_tree_loads_people(self):
        self.assertGreater(len(self.family.members), 100)
        self.assertEqual(self.family.source, "tree")

    def test_c008_shraddha_is_garuda_panchami(self):
        # Two Karka Sukla Panchami days occur in 2026 (18 Jul in Ashadha and
        # 17 Aug in Shravana).  The lunar month of the original death must
        # pick 17 Aug, which is also Garuda Panchami.
        result = explain_member(self.config, self.c008, 2026)
        shraddha = [e for e in result["events"] if e["kind"] == "shraddha"]
        self.assertEqual(len(shraddha), 1)
        self.assertEqual(shraddha[0]["date"], "2026-08-17")
        self.assertTrue(
            any("Garuda" in name for name in result["festivals_on_event_dates"])
        )

    def test_event_uids_are_unique_and_stable(self):
        uids = [event.uid for event in self.events]
        self.assertEqual(len(uids), len(set(uids)))
        again, _ = build_events(self.config, self.family, [2026])
        self.assertEqual(uids, [event.uid for event in again])

    def test_ics_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write_ics(
                Path(tmp) / "panchang.ics",
                self.events,
                self.config.calendar,
                name=self.config.calendar.name,
                description=self.config.calendar.description,
                timezone_name=self.config.location.timezone,
            )
            calendar = Calendar.from_ical(path.read_bytes())
        vevents = calendar.walk("VEVENT")
        self.assertEqual(len(vevents), len(self.events))
        self.assertEqual(len(calendar.walk("VTIMEZONE")), 1)
        for vevent in vevents:
            self.assertIsNotNone(vevent.get("UID"))
            self.assertIsNotNone(vevent.get("DTSTART"))
        # Family events carry the private Kula metadata extensions.
        self.assertTrue(any(vevent.get("X-KULA-KIND") for vevent in vevents))


class SourceParsingTests(unittest.TestCase):
    def test_sheet_dates(self):
        parsed, clock, has_time = parse_date_time("11 Aug 1994")
        self.assertEqual(parsed, date(1994, 8, 11))
        self.assertIsNone(clock)
        self.assertFalse(has_time)

        parsed, clock, has_time = parse_date_time("25 Jun 1910, 22:37")
        self.assertEqual(parsed, date(1910, 6, 25))
        self.assertEqual((clock.hour, clock.minute), (22, 37))
        self.assertTrue(has_time)

        parsed, _, _ = parse_date_time("Jan-1/1895 0:0")
        self.assertEqual(parsed, date(1895, 1, 1))

    def test_excel_serial(self):
        parsed, _, _ = parse_date_time("16827")
        self.assertEqual(parsed, date(1946, 1, 25))


class ConfigTests(unittest.TestCase):
    def test_site_config(self):
        config = load_config()
        self.assertEqual(config.location.name, "Chennai")
        self.assertEqual(config.calendar.masa_system, "solar")
        self.assertTrue(config.calendar.include.shraddha)
        self.assertEqual(config.feed_name, "panchang.ics")


if __name__ == "__main__":
    unittest.main()
