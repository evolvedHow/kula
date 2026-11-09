#!/usr/bin/env python3
"""Convert a GEDCOM 5.5.1 file into the tree.json model used by the Kula UI.

This replaces the old Google-Sheet importer. The expected workflow is:

1. Enter or export data in the kula-data Google Sheet.
2. Use the kula-data Apps Script to export a GEDCOM 5.5.1 file to Drive.
3. Place/download that .ged file into docs/data/trees/<tree>/tree.ged.
4. Run this script to regenerate docs/data/trees/<tree>/tree.json.

The script preserves custom Kula attributes written by the Apps Script exporter
(_PID, _GOTRA, _VEDA, _SHAKHA, _SUTRA, _NAKSHATRA, _KULA_DEVATHA,
_SAMPRADAYA, _PURVIKAM, _EMAIL). When _PID is present it is used as the
person id, so round-tripping through GEDCOM keeps the same IDs.
"""

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Re-use the horoscope/geocode helpers for parity with the old importer.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import geocode  # noqa: E402
import horoscope  # noqa: E402

try:
    import yaml
except ImportError:  # pragma: no cover - optional dependency
    yaml = None


MONTHS = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}

VEDIC_TAGS = {
    "_GOTRA": "gotra",
    "_VEDA": "veda",
    "_SHAKHA": "shakha",
    "_SUTRA": "sutra",
    "_NAKSHATRA": "nakshatra",
    "_KULA_DEVATHA": "kula_devatha",
    "_SAMPRADAYA": "sampradaya",
    "_PURVIKAM": "purvikam",
}


def parse_gedcom(path: Path) -> list[dict[str, Any]]:
    """Parse a GEDCOM file into a list of top-level record nodes.

    Each node is a dict with keys: level, xref, tag, value, children.
    Continuation lines (CONT/CONC) are left as child nodes for the caller to
    merge, because they can appear under NAME, NOTE, and other tags.
    """
    text = path.read_text(encoding="utf-8-sig")
    records: list[dict[str, Any]] = []
    stack: list[dict[str, Any]] = []
    for raw in text.splitlines():
        if not raw.strip():
            continue
        # Level, optional xref, tag, and the remainder as value.
        match = re.match(r"^(\d+)\s+(@\w+@)?\s*(\S+)\s*(.*)$", raw)
        if not match:
            continue
        level = int(match.group(1))
        xref = match.group(2).strip("@") if match.group(2) else None
        tag = match.group(3)
        value = match.group(4).strip()
        node = {"level": level, "xref": xref, "tag": tag, "value": value, "children": []}
        while stack and stack[-1]["level"] >= level:
            stack.pop()
        if stack:
            stack[-1]["children"].append(node)
        else:
            records.append(node)
        stack.append(node)
    return records


def merge_note(node: dict[str, Any], notes_by_xref: dict[str, str]) -> str:
    """Return the full text of a NOTE node, resolving an xref if needed."""
    value = node["value"]
    if value.startswith("@") and value.endswith("@"):
        return notes_by_xref.get(value.strip("@"), "")
    parts = [value]
    for child in node["children"]:
        if child["tag"] == "CONC":
            parts.append(child["value"])
        elif child["tag"] == "CONT":
            parts.append("\n" + child["value"])
    return "".join(parts)


def parse_name(name_value: str) -> tuple[str, str, str, str]:
    """Parse a GEDCOM NAME line into (display, given, surname, nickname).

    Names are written as ``Given /Surname/``. A trailing parenthetical is
    treated as a nickname.
    """
    text = name_value.strip()
    nickname = ""
    m = re.search(r"\s*\(([^)]*)\)\s*$", text)
    if m:
        nickname = m.group(1).strip()
        text = text[: m.start()].strip()
    match = re.match(r"^(.+?)\s*/([^/]*)/\s*$", text)
    if match:
        given = match.group(1).strip()
        surname = match.group(2).strip()
        display = f"{given} {surname}".strip() if surname else given
        return display, given, surname, nickname
    words = text.split()
    if len(words) < 2:
        return text, text, "", nickname
    display = text
    given = " ".join(words[:-1])
    surname = words[-1]
    return display, given, surname, nickname


