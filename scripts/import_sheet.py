#!/usr/bin/env python3
"""Build the static family-tree data from the relatives Google Sheet.

The sheet is the source of truth. It has these tabs:

    Persons     PID, KNOWN_NAME, FULL_NAME, REF_NAME, EMAIL, GENDER, DOB, POB, STATUS, DOD, NOTES, GEN
    Vedic       PERSON, GOTRA, VEDA, SHAKHA, SUTRA, KULA_DEVATHA, SAMPRADAYA, ACHARYA_THIRUMALIGAI, PURVIKAM, PARVATA
    $Config     GOTRA, VEDA, SHAKHA, SUTRA
    KG          SUBJECT, PREDICATE, OBJECT, DATE, NOTES
    Stories     NOTE_ID, TYPE, TITLE, IS_STORY, TAGGED_PEOPLE, TAGGED_NAMES, TEXT, UPDATED

Usage:
    python3 scripts/import_sheet.py --url "https://docs.google.com/spreadsheets/d/.../edit"
    python3 scripts/import_sheet.py --url "..." private/relatives.xlsx

Every relationship lives in the KG tab as a graph: one row per edge, such as
"P-101-Himavan parentOf P-202-Parvati". SUBJECT and OBJECT are human-readable
refs; the PID prefix is the real key. The importer resolves each reference by
that PID prefix (with REF_NAME and unique-known-name fallbacks for hand-edited
sheets), then derives the union/children model the site expects: spouse edges
become unions, parentOf/childOf edges become those unions' children, and
co-parenting is inferred through spouses. There are no separate Unions or
Offsprings tabs.

Every original column is kept as a node or edge attribute, and the site also
gets a compact people/families/notes view so the existing tree, list and
profile panels keep working.

Pravara is deliberately NOT written here. It is derived from gotra at runtime
by docs/assets/vedic.js, so a stale PRAVARA column can never disagree.

The original hierarchical family sheet (source.authority in docs/config.yml)
is the authority for birth, death and living status. Its rows are fuzzy-matched
to the current Persons rows by name, then only non-empty values override the
relational sheet. Blank cells never erase existing data.

Birth charts (jatagam): when a person's DOB includes a time AND they have a
POB, a sidereal (Lahiri) chart is computed with Swiss Ephemeris and stored at
person.vedic.chart. The engine also supplies the Moon's rashi / nakshatra /
pada. Enter DOB as a real date-time cell in Google Sheets (recommended) or as
text like "15 Aug 1950 14:30". Charts need the optional dependencies:

    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    .venv/bin/python scripts/import_sheet.py --url "YOUR_SHEET_URL"
"""

import argparse
import datetime as dt
import io
import json
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import yaml

# Horoscope (jatagam) support lives in sibling modules. They import cleanly
# even without the optional dependencies (pyswisseph / timezonefinder); chart
# computation is simply skipped with a warning in that case.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import authority  # noqa: E402
import geocode as geocode_mod  # noqa: E402
import horoscope  # noqa: E402
from horoscope import parse_birth  # noqa: E402

DEFAULT_TABS = {
    "persons": "Persons",
    "vedic": "Vedic",
    "config": "$Config",
    "kg": "KG",
}
NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
PERSON_CORE = ["PID", "KNOWN_NAME", "FULL_NAME", "REF_NAME", "EMAIL", "GENDER", "DOB",
               "POB", "STATUS", "DOD", "NOTES", "GEN"]
VEDIC_FIELDS = {
    "GOTRA": "gotra",
    "VEDA": "veda",
    "SHAKHA": "shakha",
    "SUTRA": "sutra",
    "KULA_DEVATHA": "kula_devatha",
    "SAMPRADAYA": "sampradaya",
    "ACHARYA_THIRUMALIGAI": "acharya_thirumaligai",
    "PURVIKAM": "purvikam",
    "PARVATA": "parvata",
}


def log(msg):
    print(msg)


def sheet_id_from_url(url):
    m = re.search(r"/spreadsheets/d/([A-Za-z0-9_-]+)", url or "")
    return m.group(1) if m else (url or "").strip()


def download_workbook(url):
    sid = sheet_id_from_url(url)
    if not sid:
        raise SystemExit(f"Could not find a spreadsheet ID in {url!r}")
    export = f"https://docs.google.com/spreadsheets/d/{sid}/export?format=xlsx"
    req = urllib.request.Request(export, headers={"User-Agent": "kula-family-tree/1.0"})
    with urllib.request.urlopen(req, timeout=60) as res:
        data = res.read()
    if not data.startswith(b"PK"):
        raise SystemExit("Google Sheets did not return an .xlsx file. Is the sheet shared as "
                         "'Anyone with the link can view'?")
    return data


def column_number(ref):
    letters = re.match(r"([A-Z]+)", ref).group(1)
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch) - 64
    return n


