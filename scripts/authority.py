#!/usr/bin/env python3
"""Parse and match the original hierarchical family sheet.

The public data comes from the relational ``Persons`` tab, but the older
family sheet is still the authority for a handful of facts (birth, death and
living status). Its layout is very different: it has a title block above the
header, one row per person grouped by branch, and its own column names. This
module reads it by header rather than by position, then fuzzy-matches each row
to a person in the current sheet by name.

Nothing here writes files or touches the tree. ``import_sheet.build`` calls
``extract_records`` and ``match_records`` and applies the returned overrides.
"""

import difflib
import re
import unicodedata

import horoscope

DEFAULT_COLUMNS = {
    "relation": ["relation", "relationship"],
    "name": ["full name", "name", "person"],
    "dob": ["date of birth", "dob", "birth date"],
    "pob": ["place of birth", "pob", "birth place"],
    "status": ["living deceased", "living/deceased", "living or deceased", "status"],
    "dod": ["date of death", "dod", "death date"],
    "pod": ["place of death", "pod", "death place"],
}

PLACE_EMPTY = {
    "", "?", "unknown", "not known", "n a", "na", "none", "-", "--",
}


def normalize(text):
    """Lower-case, strip accents and punctuation, and collapse whitespace."""
    text = unicodedata.normalize("NFKD", text or "")
    text = text.encode("ascii", "ignore").decode()
    text = text.lower().replace("&", " and ")
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text).split())


def name_score(a, b):
    """Similarity of two names, tolerant of word order and spelling drift."""
    left, right = normalize(a), normalize(b)
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    direct = difflib.SequenceMatcher(None, left, right).ratio()
    ordered = difflib.SequenceMatcher(
        None, " ".join(sorted(left.split())), " ".join(sorted(right.split()))
    ).ratio()
    return max(direct, ordered)


def clean_place(value):
    """Return a usable place, dropping placeholders and uncertainty markers.

    The authority sheet writes ``Bombay (?)`` when a place is uncertain and a
    bare ``?`` when it is unknown. ``?`` is not a place; the parenthesised
    marker is dropped but the place name is kept.
    """
    text = (value or "").strip()
    text = re.sub(r"\s*[\(\[]\s*\?\s*[\)\]]", "", text)
    text = text.strip().strip("?").strip()
    text = re.sub(r"\s{2,}", " ", text)
    return "" if normalize(text) in PLACE_EMPTY else text


def clean_status(value):
    """Map the authority's Living/Deceased wording to the site's STATUS."""
    text = normalize(value)
    if text.startswith("deceas") or text.startswith("dead"):
        return "Deceased"
    if text.startswith("liv"):
        return "Living"
    return ""


def _normalize_columns(columns):
    merged = dict(DEFAULT_COLUMNS)
    for field, aliases in (columns or {}).items():
        if isinstance(aliases, str):
            aliases = [aliases]
        if aliases:
            merged[field] = list(aliases)
    return {field: {normalize(a) for a in aliases if normalize(a)}
            for field, aliases in merged.items()}


def _header_map(row, columns):
    """Return field -> column index for one candidate header row."""
    found = {}
    for index, cell in enumerate(row):
        key = normalize(cell)
        if not key:
            continue
        for field, aliases in columns.items():
            if field not in found and key in aliases:
                found[field] = index
    return found


def extract_records(sheets, config=None):
    """Read authority rows from every configured tab.

    The header is found by looking for the field names, so a title block,
    a missing column or a reordered sheet does not matter. Tabs without a
    recognisable name column are skipped (for example a legend/help tab).
    """
    config = config or {}
    columns = _normalize_columns(config.get("columns"))
    scan_rows = int(config.get("header_scan_rows") or 20)
    wanted_tabs = config.get("tabs")
    if isinstance(wanted_tabs, str):
        wanted_tabs = [wanted_tabs]
    wanted_tabs = {normalize(t) for t in (wanted_tabs or [])}

    records = []
    for tab, table in (sheets or {}).items():
        if wanted_tabs and normalize(tab) not in wanted_tabs:
            continue
        header_index = None
        header = {}
        for index, row in enumerate(table[:scan_rows]):
            found = _header_map(row, columns)
            if "name" not in found:
                continue
            # Prefer the row that recognises the most fields; ties go to the
            # first candidate, which is the real header in practice.
            if header_index is None or len(found) > len(header):
                header_index, header = index, found
        if header_index is None:
            continue

        name_index = header["name"]
        name_aliases = columns["name"]
        for index in range(header_index + 1, len(table)):
            row = table[index]

            def cell(field):
                column = header.get(field)
                if column is None or column >= len(row):
                    return ""
                return (row[column] or "").strip()

            name = cell("name")
            if not name or normalize(name) in name_aliases:
                continue
            record = {
                "tab": tab,
                "row": index + 1,
                "relation": cell("relation"),
                "name": name,
                "dob": cell("dob"),
                "pob": cell("pob"),
                "status": cell("status"),
                "dod": cell("dod"),
                "pod": cell("pod"),
            }
            # A row with only a name contributes nothing to the merge. The
            # original workbook has such a stub in its "Extended Family" tab.
            if not any(record[field] for field in ("dob", "pob", "status", "dod", "pod")):
                continue
            records.append(record)
    return records