def parse_gedcom_date(value: str) -> tuple[str, int | None]:
    """Convert a GEDCOM date string into (display, year).

    Handles ``1 JAN 1895``, ``JAN 1895``, ``1895``, and approximate/phrase
    forms. Phrases are kept as-is with no year.
    """
    value = (value or "").strip()
    if not value:
        return "", None
    # Strip GEDCOM prefixes like ABT, BEF, AFT.
    core = re.sub(r"^(ABT|BEF|AFT|BET|AND|FROM|TO|INT|EST|CAL)\s+", "", value, flags=re.I)
    # "1 JAN 1895"
    m = re.match(r"^(\d{1,2})\s+([A-Z]{3})\s+(\d{4})$", core, re.I)
    if m:
        day, mon, year = m.groups()
        month_num = MONTHS.get(mon.upper())
        if month_num:
            return f"{int(day)} {mon.upper()} {year}", int(year)
    # "JAN 1895"
    m = re.match(r"^([A-Z]{3})\s+(\d{4})$", core, re.I)
    if m:
        return f"{m.group(1).upper()} {m.group(2)}", int(m.group(2))
    # "1895"
    m = re.match(r"^(\d{4})$", core)
    if m:
        return m.group(1), int(m.group(1))
    return value, None


def extract_event(node: dict[str, Any]) -> dict[str, str]:
    """Pull DATE, TIME and PLAC out of a BIRT/DEAT/MARR event node."""
    event: dict[str, str] = {"date": "", "place": ""}
    time_value = ""
    for child in node["children"]:
        if child["tag"] == "DATE":
            event["date"] = child["value"]
        elif child["tag"] == "TIME":
            time_value = child["value"]
        elif child["tag"] == "PLAC":
            event["place"] = child["value"]
    if event["date"] and time_value:
        event["date"] = f"{event['date']}, {time_value}"
    return event


def city_only(value: str) -> str:
    """Reduce a place string to city level for privacy."""
    text = (value or "").strip()
    if not text:
        return ""
    text = text.split(",")[0].strip()
    text = re.split(r"\s+[–-]\s+", text)[0].strip()
    return text


