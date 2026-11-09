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

from import_sheet import (  # noqa: E402
    build,
    inherit_vedic,
    make_ref,
    person_resolver,
    pid_prefix,
    split_name,
    validate_person_dates,
)


def table(header, rows):
    return [list(header)] + [list(row) for row in rows]


def sheet_data():
    return {
        "Persons": table(
            ["PID", "KNOWN_NAME", "FULL_NAME", "REF_NAME", "GENDER", "DOB", "POB", "STATUS", "NOTES"],
            [
                ["P001", "Alex", "Alpha One", "P001-Alex", "Male", "1 Jan 1940", "Chennai", "Deceased", ""],
                ["P002", "Alex", "Beta Two", "P002-Alex", "Female", "2 Feb 1942", "", "Deceased", ""],
                # REF_NAME deliberately blank: it must be derived from PID + KNOWN_NAME.
                ["P003", "Casey", "Casey Child", "", "Female", "3 Mar 1970",
                 "Mumbai, Maharashtra, India", "Living", ""],
            ],
        ),
        "KG": table(
            ["SUBJECT", "PREDICATE", "OBJECT", "DATE", "NOTES"],
            [
                ["P001-Alex", "spouseOf", "P002-Alex", "", ""],
                ["P001-Alex", "parentOf", "P003-Casey", "", ""],
            ],
        ),
        "Vedic": table(
            ["PERSON", "GOTRA", "VEDA", "SHAKHA", "SUTRA", "PURVIKAM", "KULA_DEVATHA", "PARVATA"],
            [["P003-Casey", "Harita", "Yajur", "", "", "", "", ""]],
        ),
        "$Config": table(["GOTRA", "VEDA", "SHAKHA", "SUTRA"], [["Harita", "Yajur", "", ""]]),
    }


