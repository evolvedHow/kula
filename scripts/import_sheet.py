#!/usr/bin/env python3
"""Build the static family-tree data from the relatives Google Sheet.

The sheet is the source of truth. It has five tabs:

    Persons     PID, KNOWN_NAME, FULL_NAME, REF_NAME, EMAIL, GENDER, DOB, POB, CUR_LOC, STATUS, NOTES
    Vedic       PERSON, GOTRA, VEDA, SHAKHA, SUTRA, NAKSHATRA, KULA_DEVATHA, SAMPRADAYA, ACHARYA_THIRUMALIGAI, PURVIKAM, PARVATA
    $Config     GOTRA, VEDA, SHAKHA, SUTRA, NAKSHATRA
    Unions      UID, PID1, PID2, REF_NAME, REL_START, REL_END, NOTES
    Offsprings  OID, UNION_OF, OFFSPRING, NOTES

Usage:
    python3 scripts/import_sheet.py
    python3 scripts/import_sheet.py private/relatives.xlsx
    python3 scripts/import_sheet.py --url "https://docs.google.com/spreadsheets/d/.../edit"

The tab values PID1/PID2/UNION_OF/OFFSPRING are readable keys of the form
"<PID>-<KNOWN_NAME>", for example "P049-Sriram". KNOWN_NAME is the pseudo key
people use while entering data; the PID prefix keeps it unique when known
names repeat. The importer resolves each reference by that PID prefix (with
REF_NAME and unique-known-name fallbacks for hand-edited sheets), so a name
edit in the Persons tab cannot break the union or offspring links.

Every original column is kept as a node or edge attribute, and the site also
gets a compact people/families/notes view so the existing tree, list and
profile panels keep working.

Pravara is deliberately NOT written here. It is derived from gotra at runtime
by docs/assets/vedic.js, so a stale PRAVARA column can never disagree.
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

DEFAULT_TABS = {
    "persons": "Persons",
    "vedic": "Vedic",
    "config": "$Config",
    "unions": "Unions",
    "offsprings": "Offsprings",
}
NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
PERSON_CORE = ["PID", "KNOWN_NAME", "FULL_NAME", "REF_NAME", "EMAIL", "GENDER", "DOB",
               "POB", "CUR_LOC", "STATUS", "NOTES"]
VEDIC_FIELDS = {
    "GOTRA": "gotra",
    "VEDA": "veda",
    "SHAKHA": "shakha",
    "SUTRA": "sutra",
    "NAKSHATRA": "nakshatra",
    "KULA_DEVATHA": "kula_devatha",
    "SAMPRADAYA": "sampradaya",
    "ACHARYA_THIRUMALIGAI": "acharya_thirumaligai",
    "PURVIKAM": "purvikam",
    "PARVATA": "parvata",
}
MONTHS = {m.lower(): i + 1 for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}


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


def parse_date(value):
    """Keep the sheet's friendly date text and extract a year when possible."""
    text = (value or "").strip()
    if not text:
        return None, None
    year = parse_year(text)
    if year:
        return text, year
    # "29 June" has no year, but keep it readable.
    return text, None


def parse_dmy(value):
    """Convert dd/mm/yyyy (the sheet's REL_START) to 'd Mon yyyy'."""
    text = (value or "").strip()
    if not text:
        return None, None
    m = re.match(r"^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$", text)
    if m:
        day, month, year = map(int, m.groups())
        if 1 <= month <= 12:
            return f"{day} {list(MONTHS)[month - 1].capitalize()} {year}", year
    return text, parse_year(text)


def gender_code(value):
    v = (value or "").strip().lower()
    if v.startswith("m"):
        return "M"
    if v.startswith("f") or v.startswith("w"):
        return "F"
    return "O"


def split_name(full):
    words = [w for w in re.split(r"\s+", (full or "").strip()) if w]
    if len(words) < 2:
        return full.strip(), ""
    return " ".join(words[:-1]), words[-1]


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


PID_RE = re.compile(r"^\s*([PI]\d+)\b", re.IGNORECASE)
ANY_PID_RE = re.compile(r"\b([PI]\d+)\b", re.IGNORECASE)
UNION_RE = re.compile(r"^\s*(U\d+)\b", re.IGNORECASE)


