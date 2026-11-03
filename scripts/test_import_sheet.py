#!/usr/bin/env python3
"""Regression tests for the relatives-sheet importer.

The important rule under test: relationship cells are written as
"<PID>-<KNOWN_NAME>", and the PID prefix is the real key. Known names may
repeat, and the name half may be stale after a sheet edit, so resolution must
not depend on the readable suffix or on the REF_NAME column alone.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from import_sheet import build, make_ref, person_resolver, pid_prefix, union_resolver  # noqa: E402


def table(header, rows):
    return [list(header)] + [list(row) for row in rows]


def sheet_data():
    return {
        "Persons": table(
            ["PID", "KNOWN_NAME", "FULL_NAME", "REF_NAME", "GENDER", "DOB", "POB", "CUR_LOC", "STATUS", "NOTES"],
            [
                ["P001", "Alex", "Alpha One", "P001-Alex", "Male", "1 Jan 1940", "Chennai", "", "Deceased", ""],
                ["P002", "Alex", "Beta Two", "P002-Alex", "Female", "2 Feb 1942", "", "", "Deceased", ""],
                # REF_NAME deliberately blank: it must be derived from PID + KNOWN_NAME.
                ["P003", "Casey", "Casey Child", "", "Female", "3 Mar 1970",
                 "Mumbai, Maharashtra, India", "Pune, Maharashtra, India", "Living", ""],
            ],
        ),
        "Unions": table(
            ["UID", "PID1", "PID2", "REF_NAME", "REL_START", "REL_END", "NOTES"],
            [["U001", "P001-Alex", "P002-Alex", "P001-Alex & P002-Alex", "01/01/1965", "", ""]],
        ),
        "Offsprings": table(
            ["OID", "UNION_OF", "OFFSPRING", "NOTES"],
            [
                # Both halves of the readable names are stale; the PIDs still resolve.
                ["O001", "P001-Renamed & P002-Renamed", "P003-Casey", ""],
            ],
        ),
        "Vedic": table(
            ["PERSON", "GOTRA", "VEDA", "SHAKHA", "SUTRA", "NAKSHATRA", "PURVIKAM", "KULA_DEVATHA", "PARVATA"],
            [["P003-Casey", "Harita", "Yajur", "", "", "", "", "", ""]],
        ),
        "$Config": table(["GOTRA", "VEDA", "SHAKHA", "SUTRA", "NAKSHATRA"], [["Harita", "Yajur", "", "", ""]]),
    }


def authority_sheet_data():
    return {
        "Persons": table(
            ["PID", "KNOWN_NAME", "FULL_NAME", "REF_NAME", "EMAIL", "GENDER", "DOB",
             "POB", "CUR_LOC", "STATUS", "DOD", "POD", "NOTES"],
            [
                ["P001", "Sam", "Sam Iyer", "P001-Sam", "", "Male", "29 Jun 2026",
                 "Mumbai, Maharashtra, India", "", "Living", "", "", ""],
                ["P002", "Ravi", "Ravi Iyer", "P002-Ravi", "", "Male", "1 Jan 1950",
                 "Chennai", "", "Deceased", "19488.0", "", ""],
                ["P003", "Meena", "Meena Iyer", "P003-Meena", "", "Female", "", "",
                 "", "Living", "", "", ""],
            ],
        ),
    }


def authority_rows():
    return [
        {"tab": "Family", "row": 4, "name": "Sam Iyer", "dob": "29 June",
         "pob": "Bombay (?)", "status": "Deceased", "dod": "17 May 2006",
         "pod": "Chennai"},
        {"tab": "Family", "row": 5, "name": "Ravi Iyer", "dob": "", "pob": "",
         "status": "", "dod": "", "pod": "Coimbatore"},
        {"tab": "Family", "row": 6, "name": "Meena Iyer", "dob": "", "pob": "?",
         "status": "", "dod": "", "pod": ""},
    ]


class PidPrefixTests(unittest.TestCase):
    def test_pid_prefix_is_the_first_four_character_key(self):
        self.assertEqual(pid_prefix("P049-Sriram"), "P049")
        self.assertEqual(pid_prefix("  p049-anything  "), "P049")
        self.assertEqual(pid_prefix("P001-Alex & P002-Alex"), "P001")
        self.assertIsNone(pid_prefix("Sriram"))
        self.assertIsNone(pid_prefix(""))

    def test_make_ref_uses_pid_and_known_name(self):
        self.assertEqual(make_ref("P049", "Sriram"), "P049-Sriram")
        self.assertEqual(make_ref("P049", ""), "P049")


class PersonResolverTests(unittest.TestCase):
    def setUp(self):
        self.resolve = person_resolver([
            {"PID": "P001", "KNOWN_NAME": "Alex", "REF_NAME": "P001-Alex"},
            {"PID": "P002", "KNOWN_NAME": "Alex", "REF_NAME": "P002-Alex"},
            {"PID": "P003", "KNOWN_NAME": "Casey", "REF_NAME": ""},
        ])

    def test_resolves_by_pid_prefix_even_when_the_name_changed(self):
        self.assertEqual(self.resolve("P001-Renamed"), "P001")
        self.assertEqual(self.resolve("P002-Anything"), "P002")
        self.assertEqual(self.resolve("P003-Casey"), "P003")

    def test_duplicate_known_names_never_resolve_without_the_prefix(self):
        self.assertIsNone(self.resolve("Alex"))

    def test_unique_known_name_is_a_fallback_for_hand_edited_sheets(self):
        self.assertEqual(self.resolve("Casey"), "P003")


class UnionResolverTests(unittest.TestCase):
    def setUp(self):
        self.resolve = union_resolver([
            {"id": "U001", "father": "P001", "mother": "P002",
             "ref_name": "P001-Alex & P002-Alex"},
        ])

    def test_resolves_by_uid(self):
        self.assertEqual(self.resolve("U001"), "U001")
        self.assertEqual(self.resolve("u001"), "U001")

    def test_resolves_by_exact_ref_name(self):
        self.assertEqual(self.resolve("P001-Alex & P002-Alex"), "U001")

    def test_resolves_by_partner_pids_when_names_are_stale(self):
        self.assertEqual(self.resolve("P001-Renamed & P002-Renamed"), "U001")

    def test_unknown_partner_does_not_resolve(self):
        self.assertIsNone(self.resolve("P001-Alex & P999-Missing"))


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.data, self.warnings = build(sheet_data(), {"site": {"default_person": "P001"}})
        self.people = {p["id"]: p for p in self.data["people"]}
        self.families = {f["id"]: f for f in self.data["families"]}

    def test_offspring_links_resolve_from_the_union_partner_pids(self):
        self.assertEqual(self.families["U001"]["children"], ["P003"])
        self.assertEqual(self.people["P003"]["parent_family"], "U001")
        self.assertIn("U001", self.people["P001"]["families"])
        self.assertIn("U001", self.people["P002"]["families"])

    def test_graph_contains_person_and_union_nodes_and_both_edge_types(self):
        nodes = {n["id"]: n for n in self.data["graph"]["nodes"]}
        self.assertEqual(nodes["P003"]["type"], "person")
        self.assertEqual(nodes["U001"]["type"], "union")
        edge_types = {e["type"] for e in self.data["graph"]["edges"]}
        self.assertEqual(edge_types, {"partner", "offspring"})

    def test_ref_name_is_derived_when_missing(self):
        self.assertEqual(self.people["P003"]["ref_name"], "P003-Casey")
        self.assertEqual(self.data["graph"]["nodes"][[n["id"] for n in self.data["graph"]["nodes"]].index("P003")]["ref_name"],
                         "P003-Casey")

    def test_vedic_is_attached_without_a_stored_pravara(self):
        self.assertEqual(self.people["P003"]["vedic"]["gotra"], "Harita")
        self.assertNotIn("pravara", self.people["P003"]["vedic"])

    def test_living_locations_are_city_level_only(self):
        self.assertEqual(self.people["P003"]["birth"]["place"], "Mumbai")
        self.assertEqual(self.people["P003"]["current_location"], "Pune")

    def test_no_resolution_warnings_for_the_synthetic_sheet(self):
        self.assertEqual(self.warnings, [])


class AuthorityMergeTests(unittest.TestCase):
    def setUp(self):
        self.data, self.warnings = build(
            authority_sheet_data(),
            {"site": {"default_person": "P001"}, "vedic": {"charts": False}},
            authority_rows=authority_rows(),
        )
        self.people = {p["id"]: p for p in self.data["people"]}

    def test_authority_partial_date_replaces_an_erroneous_sheets_year(self):
        birth = self.people["P001"]["birth"]
        self.assertEqual(birth["date"], "29 June")
        self.assertIsNone(birth["year"])
        self.assertEqual(self.people["P001"]["attributes"]["DOB"], "29 June")

    def test_authority_place_status_dod_and_pod_are_applied(self):
        person = self.people["P001"]
        self.assertFalse(person["living"])
        self.assertEqual(person["attributes"]["STATUS"], "Deceased")
        self.assertEqual(person["birth"]["place"], "Bombay")
        self.assertEqual(person["death"]["date"], "17 May 2006")
        self.assertEqual(person["death"]["year"], 2006)
        self.assertEqual(person["death"]["place"], "Chennai")

    def test_current_dod_serial_is_shown_as_a_date(self):
        person = self.people["P002"]
        self.assertEqual(person["death"]["date"], "9 May 1953")
        self.assertEqual(person["death"]["year"], 1953)

    def test_blank_authority_cells_never_erase_current_data(self):
        person = self.people["P002"]
        self.assertEqual(person["birth"]["date"], "1 Jan 1950")
        self.assertEqual(person["birth"]["place"], "Chennai")
        # Only the non-empty POD overrides the current row here.
        self.assertEqual(person["death"]["place"], "Coimbatore")

    def test_blank_and_placeholder_values_do_not_create_data(self):
        person = self.people["P003"]
        self.assertIsNone(person["birth"])
        self.assertIsNone(person["death"])
        self.assertEqual(person["attributes"]["POB"], "")

    def test_override_report_names_the_person_and_changed_fields(self):
        report = "\n".join(self.warnings)
        self.assertIn("Authority override P001 Sam Iyer", report)
        self.assertIn("DOB '29 Jun 2026' -> '29 June'", report)
        self.assertIn("STATUS 'Living' -> 'Deceased'", report)
        self.assertIn("Authority override P002 Ravi Iyer", report)
        self.assertNotIn("did not match", report)


if __name__ == "__main__":
    unittest.main()