def load_config(path: Path) -> dict[str, Any]:
    """Load the site config, or an empty dict if yaml is unavailable."""
    if yaml is None or not path.exists():
        return {}
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def build_people(records: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, str], dict[str, str]]:
    """Build person objects, a note lookup, and an xref-to-id map.

    Returns ``(people_by_id, notes_by_xref, xref_to_id)``.
    """
    notes_by_xref: dict[str, str] = {}
    for rec in records:
        if rec["tag"] == "NOTE" and rec["xref"]:
            notes_by_xref[rec["xref"]] = merge_note(rec, notes_by_xref)

    xref_to_id: dict[str, str] = {}
    people_by_id: dict[str, Any] = {}

    # First pass: determine IDs from _PID attributes.
    for rec in records:
        if rec["tag"] != "INDI":
            continue
        xref = rec["xref"]
        pid = None
        for child in rec["children"]:
            if child["tag"] == "_PID":
                pid = child["value"].strip().upper()
                break
        if not pid:
            pid = (xref or "X").upper()
        xref_to_id[xref] = pid

    for rec in records:
        if rec["tag"] != "INDI":
            continue
        xref = rec["xref"]
        pid = xref_to_id[xref]

        display = ""
        given = ""
        surname = ""
        nickname = ""
        sex = ""
        birth_event: dict[str, str] | None = None
        death_event: dict[str, str] | None = None
        attrs: dict[str, str] = {"PID": pid, "REF_NAME": pid}
        notes: list[str] = []
        stories: list[str] = []
        famc: list[str] = []
        fams: list[str] = []

        for child in rec["children"]:
            tag = child["tag"]
            if tag == "NAME":
                display, given, surname, nickname = parse_name(child["value"])
                for cc in child["children"]:
                    if cc["tag"] == "GIVN":
                        given = cc["value"]
                    elif cc["tag"] == "SURN":
                        surname = cc["value"]
                    elif cc["tag"] == "NICK":
                        nickname = cc["value"]
            elif tag == "SEX":
                sex = child["value"].strip().upper()
            elif tag == "BIRT":
                birth_event = extract_event(child)
            elif tag == "DEAT":
                death_event = extract_event(child)
            elif tag == "NOTE":
                note_text = merge_note(child, notes_by_xref).strip()
                if note_text:
                    notes.append(note_text)
            elif tag == "FAMC":
                famc.append(child["value"].strip("@"))
            elif tag == "FAMS":
                fams.append(child["value"].strip("@"))
            elif tag.startswith("_") or tag == "EMAIL":
                attrs[tag] = child["value"]
            else:
                attrs[tag] = child["value"]

        gender = "O"
        if sex == "M":
            gender = "M"
        elif sex in ("F", "W"):
            gender = "F"

        alternates = []
        if nickname:
            alternates.append(nickname)

        known_name = display or given or pid
        full_name = display or given or pid
        attrs.update(
            {
                "KNOWN_NAME": known_name,
                "FULL_NAME": full_name,
                "GENDER": "Male" if gender == "M" else ("Female" if gender == "F" else ""),
                "EMAIL": attrs.get("EMAIL", attrs.get("_EMAIL", "")),
            }
        )

        birth_date, birth_year = "", None
        birth_place = ""
        if birth_event:
            birth_date, birth_year = parse_gedcom_date(birth_event["date"])
            birth_place = birth_event["place"]
            attrs["DOB"] = birth_date
            attrs["POB"] = birth_place
        death_date, death_year = "", None
        death_place = ""
        if death_event:
            death_date, death_year = parse_gedcom_date(death_event["date"])
            death_place = death_event["place"]
            attrs["DOD"] = death_date
            attrs["POD"] = death_place

        living = death_event is None and death_year is None and not death_place

        # Generation letter from PID prefix if it matches the sheet convention.
        generation = ""
        m = re.match(r"^([A-Z])", pid)
        if m:
            generation = m.group(1)
        attrs["GEN"] = generation
        attrs["GENERATION"] = generation
        attrs["STATUS"] = "Living" if living else "Deceased"
        attrs["YRS"] = ""
        attrs["NOTES"] = "\n\n".join(notes) if notes else ""

        vedic: dict[str, str] = {}
        for tag, key in VEDIC_TAGS.items():
            value = attrs.get(tag, "").strip()
            if value:
                vedic[key] = value

        people_by_id[pid] = {
            "id": pid,
            "gender": gender,
            "living": living,
            "hidden": False,
            "generation": generation,
            "name": {
                "display": display or full_name,
                "given": given,
                "surname": surname,
                "alternates": alternates,
            },
            "birth": ({
                "date": birth_date,
                "year": birth_year,
                "place": city_only(birth_place) if living else birth_place,
            } if (birth_date or birth_place) else None),
            "death": ({
                "date": death_date,
                "year": death_year,
                "place": death_place,
            } if (death_date or death_place) else None),
            "current_location": "",
            "events": [],
            "families": [],  # spouse families
            "parent_family": None,
            "notes": [],
            "stories": [],
            "attributes": attrs,
            "ref_name": attrs.get("REF_NAME", pid),
            "vedic": vedic,
            "_xref": xref,
            "_famc": famc,
            "_fams": fams,
        }

    return people_by_id, notes_by_xref, xref_to_id