def pid_prefix(value):
    """Return the PID at the start of a sheet reference.

    Relationship cells are written as "<PID>-<KNOWN_NAME>", for example
    "P049-Sriram" or "I000-Venkiteswara". KNOWN_NAME is the human-friendly
    pseudo key people use while entering data, and the PID prefix keeps it
    unique when two people share a known name. The PID is therefore the real
    lookup key; the name part is only there to make the sheet readable.

    PIDs can start with P (sheet-native) or I (imported from Gramps).
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


def union_resolver(families):
    """Resolve a union reference from UID, REF_NAME or partner IDs.

    Offspring rows point at a union with its readable REF_NAME, such as
    "P001-Viswanatha Tatha & P002-Valliammal". The partner PIDs embedded in
    that string are the stable key, so a ref-name edit cannot break the link.
    """
    by_uid = {}
    by_ref = {}
    by_partners = {}
    for family in families:
        uid = family["id"]
        by_uid[uid.lower()] = uid
        ref = (family.get("ref_name") or "").strip()
        if ref:
            by_ref[ref.lower()] = uid
        partners = tuple(sorted(p for p in (family.get("father"), family.get("mother")) if p))
        if partners:
            by_partners[frozenset(partners)] = uid

    def resolve(value):
        text = (value or "").strip()
        if not text:
            return None
        uid = UNION_RE.match(text)
        if uid and uid.group(1).lower() in by_uid:
            return by_uid[uid.group(1).lower()]
        if text.lower() in by_ref:
            return by_ref[text.lower()]
        partner_ids = {p.upper() for p in ANY_PID_RE.findall(text)}
        if partner_ids:
            key = frozenset(partner_ids)
            if key in by_partners:
                return by_partners[key]
        return None

    return resolve


def build(sheets, config, tabs=None):
    tabs = {**DEFAULT_TABS, **(tabs or {})}
    persons_raw = records(sheets.get(tabs["persons"], []), PERSON_CORE)
    unions_raw = records(sheets.get(tabs["unions"], []), ["UID", "PID1", "PID2", "REF_NAME", "REL_START", "REL_END", "NOTES"])
    offspring_raw = records(sheets.get(tabs["offsprings"], []), ["OID", "UNION_OF", "OFFSPRING", "NOTES"])
    vedic_raw = records(sheets.get(tabs["vedic"], []), ["PERSON", *VEDIC_FIELDS])
    config_raw = records(sheets.get(tabs["config"], []), ["GOTRA"])
    # Stories/Notes tab is optional. Try "Stories" first, then "Notes".
    notes_raw = (records(sheets.get("Stories", []), ["NOTE_ID", "TYPE", "TITLE", "IS_STORY", "TAGGED_PEOPLE", "TEXT", "UPDATED"]) or
                 records(sheets.get("Notes", []), ["NOTE_ID", "TYPE", "TITLE", "IS_STORY", "TAGGED_PEOPLE", "TEXT", "UPDATED"]))

    resolve = person_resolver(persons_raw)
    known_by_pid = {
        (p.get("PID") or "").strip().upper(): (p.get("KNOWN_NAME") or "").strip()
        for p in persons_raw
    }
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

    # Families first so people can list their unions and parent family.
    families = []
    family_by_uid = {}
    for row in unions_raw:
        uid = (row.get("UID") or "").strip()
        if not uid:
            continue
        p1 = resolve(row.get("PID1"))
        p2 = resolve(row.get("PID2"))
        if not p1 and not p2:
            warnings.append(f"Union {uid} has no resolvable partners")
            continue
        if not p1 and (row.get("PID1") or "").strip():
            warnings.append(f"Union {uid}: unknown PID1 {row.get('PID1')!r}")
        if not p2 and (row.get("PID2") or "").strip():
            warnings.append(f"Union {uid}: unknown PID2 {row.get('PID2')!r}")
        ref = " & ".join(
            make_ref(pid, known_by_pid.get(pid, ""))
            for pid in (p1, p2) if pid
        ) or (row.get("REF_NAME") or "").strip() or uid
        attrs = dict(row)
        attrs["UID"] = uid
        attrs["PID1"] = p1 or ""
        attrs["PID2"] = p2 or ""
        attrs["REF_NAME"] = ref
        if p1:
            attrs["PID1_REF"] = row.get("PID1", "")
        if p2:
            attrs["PID2_REF"] = row.get("PID2", "")
        date, year = parse_dmy(row.get("REL_START"))
        father, mother = p1, p2
        if p2 and p1:
            g1 = next((gender_code(p.get("GENDER")) for p in persons_raw if p["PID"] == p1), "O")
            g2 = next((gender_code(p.get("GENDER")) for p in persons_raw if p["PID"] == p2), "O")
            if g1 == "F" and g2 != "F":
                father, mother = p2, p1
            elif g1 == g2:
                father, mother = p1, p2
        elif p2 and not p1:
            father, mother = p2, None
        fam = {
            "id": uid,
            "father": father,
            "mother": mother,
            "children": [],
            "relation": "Married" if date else "Unknown",
            "marriage": {"date": date, "year": year, "place": ""} if date else None,
            "notes": row.get("NOTES", ""),
            "ref_name": ref,
            "attributes": attrs,
        }
        families.append(fam)
        family_by_uid[uid] = fam

    resolve_union = union_resolver(families)

    # Offspring edges create both the family's children and the person's
    # parent_family link.
    for row in offspring_raw:
        uid = resolve_union(row.get("UNION_OF"))
        child = resolve(row.get("OFFSPRING"))
        if not uid or not child:
            warnings.append(f"Offspring {row.get('OID')}: could not resolve "
                            f"{row.get('UNION_OF')!r} -> {row.get('OFFSPRING')!r}")
            continue
        fam = family_by_uid[uid]
        if child in (fam["father"], fam["mother"]):
            warnings.append(f"Offspring {row.get('OID')}: {child} is a partner of {uid}, skipped")
            continue
        if child not in fam["children"]:
            fam["children"].append(child)

    parent_family = {}
    for fam in families:
        for child in fam["children"]:
            parent_family.setdefault(child, fam["id"])

    people = []
    person_by_pid = {}
    for row in persons_raw:
        pid = (row.get("PID") or "").strip()
        if not pid:
            continue
        full = (row.get("FULL_NAME") or "").strip()
        known = (row.get("KNOWN_NAME") or "").strip()
        display = full or known or pid
        given, surname = split_name(display)
        alternates = [known] if known and known != display else []
        living = (row.get("STATUS") or "").strip().lower() != "deceased"
        dob, birth_year = parse_date(row.get("DOB"))
        pob = city_only(row.get("POB")) if living else (row.get("POB") or "").strip()
        cur = city_only(row.get("CUR_LOC")) if living else (row.get("CUR_LOC") or "").strip()
        events = []
        if cur:
            events.append({"type": "Current location", "role": "", "date": None,
                           "year": None, "place": cur, "description": ""})
        person = {
            "id": pid,
            "gender": gender_code(row.get("GENDER")),
            "living": living,
            "hidden": False,
            "name": {
                "display": display,
                "given": given,
                "surname": surname,
                "alternates": alternates,
            },
            "birth": ({"date": dob, "year": birth_year, "place": pob} if (dob or pob) else None),
            "death": None,
            "current_location": cur,
            "events": events,
            "families": [],
            "parent_family": parent_family.get(pid),
            "notes": [],
            "stories": [],
            "attributes": dict(row),
            "ref_name": make_ref(pid, known) or (row.get("REF_NAME") or "").strip() or pid,
        }
        if pid in vedic_by_pid:
            person["vedic"] = vedic_by_pid[pid]
        person_by_pid[pid] = person
        people.append(person)

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
    offspring_attrs = {}
    seen_oids = set()
    for row in offspring_raw:
        uid = resolve_union(row.get("UNION_OF"))
        child = resolve(row.get("OFFSPRING"))
        oid = (row.get("OID") or "").strip()
        if oid and oid in seen_oids:
            warnings.append(f"Duplicate offspring ID {oid}, using first occurrence")
            continue
        if oid:
            seen_oids.add(oid)
        if uid and child and child in family_by_uid[uid]["children"]:
            offspring_attrs.setdefault((uid, child), []).append(row)
    for (uid, child), rows in offspring_attrs.items():
        first = rows[0]
        edges.append({
            "id": first.get("OID") or f"{uid}-{child}",
            "type": "offspring",
            "from": uid,
            "to": child,
            "attributes": {
                "OID": first.get("OID", ""),
                "UNION_OF": first.get("UNION_OF", ""),
                "OFFSPRING": first.get("OFFSPRING", ""),
                "NOTES": " ".join(r.get("NOTES", "") for r in rows if r.get("NOTES")).strip(),
            },
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

    home = (config.get("site") or {}).get("default_person")
    if home not in person_by_pid:
        home = people[0]["id"] if people else None

    counts = {
        "people": len(people),
        "hidden_living": 0,
        "families": len(families),
        "stories": sum(1 for n in notes if n["is_story"]),
        "notes": len(notes),
        "places": len({p["birth"]["place"] for p in people
                       if p.get("birth") and p["birth"].get("place")} |
                      {p.get("current_location") for p in people if p.get("current_location")}),
    }

    data = {
        "schema": "kula.site/2.0",
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source": "Google Sheet",
        "home": home,
        "counts": counts,
        "people": people,
        "families": families,
        "notes": notes,
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
    ap.add_argument("--url", default=None, help="Google Sheet URL or ID (overrides source.sheet_url in config)")
    ap.add_argument("--config", default="docs/config.yml")
    ap.add_argument("--out", default="docs/data/tree.json")
    ap.add_argument("--cache", default=None,
                    help="Where to keep a downloaded workbook for offline rebuilds (overrides source.cache)")
    args = ap.parse_args(argv)

    cfg = yaml.safe_load(Path(args.config).read_text(encoding="utf-8")) if Path(args.config).exists() else {}
    cfg = cfg or {}
    source = cfg.get("source") or {}
    tabs = source.get("tabs") or {}
    url = args.url or source.get("sheet_url") or ""
    cache_path = args.cache or source.get("cache") or ""

    if not args.xlsx and not url:
        raise SystemExit("No sheet source. Set source.sheet_url in docs/config.yml, pass --url, "
                         "or pass a local .xlsx file.")

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
    data, warnings = build(sheets, cfg, tabs)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    log(f"Wrote {out}")
    log(f"  people: {data['counts']['people']}")
    log(f"  unions: {data['counts']['families']}")
    log(f"  graph: {len(data['graph']['nodes'])} nodes, {len(data['graph']['edges'])} edges")
    log(f"  vedic: {sum(1 for p in data['people'] if p.get('vedic'))} people")
    for warning in warnings:
        log(f"  WARNING: {warning}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
