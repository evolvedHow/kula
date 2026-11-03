#!/usr/bin/env python3
"""Tests for parsing and matching the original hierarchical family sheet."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import authority  # noqa: E402


def person(pid, full_name, dob="", pob="", status="Living"):
    birth = {"date": dob, "year": None, "place": pob} if (dob or pob) else None
    return {
        "id": pid,
        "name": {"display": full_name},
        "birth": birth,
        "death": None,
        "living": status != "Deceased",
        "attributes": {
            "FULL_NAME": full_name,
            "DOB": dob,
            "POB": pob,
            "STATUS": status,
        },
    }


class ExtractRecordsTests(unittest.TestCase):
    def test_finds_header_below_a_title_block_and_reads_columns_by_name(self):
        sheets = {
            "Family": [
                ["", "", ""],
                ["", "Our Family Tree", ""],
                ["", "Relation", "Full Name", "Date of birth", "Place of birth",
                 "Living/Deceased", "Date of death", "Place of death"],
                ["", "Son", "Alex Iyer", "1 Jan 1940", "Chennai", "Deceased",
                 "2 Feb 2000", "Chennai"],
                ["", "Stub", "Viswanathan Iyer", "", "", "", "", ""],
                ["", "Daughter", "", "", "", "", "", ""],
            ],
        }
        rows = authority.extract_records(sheets)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["name"], "Alex Iyer")
        self.assertEqual(rows[0]["relation"], "Son")
        self.assertEqual(rows[0]["dob"], "1 Jan 1940")
        self.assertEqual(rows[0]["pob"], "Chennai")
        self.assertEqual(rows[0]["status"], "Deceased")
        self.assertEqual(rows[0]["dod"], "2 Feb 2000")
        self.assertEqual(rows[0]["pod"], "Chennai")
        self.assertEqual(rows[0]["row"], 4)

    def test_tabs_can_be_limited_and_unknown_tabs_are_skipped(self):
        header = ["Relation", "Full Name", "Date of birth", "Place of birth",
                  "Living/Deceased", "Date of death", "Place of death"]
        sheets = {
            "Family": [header, ["", "Alex Iyer", "1 Jan 1940", "", "", "", ""]],
            "Notes": [["Something else"], ["not a person"]],
        }
        self.assertEqual(len(authority.extract_records(sheets)), 1)
        self.assertEqual(len(authority.extract_records(sheets, {"tabs": ["Family"]})), 1)
        self.assertEqual(authority.extract_records(sheets, {"tabs": ["Notes"]}), [])

    def test_custom_column_aliases(self):
        sheets = {
            "Family": [
                ["Person", "Born on", "Born at", "Alive?", "Died on", "Died at"],
                ["Alex Iyer", "1 Jan 1940", "Chennai", "No", "2 Feb 2000", "Chennai"],
            ],
        }
        rows = authority.extract_records(sheets, {"columns": {
            "name": "Person", "dob": "Born on", "pob": "Born at",
            "status": "Alive?", "dod": "Died on", "pod": "Died at",
        }})
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["name"], "Alex Iyer")
        self.assertEqual(rows[0]["status"], "No")


class CleanValueTests(unittest.TestCase):
    def test_places_drop_unknown_and_uncertainty_markers(self):
        self.assertEqual(authority.clean_place("Bombay (?)"), "Bombay")
        self.assertEqual(authority.clean_place("?"), "")
        self.assertEqual(authority.clean_place(" unknown "), "")
        self.assertEqual(authority.clean_place("Chennai"), "Chennai")
        self.assertEqual(authority.clean_place("Davis, CA"), "Davis, CA")

    def test_status_accepts_the_sheets_wording(self):
        self.assertEqual(authority.clean_status("Deceased"), "Deceased")
        self.assertEqual(authority.clean_status("Living"), "Living")
        self.assertEqual(authority.clean_status("dead"), "Deceased")
        self.assertEqual(authority.clean_status(""), "")

    def test_day_month_handles_partial_and_custom_formats(self):
        self.assertEqual(authority.day_month("29 June"), (29, 6))
        self.assertEqual(authority.day_month("14 Oct"), (14, 10))
        self.assertEqual(authority.day_month("Jan/1/1895 00:00:"), (1, 1))
        self.assertEqual(authority.day_month("19488.0"), (9, 5))
        self.assertIsNone(authority.day_month(""))
        self.assertIsNone(authority.day_month("circa 1910"))


class MatchRecordsTests(unittest.TestCase):
    def test_fuzzy_spelling_match(self):
        records = [{"name": "Viswanathan Iyer", "dob": "", "pob": "", "status": ""}]
        people = [person("P001", "Viswanatha Iyer", status="Deceased")]
        matches, unmatched = authority.match_records(records, people)
        self.assertEqual(unmatched, [])
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["pid"], "P001")
        self.assertGreaterEqual(matches[0]["name_score"], 0.86)

    def test_duplicate_names_are_broken_by_birth_date_and_place(self):
        records = [
            {"name": "Venkatesh", "dob": "29 June", "pob": "Dindigul", "status": "Living"},
            {"name": "Venkatesh", "dob": "", "pob": "", "status": "Living"},
        ]
        people = [
            person("P027", "Venkatesh", dob="29 Jun 2026", pob="Dindigul"),
            person("P042", "Venkatesh"),
        ]
        matches, unmatched = authority.match_records(records, people)
        self.assertEqual(unmatched, [])
        by_pid = {match["pid"]: match["record"] for match in matches}
        self.assertEqual(by_pid["P027"]["dob"], "29 June")
        self.assertEqual(by_pid["P042"]["dob"], "")

    def test_unmatched_rows_are_reported_instead_of_guessed(self):
        records = [{"name": "Completely Different", "dob": "", "pob": "", "status": ""}]
        people = [person("P001", "Viswanatha Iyer")]
        matches, unmatched = authority.match_records(records, people)
        self.assertEqual(matches, [])
        self.assertEqual(len(unmatched), 1)


if __name__ == "__main__":
    unittest.main()