def build_families(
    records: list[dict[str, Any]], people_by_id: dict[str, Any], xref_to_id: dict[str, str]
) -> list[dict[str, Any]]:
    """Create family records from FAM nodes and attach them to people."""
    families: list[dict[str, Any]] = []
    family_by_id: dict[str, str] = {}  # xref -> family uid
    uid_counter = 1

    def person_pid(xref: str) -> str | None:
        return xref_to_id.get(xref)

    def get_or_create_family(father_xref: str | None, mother_xref: str | None, marriage_date: str = ""):
        nonlocal uid_counter
        # Match an existing family with the same parents.
        for fam in families:
            if (
                fam["father"] == person_pid(father_xref)
                and fam["mother"] == person_pid(mother_xref)
            ):
                if marriage_date and not fam.get("marriage"):
                    fam["marriage"] = marriage_date
                return fam
        father = person_pid(father_xref)
        mother = person_pid(mother_xref)
        uid = f"U{uid_counter:03d}"
        uid_counter += 1
        partners = []
        if father:
            partners.append(f"{father}-{people_by_id[father]['name']['display'] or father}")
        if mother:
            partners.append(f"{mother}-{people_by_id[mother]['name']['display'] or mother}")
        fam = {
            "id": uid,
            "father": father,
            "mother": mother,
            "children": [],
            "relation": "Married" if marriage_date else "",
            "marriage": marriage_date,
            "notes": "",
            "ref_name": " & ".join(partners),
            "attributes": {"UID": uid, "REF_NAME": " & ".join(partners)},
        }
        families.append(fam)
        if father:
            people_by_id[father]["families"].append(uid)
        if mother:
            people_by_id[mother]["families"].append(uid)
        return fam

    # First create explicit families from FAM records.
    for rec in records:
        if rec["tag"] != "FAM":
            continue
        xref = rec["xref"]
        husb = wife = None
        children: list[str] = []
        marriage_date = ""
        for child in rec["children"]:
            if child["tag"] == "HUSB":
                husb = child["value"].strip("@")
            elif child["tag"] == "WIFE":
                wife = child["value"].strip("@")
            elif child["tag"] == "CHIL":
                children.append(child["value"].strip("@"))
            elif child["tag"] == "MARR":
                event = extract_event(child)
                marriage_date, _ = parse_gedcom_date(event["date"])
        # Determine father/mother by gender if possible; otherwise keep FAM order.
        father_xref = husb
        mother_xref = wife
        if husb and wife:
            husb_gender = people_by_id.get(person_pid(husb) or "", {}).get("gender")
            wife_gender = people_by_id.get(person_pid(wife) or "", {}).get("gender")
            if husb_gender == "F" and wife_gender == "M":
                father_xref, mother_xref = wife, husb
        fam = get_or_create_family(father_xref, mother_xref, marriage_date)
        family_by_id[xref] = fam["id"]
        for cx in children:
            pid = person_pid(cx)
            if pid and pid not in fam["children"]:
                fam["children"].append(pid)

    # Then attach children based on FAMC pointers (safety net for GEDCOMs that
    # list children only via INDI.FAMC and not FAM.CHIL).
    for person in people_by_id.values():
        for fam_xref in person["_famc"]:
            fam_id = family_by_id.get(fam_xref)
            if not fam_id:
                continue
            fam = next(f for f in families if f["id"] == fam_id)
            if person["id"] not in fam["children"]:
                fam["children"].append(person["id"])
            person["parent_family"] = fam_id

    return families


def build_graph(people_by_id: dict[str, Any], families: list[dict[str, Any]]) -> dict[str, Any]:
    """Build the node/edge graph expected by the site."""
    nodes = []
    edges = []
    for person in people_by_id.values():
        nodes.append(
            {
                "id": person["id"],
                "type": "person",
                "person_id": person["id"],
                "ref_name": person["ref_name"],
                "attributes": person.get("attributes", {}),
            }
        )
    for fam in families:
        nodes.append(
            {
                "id": fam["id"],
                "type": "union",
                "family_id": fam["id"],
                "ref_name": fam["ref_name"],
                "attributes": fam.get("attributes", {}),
            }
        )
        if fam["father"]:
            edges.append(
                {
                    "id": f"{fam['father']}-{fam['id']}",
                    "type": "partner",
                    "from": fam["father"],
                    "to": fam["id"],
                    "attributes": {"role": "partner"},
                }
            )
        if fam["mother"]:
            edges.append(
                {
                    "id": f"{fam['mother']}-{fam['id']}",
                    "type": "partner",
                    "from": fam["mother"],
                    "to": fam["id"],
                    "attributes": {"role": "partner"},
                }
            )
        for child in fam["children"]:
            edges.append(
                {
                    "id": f"{fam['id']}-{child}",
                    "type": "offspring",
                    "from": fam["id"],
                    "to": child,
                    "attributes": {"role": "offspring", "union": fam["id"]},
                }
            )
    return {"nodes": nodes, "edges": edges}