def _month_number(name):
    months = horoscope.MONTHS
    key = (name or "").strip().lower()
    return months.get(key) or months.get(key[:3])


def day_month(value):
    """Return (day, month) from any date spelling the sheets use, else None."""
    text = (value or "").strip()
    if not text:
        return None
    # Excel/Sheets serial, including a fractional time.
    if re.fullmatch(r"\d{4,6}(?:\.\d+)?", text):
        _, parsed, _ = horoscope.parse_birth(text)
        return (parsed.day, parsed.month) if parsed else None
    # "Jan/1/1895 00:00:" and the other text formats parse_birth handles.
    _, parsed, _ = horoscope.parse_birth(text)
    if parsed:
        return (parsed.day, parsed.month)
    # Partial dates such as "29 June" and "14 Oct" have no year, so
    # parse_birth deliberately keeps them as text.
    match = re.match(r"^(\d{1,2})[\s/-]+([A-Za-z]{3,})", text)
    if match:
        month = _month_number(match.group(2))
        if month:
            return (int(match.group(1)), month)
    match = re.match(r"^([A-Za-z]{3,})[\s/-]+(\d{1,2})", text)
    if match:
        month = _month_number(match.group(1))
        if month:
            return (int(match.group(2)), month)
    match = re.match(r"^(\d{1,2})[/-](\d{1,2})[/-]\d{2,4}$", text)
    if match:
        return (int(match.group(1)), int(match.group(2)))
    return None


def _person_dob(person):
    attributes = person.get("attributes") or {}
    return attributes.get("DOB") or (person.get("birth") or {}).get("date") or ""


def _person_pob(person):
    attributes = person.get("attributes") or {}
    return attributes.get("POB") or (person.get("birth") or {}).get("place") or ""


def _person_status(person):
    return (person.get("attributes") or {}).get("STATUS") or ""


def match_records(records, people, config=None):
    """Match authority rows to current people, one-to-one.

    Name similarity is the primary signal. Birth day/month, birth place and
    living status only break ties, so a misspelt name is still matched when the
    other facts agree. Returns ``(matches, unmatched)`` where each match is a
    dict with ``record``, ``pid``, ``score`` and ``name_score``.
    """
    config = config or {}
    threshold = float(config.get("min_score") or 0.86)
    candidate = float(config.get("candidate_score") or 0.80)

    candidates = []
    for record_index, record in enumerate(records):
        for person in people:
            pid = person.get("id")
            score = name_score(record.get("name"), _person_name(person))
            if score < candidate:
                continue
            total = score
            record_dm = day_month(record.get("dob"))
            person_dm = day_month(_person_dob(person))
            if record_dm and record_dm == person_dm:
                total += 0.05
            record_pob = normalize(clean_place(record.get("pob")))
            person_pob = normalize(clean_place(_person_pob(person)))
            if record_pob and record_pob == person_pob:
                total += 0.03
            record_status = clean_status(record.get("status"))
            if record_status and record_status == _person_status(person):
                total += 0.01
            candidates.append((total, score, record_index, pid, person))

    candidates.sort(key=lambda item: (-item[0], -item[1], item[2], item[3]))

    used_records = set()
    used_people = set()
    matches = []
    for total, score, record_index, pid, person in candidates:
        if score < threshold:
            continue
        if record_index in used_records or pid in used_people:
            continue
        used_records.add(record_index)
        used_people.add(pid)
        matches.append({
            "record": records[record_index],
            "pid": pid,
            "person": person,
            "score": round(total, 4),
            "name_score": round(score, 4),
        })

    matches.sort(key=lambda match: match["pid"])
    unmatched = [record for index, record in enumerate(records)
                 if index not in used_records]
    return matches, unmatched


def _person_name(person):
    attributes = person.get("attributes") or {}
    return (attributes.get("FULL_NAME")
            or (person.get("name") or {}).get("display")
            or "")
