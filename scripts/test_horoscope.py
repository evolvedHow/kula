#!/usr/bin/env python3
"""Tests for the jadagam (birth chart) engine.

Run with the project virtualenv so pyswisseph is available:
    .venv/bin/python -m unittest scripts.test_horoscope -v
"""

import sys
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import horoscope  # noqa: E402
from horoscope import NAKSHATRAS, RASIS, compute_chart, nakshatra_pada, parse_birth  # noqa: E402


class ParseBirthTests(unittest.TestCase):
    def test_excel_serial_date_only(self):
        display, dt, has_time = parse_birth("16827")
        self.assertEqual(dt, datetime(1946, 1, 25))
        self.assertFalse(has_time)
        self.assertEqual(display, "25 Jan 1946")

    def test_excel_serial_with_time(self):
        display, dt, has_time = parse_birth("38652.6041667")
        self.assertEqual(dt, datetime(2005, 10, 27, 14, 30))
        self.assertTrue(has_time)
        self.assertEqual(display, "27 Oct 2005, 14:30")

    def test_bare_year_is_not_a_serial(self):
        display, dt, has_time = parse_birth("1946")
        self.assertEqual(display, "1946")
        self.assertIsNone(dt)
        self.assertFalse(has_time)

    def test_fractional_number_is_always_a_serial(self):
        # A year never has decimals; 4-digit serials (pre-1927) with a time
        # fraction are still parsed.
        display, dt, has_time = parse_birth("1946.6")
        self.assertTrue(has_time)
        self.assertEqual(dt.year, 1905)

    def test_numeric_dmy_with_24h_time(self):
        display, dt, has_time = parse_birth("15/08/1950 14:30")
        self.assertEqual(dt, datetime(1950, 8, 15, 14, 30))
        self.assertTrue(has_time)

    def test_numeric_dmy_with_12h_time(self):
        _, dt, has_time = parse_birth("15-08-1950 2:30 pm")
        self.assertEqual(dt, datetime(1950, 8, 15, 14, 30))
        self.assertTrue(has_time)

    def test_named_month_with_time(self):
        _, dt, _ = parse_birth("15 Aug 1950 2:30 pm")
        self.assertEqual(dt, datetime(1950, 8, 15, 14, 30))
        _, dt, _ = parse_birth("September 3 1981 9:05 AM")
        self.assertEqual(dt, datetime(1981, 9, 3, 9, 5))

    def test_iso(self):
        _, dt, has_time = parse_birth("1950-08-15T14:30")
        self.assertEqual(dt, datetime(1950, 8, 15, 14, 30))
        self.assertTrue(has_time)

    def test_date_only_text(self):
        _, dt, has_time = parse_birth("15 Aug 1950")
        self.assertEqual(dt, datetime(1950, 8, 15))
        self.assertFalse(has_time)

    def test_unparseable_keeps_text(self):
        display, dt, has_time = parse_birth("circa 1910")
        self.assertEqual(display, "circa 1910")
        self.assertIsNone(dt)
        self.assertFalse(has_time)

    def test_empty(self):
        self.assertEqual(parse_birth(""), (None, None, False))
        self.assertEqual(parse_birth(None), (None, None, False))


@unittest.skipIf(horoscope.swe is None, "pyswisseph not installed")
class ComputeChartTests(unittest.TestCase):
    """Reference chart: 1 Jan 2000, 17:30 IST (12:00 UTC) near Valliyur."""

    @classmethod
    def setUpClass(cls):
        cls.chart = compute_chart(datetime(2000, 1, 1, 17, 30), 8.38, 77.67, "Asia/Kolkata")

    def test_sun_is_sidereal_sagittarius_on_jan_1(self):
        # Well-known anchor: the Sun enters sidereal Capricorn only at Makara
        # Sankranti (~14 Jan), so on 1 Jan it must still be in Dhanus.
        self.assertEqual(self.chart["planets"]["Su"]["rasi"], "Dhanus")

    def test_ketu_is_opposite_rahu(self):
        ra = RASIS.index(self.chart["planets"]["Ra"]["rasi"])
        ke = RASIS.index(self.chart["planets"]["Ke"]["rasi"])
        self.assertEqual(ke, (ra + 6) % 12)

    def test_all_nine_grahas_and_lagna(self):
        self.assertEqual(len(self.chart["planets"]), 9)
        self.assertIn(self.chart["lagna"], RASIS)
        self.assertIn("La", self.chart["rasis"][self.chart["lagna"]])

    def test_moon_fields(self):
        moon = self.chart["moon"]
        self.assertIn(moon["rashi"], RASIS)
        self.assertIn(moon["nakshatra"], NAKSHATRAS)
        self.assertGreaterEqual(moon["pada"], 1)
        self.assertLessEqual(moon["pada"], 4)
        self.assertEqual(moon["rashi"], self.chart["planets"]["Mo"]["rasi"])

    def test_every_graha_has_rasi_degree_nakshatra_pada(self):
        for code, p in self.chart["planets"].items():
            self.assertIn(p["rasi"], RASIS, code)
            self.assertGreaterEqual(p["deg"], 0)
            self.assertLess(p["deg"], 30)
            self.assertIn(p["nakshatra"], NAKSHATRAS, code)
            self.assertIn(p["pada"], (1, 2, 3, 4), code)

    def test_rasis_map_matches_planet_positions(self):
        for code, p in self.chart["planets"].items():
            self.assertIn(code, self.chart["rasis"][p["rasi"]], code)

    def test_nakshatra_pada_boundaries(self):
        boundary = 360.0 / 27.0  # 13°20' — one nakshatra exactly
        self.assertEqual(nakshatra_pada(0.0), ("Ashwini", 1))
        self.assertEqual(nakshatra_pada(boundary - 1e-9), ("Ashwini", 4))
        self.assertEqual(nakshatra_pada(boundary), ("Bharani", 1))
        self.assertEqual(nakshatra_pada(359.9999), ("Revati", 4))

    def test_timezone_changes_lagna(self):
        # Same instant, wrong tz must not be used silently: a 14-hour swing
        # moves the ascendant, proving tz flows into the calculation.
        day = compute_chart(datetime(2000, 1, 1, 12, 0), 8.38, 77.67, "Asia/Kolkata")
        night = compute_chart(datetime(2000, 1, 1, 23, 0), 8.38, 77.67, "Asia/Kolkata")
        self.assertNotEqual(day["lagna"], night["lagna"])


if __name__ == "__main__":
    unittest.main()