def inherit_vedic(people_by_id: dict[str, Any], families: list[dict[str, Any]]):
    """Copy gotra/veda/shakha/sutra/kula_devatha from father to child.

    Mirrors the old sheet importer so children inherit their paternal lineage.
    """
    children_by_family: dict[str, list[str]] = {}
    for fam in families:
        children_by_family.setdefault(fam["id"], []).extend(fam.get("children", []))

    VEDIC_INHERIT_FIELDS = ["gotra", "veda", "shakha", "sutra", "kula_devatha"]

    def father_of(pid: str, visited: set[str] | None = None) -> str | None:
        visited = visited or set()
        if pid in visited:
            return None
        visited.add(pid)
        for fam in families:
            if pid in fam.get("children", []) and fam.get("father"):
                return fam["father"]
        return None

    def paternal_value(pid: str, field: str, visited: set[str] | None = None):
        visited = visited or set()
        if pid in visited:
            return None
        visited.add(pid)
        person = people_by_id.get(pid)
        if not person:
            return None
        vedic = person.get("vedic") or {}
        value = vedic.get(field, "").strip()
        if value:
            return value
        return paternal_value(father_of(pid, set(visited)), field, visited)

    for person in people_by_id.values():
        vedic = person.setdefault("vedic", {})
        for field in VEDIC_INHERIT_FIELDS:
            if vedic.get(field, "").strip():
                continue
            inherited = paternal_value(person["id"], field)
            if inherited:
                vedic[field] = inherited

    # A woman marries into her husband's lineage; nakshatra stays with her.
    for fam in families:
        husband = people_by_id.get(fam.get("father") or "")
        wife = people_by_id.get(fam.get("mother") or "")
        if not husband or not wife:
            continue
        husband_vedic = husband.get("vedic") or {}
        wife_vedic = wife.setdefault("vedic", {})
        for field in VEDIC_INHERIT_FIELDS:
            value = husband_vedic.get(field, "").strip()
            if value and wife_vedic.get(field, "").strip() != value:
                wife_vedic[field] = value


def compute_charts(people_by_id: dict[str, Any], config: dict[str, Any]) -> int:
    """Compute sidereal birth charts for people with date, time and place."""
    if horoscope.swe is None:
        return 0

    charts_enabled = (config.get("vedic") or {}).get("charts", True)
    if not charts_enabled:
        return 0

    places_cfg = (config.get("places") or {})
    geocache_path = config.get("_geocache") or str(
        Path(__file__).resolve().parent.parent / "private" / "geocache.json"
    )

    chart_inputs = []
    for person in people_by_id.values():
        birth = person.get("birth") or {}
        if not birth.get("date") or not birth.get("place"):
            continue
        # The site only stores charts when a time is present.
        if not re.search(r"\d{1,2}:\d{2}", birth["date"]):
            continue
        parsed = horoscope.parse_birth(birth["date"])
        if not parsed or not parsed[1]:
            continue
        dt = parsed[1]
        chart_inputs.append((person, dt, birth["place"]))

    count = 0
    for person, dt, pob in chart_inputs:
        try:
            loc = geocode.geocode(pob, places_cfg, geocache_path)
            if not loc:
                continue
            chart = horoscope.compute_chart(dt, loc["lat"], loc["lon"], loc["tz"])
            if chart:
                vedic = person.setdefault("vedic", {})
                vedic["chart"] = chart
                moon = chart.get("moon", {})
                vedic["rashi"] = moon.get("rashi")
                vedic["nakshatra"] = moon.get("nakshatra")
                vedic["pada"] = moon.get("pada")
                count += 1
        except Exception as exc:  # pragma: no cover - optional dependency
            print(f"Chart failed for {person['id']}: {exc}", file=sys.stderr)
    return count