def read_shared_strings(z):
    if "xl/sharedStrings.xml" not in z.namelist():
        return []
    root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    out = []
    for si in root.findall("m:si", NS):
        out.append("".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t")))
    return out


def read_sheet(z, target, shared):
    root = ET.fromstring(z.read(target))
    rows = []
    for row in root.iter(f"{{{NS['m']}}}row"):
        values = {}
        for cell in row.findall("m:c", NS):
            ref = cell.get("r") or ""
            typ = cell.get("t")
            v = cell.find("m:v", NS)
            if typ == "inlineStr":
                inline = cell.find("m:is", NS)
                value = "".join(t.text or "" for t in inline.iter(f"{{{NS['m']}}}t")) if inline is not None else ""
            elif v is None:
                value = ""
            elif typ == "s":
                value = shared[int(v.text)]
            else:
                value = v.text or ""
            values[column_number(ref)] = value
        rows.append(values)
    if not rows:
        return []
    width = max((max(r) for r in rows if r), default=0)
    table = []
    for r in rows:
        table.append([str(r.get(i, "") or "").strip() for i in range(1, width + 1)])
    return table


def read_workbook(raw):
    z = zipfile.ZipFile(io.BytesIO(raw))
    shared = read_shared_strings(z)
    workbook = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    relmap = {r.get("Id"): r.get("Target") for r in rels}
    sheets = {}
    for sh in workbook.find("m:sheets", NS):
        name = sh.get("name")
        rid = sh.get(f"{{{NS['r']}}}id")
        target = relmap.get(rid, "")
        target = target.lstrip("/")
        if not target.startswith("xl/"):
            target = "xl/" + target
        sheets[name] = read_sheet(z, target, shared)
    return sheets


def records(table, required):
    """Turn a sheet into dicts keyed by its header row, skipping blank rows."""
    if not table:
        return []
    header = [h.strip() for h in table[0]]
    out = []
    for row in table[1:]:
        rec = {}
        for i, key in enumerate(header):
            if not key:
                continue
            rec[key] = row[i].strip() if i < len(row) else ""
        if any(rec.get(k) for k in required if rec.get(k)):
            out.append(rec)
    return out


def parse_year(value):
    m = re.search(r"\b(1[5-9]\d\d|20\d\d)\b", value or "")
    return int(m.group(1)) if m else None


def gender_code(value):
    v = (value or "").strip().lower()
    if v.startswith("m"):
        return "M"
    if v.startswith("f") or v.startswith("w"):
        return "F"
    return "O"


def split_name(full):
    """Split a full name into given name, surname, and nickname.

    A trailing parenthetical is treated as a nickname and stripped from the
    name parts, so "Rajalakshmi Krishnamurthy ( Rajam )" becomes given
    "Rajalakshmi", surname "Krishnamurthy" and nickname "Rajam".
    """
    text = (full or "").strip()
    nickname = ""
    match = re.search(r"\s*\(([^)]*)\)\s*$", text)
    if match:
        nickname = match.group(1).strip()
        text = text[:match.start()].strip()
    words = [w for w in re.split(r"\s+", text) if w]
    if not words:
        return text, "", nickname
    if len(words) < 2:
        return words[0], "", nickname
    return " ".join(words[:-1]), words[-1], nickname


def city_only(value):
    """Living people are published at city level only."""
    text = (value or "").strip()
    if not text:
        return ""
    # Drop a country/state after the first comma, and drop a landmark detail
    # that is sometimes appended after a dash.
    text = text.split(",")[0].strip()
    text = re.split(r"\s+[–-]\s+", text)[0].strip()
    return text


def effective_date_year(display, parsed):
    """Prefer the parsed year; fall back to a year written inside the text."""
    return parsed.year if parsed else parse_year(display or "")


def refresh_birth_death(person):
    """Rebuild the public birth/death objects from the effective attributes.

    Attributes are the merged values (current sheet + authority overrides).
    Living people's birth places are reduced to city level here, after the
    final living/deceased status is known.
    """
    attrs = person.get("attributes") or {}
    living = bool(person.get("living", True))
    dob, dob_dt, _ = parse_birth(attrs.get("DOB"))
    pob_raw = (attrs.get("POB") or "").strip()
    pob = city_only(pob_raw) if living else pob_raw
    person["birth"] = ({
        "date": dob or "",
        "year": effective_date_year(dob, dob_dt),
        "place": pob,
    } if (dob or pob) else None)

    dod, dod_dt, _ = parse_birth(attrs.get("DOD"))
    pod = (attrs.get("POD") or "").strip()
    person["death"] = ({
        "date": dod or "",
        "year": effective_date_year(dod, dod_dt),
        "place": pod,
    } if (dod or pod) else None)


def validate_person_dates(person, today=None):
    """Warn about impossible or contradictory dates after the merge."""
    today = today or dt.date.today()
    attrs = person.get("attributes") or {}
    pid = person.get("id") or "?"
    dob, dob_dt, dob_has_time = parse_birth(attrs.get("DOB"))
    dod, dod_dt, _ = parse_birth(attrs.get("DOD"))
    pod = (attrs.get("POD") or "").strip()
    warnings = []
    # Google Sheets gives a day+month typed into a date cell the current
    # year. Flag those so an unknown birth year is not published as 2026.
    if (dob_dt and not dob_has_time and dob_dt.year == today.year
            and not (attrs.get("DOB") or "").strip().lower().startswith(str(dob_dt.year))):
        warnings.append(
            f"{pid}: DOB '{dob}' has the current year but no time; if the "
            f"year is unknown (a Sheets default), enter the day and month "
            f"as text, e.g. '29 June'")
    if dob_dt and dob_dt.date() > today:
        warnings.append(f"{pid}: DOB '{dob}' is in the future")
    if dod_dt and dod_dt.date() > today:
        warnings.append(f"{pid}: DOD '{dod}' is in the future")
    if dob_dt and dod_dt:
        if dod_dt < dob_dt:
            warnings.append(f"{pid}: DOD '{dod}' is before DOB '{dob}'")
        elif dob_dt.date() == dod_dt.date():
            warnings.append(
                f"{pid}: DOB '{dob}' and DOD '{dod}' are the same day; check "
                "whether the death date was typed into the DOB cell")
        elif (dod_dt.date() - dob_dt.date()).days > 120 * 365.25:
            warnings.append(f"{pid}: age at death from DOB '{dob}' and DOD '{dod}' looks implausible")
    # The sheet's YRS column is the age at death for deceased people. A large
    # disagreement with the dates usually means a stale YRS or a wrong date.
    if not person.get("living", True) and dob_dt and dod_dt:
        stated = (attrs.get("YRS") or "").strip()
        if stated.isdigit():
            age = dod_dt.year - dob_dt.year - (
                (dod_dt.month, dod_dt.day) < (dob_dt.month, dob_dt.day))
            if abs(int(stated) - age) > 1:
                warnings.append(
                    f"{pid}: YRS {stated} does not match DOB '{dob}' and DOD "
                    f"'{dod}' (age {age}); check YRS or the birth date")
    if person.get("living") and (dod or pod):
        warnings.append(f"{pid}: STATUS is living but a death date/place is present")
    return warnings


def merge_authority(people, rows, config=None):
    """Apply the original sheet's non-empty facts over the current people.

    Matching is name-based with date/place/status tie-breakers. Empty authority
    cells are ignored, so they never erase a value from the Persons tab.
    """
    if not rows or not people:
        return []
    matches, unmatched = authority.match_records(rows, people, config)
    warnings = []
    for record in unmatched:
        warnings.append(
            f"Authority row {record['tab']}!{record['row']} "
            f"{record['name']!r} did not match any person")
    for match in matches:
        record, person, pid = match["record"], match["person"], match["pid"]
        attrs = person.setdefault("attributes", {})
        name = (person.get("name") or {}).get("display") or pid
        changes = []

        status = authority.clean_status(record.get("status"))
        if status:
            old = attrs.get("STATUS") or ""
            if old != status:
                changes.append(f"STATUS {old!r} -> {status!r}")
            attrs["STATUS"] = status
            person["living"] = status != "Deceased"

        dob_raw = (record.get("dob") or "").strip()
        if dob_raw:
            dob, dob_dt, dob_has_time = parse_birth(dob_raw)
            dob = dob or dob_raw
            old_dob = attrs.get("DOB") or ""
            _, old_dt, old_has_time = parse_birth(old_dob)
            # Keep a more detailed current value (with time) when the authority
            # only supplies the same calendar date.
            skip_dob = (old_has_time and not dob_has_time and old_dt and dob_dt
                        and old_dt.date() == dob_dt.date())
            if not skip_dob and old_dob != dob:
                changes.append(f"DOB {old_dob!r} -> {dob!r}")
                attrs["DOB"] = dob

        pob = authority.clean_place(record.get("pob"))
        if pob:
            old = attrs.get("POB") or ""
            if old != pob:
                changes.append(f"POB {old!r} -> {pob!r}")
            attrs["POB"] = pob

        dod_raw = (record.get("dod") or "").strip()
        if dod_raw:
            dod, dod_dt, dod_has_time = parse_birth(dod_raw)
            dod = dod or dod_raw
            old_dod = attrs.get("DOD") or ""
            _, old_dt, old_has_time = parse_birth(old_dod)
            skip_dod = (old_has_time and not dod_has_time and old_dt and dod_dt
                        and old_dt.date() == dod_dt.date())
            if not skip_dod and old_dod != dod:
                changes.append(f"DOD {old_dod!r} -> {dod!r}")
                attrs["DOD"] = dod

        pod = authority.clean_place(record.get("pod"))
        if pod:
            old = attrs.get("POD") or ""
            if old != pod:
                changes.append(f"POD {old!r} -> {pod!r}")
            attrs["POD"] = pod

        refresh_birth_death(person)
        if changes:
            warnings.append(f"Authority override {pid} {name}: " + "; ".join(changes))
        if match["name_score"] < 0.95:
            warnings.append(
                f"Authority fuzzy match {record['name']!r} -> {pid} {name} "
                f"(name score {match['name_score']:.3f})")
    return warnings


PID_RE = re.compile(r"^\s*([A-Z]-?\d+)\b", re.IGNORECASE)


def pid_prefix(value):
    """Return the PID at the start of a sheet reference.

    Relationship cells are written as "<PID>-<KNOWN_NAME>", for example
    "P049-Sriram", "A001-Venkiteswara Iyer" or "z031-Thejaswini". KNOWN_NAME
    is the human-friendly pseudo key people use while entering data, and the
    PID prefix keeps it unique when two people share a known name. The PID is
    therefore the real lookup key; the name part is only there to make the
    sheet readable.

    A PID is a generation letter, an optional hyphen, then digits, so the
    prefix may be any letter (A-Z), not only P (sheet-native).
    """
    match = PID_RE.match(value or "")
    return match.group(1).upper() if match else None


def make_ref(pid, known_name):
    """Build the canonical "<PID>-<KNOWN_NAME>" reference."""
    known = (known_name or "").strip()
    return f"{pid}-{known}" if pid and known else (pid or "")


def person_resolver(persons):
    """Resolve "<PID>-<KNOWN_NAME>" cells back to a person ID.

    The PID prefix is authoritative. Exact REF_NAME and unique KNOWN_NAME
    matches are kept as fallbacks for hand-edited sheets that dropped the
    prefix.
    """
    by_pid = {}
    by_ref = {}
    by_known = {}
    for person in persons:
        pid = (person.get("PID") or "").strip().upper()
        if not pid:
            continue
        known = (person.get("KNOWN_NAME") or "").strip()
        ref = (person.get("REF_NAME") or "").strip() or make_ref(pid, known)
        by_pid[pid] = pid
        by_ref[ref.lower()] = pid
        by_ref[make_ref(pid, known).lower()] = pid
        if known:
            by_known.setdefault(known.lower(), []).append(pid)

    def resolve(value):
        text = (value or "").strip()
        if not text:
            return None
        pid = pid_prefix(text)
        if pid and pid in by_pid:
            return pid
        if text.lower() in by_ref:
            return by_ref[text.lower()]
        matches = by_known.get(text.lower(), [])
        if len(matches) == 1:
            return matches[0]
        return None

    return resolve


KG_PREDICATES = {
    "spouse": {"spouseof", "spouse", "husband", "wife", "married"},
    "parent": {"parentof", "parent", "father", "mother"},
    "child": {"childof", "child", "offspring", "son", "daughter"},
}


def build_families_from_kg(kg_rows, resolve, persons_raw, warnings=None):
    """Convert KG relationship triples into the family/union model.

    The KG tab stores human-readable edges such as
    ``P-101-Himavan parentOf P-201-Parvati``. The PID prefix is extracted and
    resolved; the name suffix is ignored. Spouse links are bidirectional, and
    parent/child links are mirrored (``childOf`` is the reverse of
    ``parentOf``). Co-parenting is inferred through spouses, so a child linked
    to one parent is automatically linked to that parent's spouses.

    Returns ``(families, parent_family, warnings)`` where ``families`` is the
    list used by the rest of the importer and ``parent_family`` maps each child
    PID to the UID of the family they belong to.
    """
    warnings = warnings if warnings is not None else []

    spouse_map = {}
    children_map = {}
    parent_map = {}

    def add_set(mapping, key, value):
        mapping.setdefault(key, set()).add(value)

    for row in kg_rows:
        sub = (row.get("SUBJECT") or "").strip()
        pred = (row.get("PREDICATE") or "").strip().lower()
        obj = (row.get("OBJECT") or "").strip()
        sub_pid = resolve(sub) if sub else None
        obj_pid = resolve(obj) if obj else None

        if not sub_pid or not obj_pid or not pred:
            continue
        if sub_pid == obj_pid:
            warnings.append(f"KG row ignores self-reference: {sub} {pred} {obj}")
            continue

        if pred in KG_PREDICATES["spouse"]:
            add_set(spouse_map, sub_pid, obj_pid)
            add_set(spouse_map, obj_pid, sub_pid)
        elif pred in KG_PREDICATES["parent"]:
            add_set(children_map, sub_pid, obj_pid)
            add_set(parent_map, obj_pid, sub_pid)
        elif pred in KG_PREDICATES["child"]:
            add_set(children_map, obj_pid, sub_pid)
            add_set(parent_map, sub_pid, obj_pid)

    # Infer co-parenting through spouses.
    for p1, spouses in list(spouse_map.items()):
        for sp in spouses:
            for child in children_map.get(sp, set()):
                add_set(children_map, p1, child)
                add_set(parent_map, child, p1)

    # Build families: group children by their (ordered) set of parents.
    child_to_parents = {}
    for child, parents in parent_map.items():
        child_to_parents[child] = frozenset(parents)

    parent_set_to_children = {}
    for child, parents in child_to_parents.items():
        parent_set_to_children.setdefault(parents, []).append(child)

    # Families for spouses without children.
    seen_parent_sets = set(parent_set_to_children.keys())
    for p1, spouses in spouse_map.items():
        for sp in spouses:
            pair = frozenset({p1, sp})
            if pair not in seen_parent_sets:
                parent_set_to_children[pair] = []
                seen_parent_sets.add(pair)

    # Single parents with children are already captured by parent_map.
    # Spouses without children are captured above.

    def gender(pid):
        return next((gender_code(p.get("GENDER")) for p in persons_raw
                     if (p.get("PID") or "").strip().upper() == pid), "O")

    def assign_parents(parent_set):
        """Return (father, mother) from a parent set using gender hints."""
        parents = list(parent_set)
        if len(parents) == 0:
            return None, None
        if len(parents) == 1:
            pid = parents[0]
            return (None, pid) if gender(pid) == "F" else (pid, None)
        if len(parents) >= 2:
            genders = [(gender(p), p) for p in parents]
            males = [p for g, p in genders if g == "M"]
            females = [p for g, p in genders if g == "F"]
            others = [p for g, p in genders if g == "O"]
            father = males[0] if males else (others[0] if others else parents[0])
            mother = females[0] if females else None
            if mother == father:
                mother = None
            if len(parents) > 2:
                extras = [p for p in parents if p not in (father, mother)]
                warnings.append(
                    f"KG: child has more than two parents ({', '.join(parents)}); "
                    f"using {father} and {mother or 'no mother'}, ignoring {', '.join(extras)}")
            return father, mother

    families = []
    family_by_uid = {}
    parent_family = {}
    uid_counter = 1

    # Union ids must not collide with person PIDs: the sheet uses generation
    # letters (A001, F003, ...), so a bare "F001" family id would shadow a
    # person node in the graph. The U prefix plus this guard keeps node ids
    # unique even if a future generation reaches U.
    person_pids = {(p.get("PID") or "").strip().upper() for p in persons_raw}

    known_by_pid = {
        (p.get("PID") or "").strip().upper(): (p.get("KNOWN_NAME") or "").strip()
        for p in persons_raw
    }

    for parent_set, children in parent_set_to_children.items():
        father, mother = assign_parents(parent_set)
        partners = [p for p in (father, mother) if p]
        ref = " & ".join(make_ref(pid, known_by_pid.get(pid, "")) for pid in partners)
        uid = f"U{uid_counter:03d}"
        while uid in person_pids:
            uid_counter += 1
            uid = f"U{uid_counter:03d}"
        uid_counter += 1

        fam = {
            "id": uid,
            "father": father,
            "mother": mother,
            "children": list(dict.fromkeys(children)),
            "relation": "Married" if len(partners) == 2 else "Unknown",
            "marriage": None,
            "notes": "",
            "ref_name": ref or uid,
            "attributes": {"UID": uid, "REF_NAME": ref or uid},
        }
        families.append(fam)
        family_by_uid[uid] = fam
        for child in fam["children"]:
            parent_family.setdefault(child, uid)

    return families, parent_family, warnings


# Nakshatra is personal: it depends on the exact time and place of birth and
# is computed from the birth chart. It must never be inherited from a parent
# or a spouse. Everything else in the Vedic tab is part of the lineage.
VEDIC_PERSONAL_FIELDS = {"nakshatra"}
VEDIC_INHERIT_FIELDS = [
    field for field in VEDIC_FIELDS.values() if field not in VEDIC_PERSONAL_FIELDS
]


def _clean(value):
    return value.strip() if isinstance(value, str) else value


def inherit_vedic(people, person_by_pid, family_by_uid):
    """Fill missing Vedic lineage fields, then apply marriage.

    A child inherits the lineage fields (gotra, veda, shakha, sutra, kula
    devatha, sampradaya, acharya thirumaligai, purvikam, parvata) from the
    father, walking up the paternal line as needed. Nakshatra is deliberately
    excluded: it is fixed by the person's own birth date, time and place.

    After that, a married woman takes her husband's lineage fields. Her own
    nakshatra is left untouched. Values the husband does not have are not
    erased, so a woman whose husband's lineage is unknown keeps whatever she
    already has.
    """
    def father_of(pid):
        person = person_by_pid.get(pid)
        if not person:
            return None
        fam = family_by_uid.get(person.get("parent_family") or "")
        return fam.get("father") if fam else None

    def paternal_value(pid, field, visited=None):
        if visited is None:
            visited = set()
        if pid in visited:
            return None
        visited.add(pid)
        person = person_by_pid.get(pid)
        if not person:
            return None
        vedic = person.get("vedic") or {}
        value = _clean(vedic.get(field))
        if value:
            return value
        father_id = father_of(pid)
        return paternal_value(father_id, field, visited) if father_id else None

    for person in people:
        if person.get("hidden"):
            continue
        vedic = person.setdefault("vedic", {})
        for field in VEDIC_INHERIT_FIELDS:
            if not _clean(vedic.get(field)):
                inherited = paternal_value(person["id"], field)
                if inherited:
                    vedic[field] = inherited

    # A woman marries into her husband's lineage. Nakshatra stays with her,
    # because it is a property of her birth, not of the marriage.
    for fam in family_by_uid.values():
        husband = person_by_pid.get(fam.get("father") or "")
        wife = person_by_pid.get(fam.get("mother") or "")
        if not husband or not wife:
            continue
        if husband.get("gender") != "M" or wife.get("gender") != "F":
            continue
        husband_vedic = husband.get("vedic") or {}
        wife_vedic = wife.setdefault("vedic", {})
        for field in VEDIC_INHERIT_FIELDS:
            value = _clean(husband_vedic.get(field))
            if value and _clean(wife_vedic.get(field)) != value:
                wife_vedic[field] = value


def build(sheets, config, tabs=None, authority_rows=None):
    tabs = {**DEFAULT_TABS, **(tabs or {})}
    persons_raw = records(sheets.get(tabs["persons"], []), PERSON_CORE)
    kg_raw = records(sheets.get(tabs["kg"], []), ["SUBJECT", "PREDICATE", "OBJECT", "DATE", "NOTES"])
    vedic_raw = records(sheets.get(tabs["vedic"], []), ["PERSON", *VEDIC_FIELDS])
    config_raw = records(sheets.get(tabs["config"], []), ["GOTRA"])
    # Stories/Notes tab is optional. Try "Stories" first, then "Notes".
    notes_raw = (records(sheets.get("Stories", []), ["NOTE_ID", "TYPE", "TITLE", "IS_STORY", "TAGGED_PEOPLE", "TEXT", "UPDATED"]) or
                 records(sheets.get("Notes", []), ["NOTE_ID", "TYPE", "TITLE", "IS_STORY", "TAGGED_PEOPLE", "TEXT", "UPDATED"]))

    resolve = person_resolver(persons_raw)
    warnings = []

    vedic_by_pid = {}
    for row in vedic_raw:
        pid = resolve(row.get("PERSON"))
        if not pid:
            warnings.append(f"Vedic row for unknown person {row.get('PERSON')!r}")
            continue
        values = {}
        for key, field in VEDIC_FIELDS.items():
            value = (row.get(key) or "").strip()
            if value:
                values[field] = value
        if values:
            vedic_by_pid[pid] = values

    # Families first so people can list their unions and parent family. The KG
    # tab is the only relationship source: unions are derived from spouse
    # edges, children from parentOf/childOf edges.
    families, parent_family, warnings = build_families_from_kg(
        kg_raw, resolve, persons_raw, warnings)
    family_by_uid = {f["id"]: f for f in families}

    people = []
    person_by_pid = {}
    for row in persons_raw:
        pid = (row.get("PID") or "").strip().upper()
        if not pid:
            continue
        full = (row.get("FULL_NAME") or "").strip()
        known = (row.get("KNOWN_NAME") or "").strip()
        display = full or known or pid
        given, surname, nickname = split_name(display)
        alternates = []
        if known and known != display:
            alternates.append(known)
        if nickname:
            alternates.append(nickname)
        living = (row.get("STATUS") or "").strip().lower() != "deceased"
        # parse_birth turns Sheets date-time serials and text dates into a
        # friendly display string, and keeps the datetime for the horoscope.
        dob, dob_dt, dob_has_time = parse_birth(row.get("DOB"))
        events = []
        # Keep the original sheet columns for reference, but show Sheets
        # date-time serials (e.g. "16827.0") as friendly dates.
        attrs = dict(row)
        if dob:
            attrs["DOB"] = dob
        dod, _, _ = parse_birth(row.get("DOD"))
        if dod:
            attrs["DOD"] = dod
        generation = ((row.get("GEN") or row.get("GENERATION") or "").strip().upper())
        person = {
            "id": pid,
            "gender": gender_code(row.get("GENDER")),
            "living": living,
            "hidden": False,
            "generation": generation,
            "name": {
                "display": display,
                "given": given,
                "surname": surname,
                "alternates": alternates,
            },
            "birth": None,
            "death": None,
            "current_location": "",
            "events": events,
            "families": [],
            "parent_family": parent_family.get(pid),
            "notes": [],
            "stories": [],
            "attributes": attrs,
            "ref_name": make_ref(pid, known) or (row.get("REF_NAME") or "").strip() or pid,
        }
        refresh_birth_death(person)
        if pid in vedic_by_pid:
            person["vedic"] = vedic_by_pid[pid]
        person_by_pid[pid] = person
        people.append(person)

    # The older hierarchical sheet is the authority for birth, death and
    # living status. Apply it after the current rows exist but before charts,
    # so an authoritative DOB/POB also drives the jatagam.
    authority_rows = authority_rows or []
    warnings.extend(merge_authority(
        people, authority_rows, (config.get("source") or {}).get("authority") or {}))
    for person in people:
        warnings.extend(validate_person_dates(person))

    # Propagate Vedic lineage fields down the paternal line, then let a
    # married woman take her husband's lineage. Nakshatra is excluded because
    # it is determined by the person's own birth date, time and place.
    inherit_vedic(people, person_by_pid, family_by_uid)

    for fam in families:
        for partner in (fam["father"], fam["mother"]):
            if partner in person_by_pid and fam["id"] not in person_by_pid[partner]["families"]:
                person_by_pid[partner]["families"].append(fam["id"])

    # --- Graph: person and union nodes, partner and offspring edges --------
    nodes = []
    for person in people:
        nodes.append({
            "id": person["id"],
            "type": "person",
            "person_id": person["id"],
            "ref_name": person["ref_name"],
            "attributes": dict(person["attributes"]),
        })
    for fam in families:
        nodes.append({
            "id": fam["id"],
            "type": "union",
            "union_id": fam["id"],
            "ref_name": fam["ref_name"],
            "attributes": dict(fam["attributes"]),
        })

    edges = []
    for fam in families:
        for partner in (fam["father"], fam["mother"]):
            if not partner:
                continue
            edges.append({
                "id": f"{fam['id']}-{partner}",
                "type": "partner",
                "from": partner,
                "to": fam["id"],
                "attributes": {"role": "partner", "union": fam["id"]},
            })
    for fam in families:
        for child in fam["children"]:
            edges.append({
                "id": f"{fam['id']}-{child}",
                "type": "offspring",
                "from": fam["id"],
                "to": child,
                "attributes": {"role": "offspring", "union": fam["id"]},
            })

    # --- Notes and Stories -----------------------------------------------------
    notes = []
    for row in notes_raw:
        nid = (row.get("NOTE_ID") or "").strip()
        if not nid:
            continue
        is_story_text = (row.get("IS_STORY") or "").strip().upper()
        is_story = is_story_text in ("TRUE", "YES", "1")
        text = (row.get("TEXT") or "").strip()
        if not text:
            continue
        paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
        if not paragraphs:
            continue
        # Resolve tagged people: semicolon-separated PIDs or PID-KNOWN_NAME refs.
        tagged_raw = (row.get("TAGGED_PEOPLE") or "").strip()
        tagged_people = []
        for part in re.split(r"[;,]", tagged_raw):
            pid = resolve(part.strip())
            if pid and pid not in tagged_people:
                tagged_people.append(pid)
        note = {
            "id": nid,
            "type": (row.get("TYPE") or "").strip() or "Person Note",
            "title": (row.get("TITLE") or "").strip() or None,
            "is_story": is_story,
            "tags": [],
            "words": len(text.split()),
            "paragraphs": paragraphs,
            "people": tagged_people,
            "places": [],
            "updated": (row.get("UPDATED") or "").strip() or None,
        }
        notes.append(note)
        # Attach the note to each tagged person.
        for pid in tagged_people:
            if pid in person_by_pid:
                person_by_pid[pid]["notes"].append(nid)
                if is_story:
                    person_by_pid[pid]["stories"].append(nid)

    # --- Birth charts (jatagam) --------------------------------------------
    # Only when DOB has a date AND time AND the person has a POB. The engine
    # (Swiss Ephemeris, Lahiri ayanamsa) supplies the lagna, graha positions
    # and the Moon's rashi/nakshatra/pada; these engine values win over the
    # sheet (except NAKSHATRA, which may carry family spellings).
    vedic_cfg = (config.get("vedic") or {})
    charts_enabled = vedic_cfg.get("charts", True)
    places_cfg = config.get("places") or {}
    offline = bool(config.get("_offline"))
    geocache_path = config.get("_geocache") or "private/geocache.json"
    chart_inputs = []
    for person in people:
        dob, birth_dt, has_time = parse_birth(
            (person.get("attributes") or {}).get("DOB"))
        pob = (person.get("birth") or {}).get("place") or ""
        if birth_dt and has_time and pob:
            chart_inputs.append((person, birth_dt, pob))
    if charts_enabled and chart_inputs and horoscope.swe is None:
        warnings.append(
            "Birth charts requested but pyswisseph is not installed; "
            "run with .venv/bin/python (see requirements.txt)")
        charts_enabled = False
    if charts_enabled:
        geocode_warned = set()

        def geo_warn(msg):
            if msg not in geocode_warned:
                geocode_warned.add(msg)
                warnings.append(msg)

        for person, birth_dt, pob in chart_inputs:
            geo = geocode_mod.geocode(
                pob, config_places=places_cfg, cache_path=geocache_path,
                offline=offline, warn=geo_warn)
            if not geo:
                continue
            chart = horoscope.compute_chart(
                birth_dt, geo["lat"], geo["lon"], geo.get("tz") or "Asia/Kolkata")
            if not chart:
                continue
            vedic = person.setdefault("vedic", {})
            vedic["chart"] = chart
            vedic["rashi"] = chart["moon"]["rashi"]
            vedic["pada"] = chart["moon"]["pada"]
            if not (vedic.get("nakshatra") or "").strip():
                vedic["nakshatra"] = chart["moon"]["nakshatra"]

    home = (config.get("site") or {}).get("default_person")
    if home not in person_by_pid:
        home = people[0]["id"] if people else None

    counts = {
        "people": len(people),
        "hidden_living": 0,
        "families": len(families),
        "stories": sum(1 for n in notes if n["is_story"]),
        "notes": len(notes),
        "charts": sum(1 for p in people if (p.get("vedic") or {}).get("chart")),
        "places": len({p["birth"]["place"] for p in people
                       if p.get("birth") and p["birth"].get("place")} |
                      {p.get("current_location") for p in people if p.get("current_location")}),
    }

    generations = sorted({p.get("generation") for p in people if p.get("generation")},
                         key=lambda g: (len(g), g))

    data = {
        "schema": "kula.site/2.0",
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source": "Google Sheet",
        "home": home,
        "counts": counts,
        "people": people,
        "families": families,
        "notes": notes,
        "generations": generations,
        "graph": {
            "schema": "kula.graph/1.0",
            "nodes": nodes,
            "edges": edges,
        },
        "vedic_catalog": config_raw,
    }
    return data, warnings


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("xlsx", nargs="?", help="Local .xlsx export. Omit to download the shared sheet.")
    ap.add_argument("--url", required=True, help="Google Sheet URL or ID to import")
    ap.add_argument("--authority", default=None,
                    help="Local .xlsx of the original authority sheet (overrides source.authority.cache)")
    ap.add_argument("--config", default="docs/config.yml")
    ap.add_argument("--out", default="docs/data/tree.json")
    ap.add_argument("--tree", default=None,
                    help="Tree id to write to. When set, output goes to docs/data/trees/<tree>/tree.json unless --out is also given.")
    ap.add_argument("--cache", default=None,
                    help="Where to keep a downloaded workbook for offline rebuilds (overrides source.cache)")
    ap.add_argument("--offline", action="store_true",
                    help="Do not hit the network for geocoding; use only the cache and config places")
    ap.add_argument("--override", action="store_true",
                    help="Use the relational sheet as the sole source of truth: skip the authority merge")
    args = ap.parse_args(argv)

    cfg = yaml.safe_load(Path(args.config).read_text(encoding="utf-8")) if Path(args.config).exists() else {}
    cfg = cfg or {}
    cfg["_offline"] = args.offline
    cfg["_geocache"] = str(Path(args.config).resolve().parent.parent / "private" / "geocache.json")
    source = cfg.get("source") or {}
    tabs = source.get("tabs") or {}
    url = args.url
    cache_path = args.cache or source.get("cache") or ""

    if args.xlsx:
        raw = Path(args.xlsx).read_bytes()
        log(f"Reading {args.xlsx}")
    else:
        log(f"Downloading {sheet_id_from_url(url)}")
        raw = download_workbook(url)
        if cache_path:
            cache = Path(cache_path)
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_bytes(raw)
            log(f"Cached workbook at {cache}")

    sheets = read_workbook(raw)

    authority_cfg = source.get("authority") or {}
    authority_rows = []
    if args.override and authority_cfg:
        log("Skipping authority merge because --override was requested")
    elif authority_cfg:
        auth_path = args.authority or authority_cfg.get("path") or ""
        auth_url = authority_cfg.get("sheet_url") or ""
        auth_cache = authority_cfg.get("cache") or ""
        if auth_path:
            auth_raw = Path(auth_path).read_bytes()
            log(f"Reading authority sheet {auth_path}")
        elif auth_url and args.offline and auth_cache and Path(auth_cache).exists():
            auth_raw = Path(auth_cache).read_bytes()
            log(f"Reading cached authority sheet {auth_cache}")
        elif auth_url:
            log(f"Downloading authority sheet {sheet_id_from_url(auth_url)}")
            auth_raw = download_workbook(auth_url)
            if auth_cache:
                cache = Path(auth_cache)
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_bytes(auth_raw)
                log(f"Cached authority sheet at {cache}")
        else:
            raise SystemExit("source.authority needs a sheet_url, path or cache in docs/config.yml")
        authority_rows = authority.extract_records(read_workbook(auth_raw), authority_cfg)
        log(f"Authority rows: {len(authority_rows)}")

    data, warnings = build(sheets, cfg, tabs, authority_rows=authority_rows)

    if args.tree and args.out == "docs/data/tree.json":
        out = Path(f"docs/data/trees/{args.tree}/tree.json")
    else:
        out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    log(f"Wrote {out}")
    log(f"  people: {data['counts']['people']}")
    log(f"  families: {data['counts']['families']}")
    log(f"  graph: {len(data['graph']['nodes'])} nodes, {len(data['graph']['edges'])} edges")
    log(f"  vedic: {sum(1 for p in data['people'] if p.get('vedic'))} people")
    log(f"  charts: {data['counts']['charts']} birth charts")
    for warning in warnings:
        log(f"  WARNING: {warning}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