def authority_sheet_data():
    return {
        "Persons": table(
            ["PID", "KNOWN_NAME", "FULL_NAME", "REF_NAME", "EMAIL", "GENDER", "DOB",
             "POB", "STATUS", "DOD", "NOTES"],
            [
                ["P001", "Sam", "Sam Iyer", "P001-Sam", "", "Male", "29 Jun 2026",
                 "Mumbai, Maharashtra, India", "Living", "", ""],
                ["P002", "Ravi", "Ravi Iyer", "P002-Ravi", "", "Male", "1 Jan 1950",
                 "Chennai", "Deceased", "19488.0", ""],
                ["P003", "Meena", "Meena Iyer", "P003-Meena", "", "Female", "", "",
                 "Living", "", ""],
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

    def test_generation_letter_pids_are_recognised(self):
        self.assertEqual(pid_prefix("A001-Venkiteswara Iyer"), "A001")
        self.assertEqual(pid_prefix("z031-Thejaswini"), "Z031")
        self.assertEqual(pid_prefix("D008-Suresh"), "D008")

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

    def test_resolves_a_bare_generation_letter_pid(self):
        resolve = person_resolver([
            {"PID": "A001", "KNOWN_NAME": "Venkiteswara",
             "REF_NAME": "A001-Venkiteswara"},
            {"PID": "z031", "KNOWN_NAME": "Thejaswini",
             "REF_NAME": "z031-Thejaswini"},
        ])
        self.assertEqual(resolve("A001"), "A001")
        self.assertEqual(resolve("z031"), "Z031")

    def test_duplicate_known_names_never_resolve_without_the_prefix(self):
        self.assertIsNone(self.resolve("Alex"))

    def test_unique_known_name_is_a_fallback_for_hand_edited_sheets(self):
        self.assertEqual(self.resolve("Casey"), "P003")


class NameSplittingTests(unittest.TestCase):
    def test_last_word_becomes_surname(self):
        self.assertEqual(split_name("Venkiteswara Iyer"),
                         ("Venkiteswara", "Iyer", ""))

    def test_single_name_has_no_surname(self):
        self.assertEqual(split_name("Rajammal"), ("Rajammal", "", ""))
        self.assertEqual(split_name(""), ("", "", ""))

    def test_parenthetical_suffix_is_a_nickname(self):
        given, surname, nickname = split_name(
            "Rajalakshmi Krishnamurthy ( Rajam )")
        self.assertEqual(given, "Rajalakshmi")
        self.assertEqual(surname, "Krishnamurthy")
        self.assertEqual(nickname, "Rajam")

    def test_nickname_is_added_to_alternates(self):
        data, _ = build(
            {
                "Persons": table(
                    ["PID", "KNOWN_NAME", "FULL_NAME", "REF_NAME", "GENDER",
                     "DOB", "POB", "STATUS", "NOTES"],
                    [["P001", "Raji", "Rajalakshmi Krishnamurthy (Rajam)",
                      "P001-Rajalakshmi", "Female", "", "", "Living", ""]],
                ),
                "KG": table(
                    ["SUBJECT", "PREDICATE", "OBJECT", "DATE", "NOTES"],
                    [],
                ),
                "Vedic": table(["PERSON"], []),
                "$Config": table(["GOTRA"], []),
            },
            {"site": {"default_person": "P001"}, "vedic": {"charts": False}},
        )
        person = data["people"][0]
        self.assertEqual(person["name"]["surname"], "Krishnamurthy")
        self.assertEqual(person["name"]["alternates"], ["Raji", "Rajam"])


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.data, self.warnings = build(sheet_data(), {"site": {"default_person": "P001"}})
        self.people = {p["id"]: p for p in self.data["people"]}
        self.families = {f["id"]: f for f in self.data["families"]}

    def test_kg_edges_build_the_union_and_its_children(self):
        self.assertEqual(self.families["U001"]["father"], "P001")
        self.assertEqual(self.families["U001"]["mother"], "P002")
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

    def test_no_resolution_warnings_for_the_synthetic_sheet(self):
        self.assertEqual(self.warnings, [])

    def test_generation_falls_back_to_the_generation_column(self):
        sheets = {
            "Persons": table(
                ["PID", "KNOWN_NAME", "FULL_NAME", "REF_NAME", "GENDER", "DOB",
                 "POB", "STATUS", "NOTES", "GEN", "GENERATION"],
                [
                    ["P020", "Gen", "Gen Person", "P020-Gen", "Male", "",
                     "", "Living", "", "", "d"],
                    ["P021", "Blank", "Blank Gen", "P021-Blank", "Female", "",
                     "", "Living", "", "B", ""],
                ],
            ),
            "KG": table(["SUBJECT", "PREDICATE", "OBJECT", "DATE", "NOTES"], []),
            "Vedic": table(["PERSON"], []),
            "$Config": table(["GOTRA"], []),
        }
        data, _ = build(sheets, {"site": {"default_person": "P020"},
                                 "vedic": {"charts": False}})
        people = {p["id"]: p for p in data["people"]}
        self.assertEqual(people["P020"]["generation"], "D",
                         "GENERATION is used when GEN is blank")
        self.assertEqual(people["P021"]["generation"], "B",
                         "GEN still wins when both columns are filled")

    def test_a_self_reference_is_ignored_with_a_warning(self):
        sheets = {
            "Persons": table(
                ["PID", "KNOWN_NAME", "FULL_NAME", "REF_NAME", "GENDER", "DOB",
                 "POB", "STATUS", "NOTES"],
                [["P030", "Solo", "Solo Person", "P030-Solo", "Male", "",
                  "", "Living", ""]],
            ),
            "KG": table(
                ["SUBJECT", "PREDICATE", "OBJECT", "DATE", "NOTES"],
                [["P030-Solo", "spouseOf", "P030-Solo", "", ""]],
            ),
            "Vedic": table(["PERSON"], []),
            "$Config": table(["GOTRA"], []),
        }
        data, warnings = build(sheets, {"site": {"default_person": "P030"},
                                        "vedic": {"charts": False}})
        self.assertEqual(data["families"], [],
                         "a self-reference must not create a union")
        self.assertTrue(any("self-reference" in w for w in warnings),
                        "the typo should be reported as a warning")

    def test_a_single_parent_family_uses_the_persons_gender(self):
        sheets = {
            "Persons": table(
                ["PID", "KNOWN_NAME", "FULL_NAME", "REF_NAME", "GENDER", "DOB",
                 "POB", "STATUS", "NOTES"],
                [
                    ["P010", "Kala", "Kala Iyer", "P010-Kala", "Female", "", "", "Living", ""],
                    ["P011", "Child", "Child Iyer", "P011-Child", "Male", "", "", "Living", ""],
                ],
            ),
            "KG": table(
                ["SUBJECT", "PREDICATE", "OBJECT", "DATE", "NOTES"],
                [["P010-Kala", "parentOf", "P011-Child", "", ""]],
            ),
            "Vedic": table(["PERSON"], []),
            "$Config": table(["GOTRA"], []),
        }
        data, _ = build(sheets, {"site": {"default_person": "P010"},
                                 "vedic": {"charts": False}})
        family = data["families"][0]
        self.assertIsNone(family["father"])
        self.assertEqual(family["mother"], "P010")
        self.assertEqual(family["children"], ["P011"])


class KgBuildTests(unittest.TestCase):
    def kg_sheets(self, kg_rows):
        return {
            "Persons": table(
                ["PID", "KNOWN_NAME", "FULL_NAME", "REF_NAME", "GENDER", "DOB", "POB", "STATUS", "NOTES"],
                [
                    ["P-101", "Himavan", "King Himavan", "P-101-Himavan", "Male", "", "", "Living", ""],
                    ["P-102", "Mena", "Queen Menavati", "P-102-Mena", "Female", "", "", "Living", ""],
                    ["P-201", "Shiva", "Lord Shiva", "P-201-Shiva", "Male", "", "", "Living", ""],
                    ["P-202", "Parvati", "Goddess Parvati", "P-202-Parvati", "Female", "", "", "Living", ""],
                    ["P-301", "Murugan", "Lord Murugan", "P-301-Murugan", "Male", "", "", "Living", ""],
                ],
            ),
            "KG": table(
                ["SUBJECT", "PREDICATE", "OBJECT", "DATE", "NOTES"],
                kg_rows,
            ),
            "Vedic": table(["PERSON"], []),
            "$Config": table(["GOTRA"], []),
        }

    def test_kg_spouse_and_parent_edges_create_family(self):
        sheets = self.kg_sheets([
            ["P-101-Himavan", "spouseOf", "P-102-Mena", "", ""],
            ["P-101-Himavan", "parentOf", "P-202-Parvati", "", ""],
        ])
        data, warnings = build(sheets, {"site": {"default_person": "P-101"},
                                        "vedic": {"charts": False}})
        self.assertEqual(len(data["families"]), 1)
        fam = data["families"][0]
        self.assertEqual(fam["father"], "P-101")
        self.assertEqual(fam["mother"], "P-102")
        self.assertEqual(fam["children"], ["P-202"])
        parvati = next(p for p in data["people"] if p["id"] == "P-202")
        self.assertEqual(parvati["parent_family"], fam["id"])
        edge_types = {e["type"] for e in data["graph"]["edges"]}
        self.assertEqual(edge_types, {"partner", "offspring"})

    def test_kg_child_of_is_reversed_to_parent(self):
        sheets = self.kg_sheets([
            ["P-202-Parvati", "childOf", "P-101-Himavan", "", ""],
        ])
        data, _ = build(sheets, {"site": {"default_person": "P-101"},
                                 "vedic": {"charts": False}})
        self.assertEqual(len(data["families"]), 1)
        self.assertEqual(data["families"][0]["children"], ["P-202"])

    def test_kg_infer_co_parenting_through_spouses(self):
        sheets = self.kg_sheets([
            ["P-101-Himavan", "spouseOf", "P-102-Mena", "", ""],
            ["P-101-Himavan", "parentOf", "P-202-Parvati", "", ""],
        ])
        data, _ = build(sheets, {"site": {"default_person": "P-101"},
                                 "vedic": {"charts": False}})
        fam = data["families"][0]
        self.assertIn("P-202", fam["children"])
        # Both spouses should list the same family.
        for pid in ("P-101", "P-102"):
            person = next(p for p in data["people"] if p["id"] == pid)
            self.assertIn(fam["id"], person["families"])

    def test_lowercase_pids_are_normalised(self):
        # The live sheet mixes z031 with Z031 references. Resolution is
        # case-insensitive, so the person record must use the same upper-case
        # id or the graph points at a person that does not exist.
        sheets = self.kg_sheets([
            ["z031-Thejaswini", "childOf", "z027-Renganathan", "", ""],
        ])
        sheets["Persons"] = table(
            ["PID", "KNOWN_NAME", "FULL_NAME", "REF_NAME", "GENDER", "DOB",
             "POB", "STATUS", "NOTES"],
            [
                ["z027", "Renganathan", "Renganathan", "z027-Renganathan",
                 "Male", "", "", "Living", ""],
                ["z031", "Thejaswini", "Thejaswini", "z031-Thejaswini",
                 "Female", "", "", "Living", ""],
            ],
        )
        data, _ = build(sheets, {"site": {"default_person": "z027"},
                                 "vedic": {"charts": False}})
        people = {p["id"]: p for p in data["people"]}
        self.assertIn("Z031", people)
        self.assertEqual(people["Z031"]["parent_family"],
                         data["families"][0]["id"])
        self.assertEqual(data["families"][0]["children"], ["Z031"])

    def test_union_ids_do_not_collide_with_person_pids(self):
        # The sheet uses generation-letter PIDs, so a family id such as F001
        # would shadow the person F001 in the graph.
        sheets = self.kg_sheets([
            ["F001-Himavan", "spouseOf", "F002-Mena", "", ""],
        ])
        sheets["Persons"] = table(
            ["PID", "KNOWN_NAME", "FULL_NAME", "REF_NAME", "GENDER", "DOB",
             "POB", "STATUS", "NOTES"],
            [
                ["F001", "Himavan", "Himavan", "F001-Himavan", "Male",
                 "", "", "Living", ""],
                ["F002", "Mena", "Mena", "F002-Mena", "Female",
                 "", "", "Living", ""],
            ],
        )
        data, _ = build(sheets, {"site": {"default_person": "F001"},
                                 "vedic": {"charts": False}})
        node_ids = [n["id"] for n in data["graph"]["nodes"]]
        self.assertEqual(len(node_ids), len(set(node_ids)),
                         "person and union node ids must be unique")
        self.assertEqual([f["id"] for f in data["families"]], ["U001"])

    def test_legacy_union_tabs_are_ignored(self):
        sheets = self.kg_sheets([
            ["P-201-Shiva", "spouseOf", "P-202-Parvati", "", ""],
        ])
        sheets["Unions"] = table(
            ["UID", "PID1", "PID2", "REF_NAME", "REL_START", "REL_END", "NOTES"],
            [["U001", "P-101", "P-102", "", "", "", ""]],
        )
        sheets["Offsprings"] = table(
            ["OID", "UNION_OF", "OFFSPRING", "NOTES"],
            [["O001", "U001", "P-202", ""]],
        )
        data, _ = build(sheets, {"site": {"default_person": "P-201"},
                                 "vedic": {"charts": False}})
        self.assertEqual(len(data["families"]), 1)
        family = data["families"][0]
        self.assertEqual(family["father"], "P-201")
        self.assertEqual(family["mother"], "P-202")
        # The legacy tab named P-101/P-102 and a different union; neither may
        # leak into the KG-derived family.
        partners = {family["father"], family["mother"]}
        self.assertNotIn("P-101", partners)
        self.assertNotIn("P-102", partners)


class VedicInheritanceTests(unittest.TestCase):
    def people(self):
        return [
            {"id": "H", "gender": "M", "parent_family": None,
             "vedic": {"gotra": "Harita", "veda": "Yajur", "nakshatra": "Rohini"}},
            {"id": "W", "gender": "F", "parent_family": None,
             "vedic": {"gotra": "Bharadwaja", "nakshatra": "Ashlesha"}},
            {"id": "C", "gender": "M", "parent_family": "U1", "vedic": {}},
        ]

    def run_inherit(self, people):
        by_id = {p["id"]: p for p in people}
        families = {"U1": {"id": "U1", "father": "H", "mother": "W", "children": ["C"]}}
        inherit_vedic(people, by_id, families)
        return by_id

    def test_wife_takes_her_husbands_lineage_but_keeps_her_own_nakshatra(self):
        people = self.run_inherit(self.people())
        self.assertEqual(people["W"]["vedic"]["gotra"], "Harita")
        self.assertEqual(people["W"]["vedic"]["veda"], "Yajur")
        self.assertEqual(people["W"]["vedic"]["nakshatra"], "Ashlesha")

    def test_child_inherits_lineage_but_not_nakshatra(self):
        people = self.run_inherit(self.people())
        self.assertEqual(people["C"]["vedic"]["gotra"], "Harita")
        self.assertEqual(people["C"]["vedic"]["veda"], "Yajur")
        self.assertNotIn("nakshatra", people["C"]["vedic"])

    def test_a_wife_keeps_her_own_lineage_when_the_husband_has_none(self):
        people = [
            {"id": "H", "gender": "M", "parent_family": None, "vedic": {}},
            {"id": "W", "gender": "F", "parent_family": None,
             "vedic": {"gotra": "Bharadwaja", "nakshatra": "Ashlesha"}},
        ]
        people = self.run_inherit(people)
        self.assertEqual(people["W"]["vedic"]["gotra"], "Bharadwaja")
        self.assertEqual(people["W"]["vedic"]["nakshatra"], "Ashlesha")


class DateValidationTests(unittest.TestCase):
    def person(self, dob, dod, status="Deceased", yrs=""):
        return {
            "id": "P100",
            "living": status == "Living",
            "attributes": {"DOB": dob, "DOD": dod, "STATUS": status, "YRS": yrs, "POD": ""},
        }

    def test_identical_birth_and_death_dates_are_flagged(self):
        warnings = validate_person_dates(self.person("28 May 1997", "28 May 1997", yrs="29"))
        self.assertTrue(any("same day" in w for w in warnings))

    def test_stale_yrs_for_a_deceased_person_is_flagged(self):
        warnings = validate_person_dates(self.person("10 Aug 1985", "17 May 2006", yrs="41"))
        self.assertTrue(any("does not match" in w for w in warnings))

    def test_matching_yrs_is_not_flagged(self):
        warnings = validate_person_dates(self.person("10 Aug 1985", "17 May 2006", yrs="20"))
        self.assertFalse(any("does not match" in w for w in warnings))


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