def build_tree(gedcom_path: Path, config: dict[str, Any], tree_id: str) -> dict[str, Any]:
    """Top-level conversion from a GEDCOM file to a Kula tree document."""
    records = parse_gedcom(gedcom_path)
    people_by_id, notes_by_xref, xref_to_id = build_people(records)
    families = build_families(records, people_by_id, xref_to_id)
    inherit_vedic(people_by_id, families)

    # Clean up temporary fields and finalize birth/death objects.
    for person in people_by_id.values():
        person.pop("_xref", None)
        person.pop("_famc", None)
        person.pop("_fams", None)
        # Refresh birth/death in case dates/places were refined.
        birth = person.get("birth")
        if birth and not birth.get("date") and not birth.get("place"):
            person["birth"] = None
        death = person.get("death")
        if death and not death.get("date") and not death.get("place"):
            person["death"] = None

    # Default focus person: the root ancestor with the most descendants.
    home = config.get("site", {}).get("default_person")
    if not home:
        roots = [p["id"] for p in people_by_id.values() if not p.get("parent_family")]
        if roots:
            # Count descendants for each root by walking families.
            child_map: dict[str, list[str]] = {}
            for fam in families:
                for child in fam.get("children", []):
                    child_map.setdefault(child, [])
                # not needed for counting
            def descendants(pid: str, visited: set[str] | None = None) -> set[str]:
                visited = visited or set()
                if pid in visited:
                    return set()
                visited.add(pid)
                result = set()
                for fam in families:
                    if fam.get("father") == pid or fam.get("mother") == pid:
                        for child in fam.get("children", []):
                            result.add(child)
                            result.update(descendants(child, set(visited)))
                return result
            home = max(roots, key=lambda r: len(descendants(r)))
        elif people_by_id:
            home = next(iter(people_by_id))
        else:
            home = ""

    chart_count = compute_charts(people_by_id, config)

    people = list(people_by_id.values())
    graph = build_graph(people_by_id, families)

    # Gather places from birth/death.
    places_set: set[str] = set()
    for p in people:
        if p.get("birth") and p["birth"].get("place"):
            places_set.add(p["birth"]["place"])
        if p.get("death") and p["death"].get("place"):
            places_set.add(p["death"]["place"])

    # Build notes/stories from inline person notes (placeholder structure).
    notes: list[dict[str, Any]] = []
    stories: list[dict[str, Any]] = []
    note_index = 1
    for person in people:
        if not person.get("notes_texts"):
            continue
        # Currently inline notes are not stored separately; attach directly.

    tree = {
        "schema": "kula.site/2.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": f"GEDCOM: {gedcom_path.name}",
        "home": home,
        "counts": {
            "people": len(people),
            "hidden_living": 0,
            "families": len(families),
            "stories": len(stories),
            "notes": len(notes),
            "charts": chart_count,
            "places": len(places_set),
        },
        "people": people,
        "families": families,
        "graph": graph,
        "generations": [],
        "notes": notes,
        "stories": stories,
        "vedic_catalog": {},
    }
    return tree


def main(argv=None):
    parser = argparse.ArgumentParser(description="Convert a GEDCOM file to Kula tree.json")
    parser.add_argument("--gedcom", required=True, help="Path to the .ged file")
    parser.add_argument("--config", default="docs/config.yml", help="Site config YAML")
    parser.add_argument("--tree", default="peru", help="Tree id (determines output folder)")
    parser.add_argument("--out", help="Override output path")
    args = parser.parse_args(argv)

    gedcom_path = Path(args.gedcom).resolve()
    config_path = Path(args.config).resolve()
    config = load_config(config_path)

    tree = build_tree(gedcom_path, config, args.tree)

    out_path = Path(args.out) if args.out else (Path("docs/data/trees") / args.tree / "tree.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(tree, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {out_path}")
    print(
        f"  people: {tree['counts']['people']}, "
        f"families: {tree['counts']['families']}, "
        f"charts: {tree['counts']['charts']}"
    )


if __name__ == "__main__":
    main()
