#!/usr/bin/env python3
"""Convert a Gramps XML export into the static family-tree site's data file.

Usage:
    python3 scripts/build_site.py path/to/export.gramps
    python3 scripts/build_site.py export.gramps --config docs/config.yml --out docs/data/tree.json

Accepts plain Gramps XML (.gramps / .xml) or gzip-compressed Gramps XML.

Privacy is applied here, before anything is written, so living people's
details, private records, and excluded stories never reach the published
JSON. Settings come from the `privacy:` and `narratives:` sections of config.yml.
"""

import argparse
import datetime as dt
import gzip
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import yaml

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
DEATH_EVENTS = {"Death", "Burial", "Cremation"}
BIRTH_EVENTS = {"Birth", "Baptism", "Christening"}
DEFAULT_NARRATIVE_TYPES = ["Blog", "Narrative", "Story", "Biography", "Memoir"]
YEAR_RE = re.compile(r"(\d{4})")


def localname(tag):
    return tag.rsplit("}", 1)[-1]


def children(el, name):
    return [c for c in el if localname(c.tag) == name]


def child(el, name):
    for c in el:
        if localname(c.tag) == name:
            return c
    return None


def text(el):
    return (el.text or "").strip() if el is not None else ""


def load_tree(path):
    raw = Path(path).read_bytes()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return ET.fromstring(raw)


def format_date_value(val):
    """'1955-01-31' -> '31 Jan 1955'; partial dates keep only the known parts."""
    parts = val.split("-")
    if not parts or not parts[0].isdigit():
        return val, None
    year = int(parts[0])
    month = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
    day = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 0
    if month and 1 <= month <= 12:
        if day:
            return f"{day} {MONTHS[month - 1]} {year}", year
        return f"{MONTHS[month - 1]} {year}", year
    return str(year), year


def date_from_element(el):
    """Return (display_text, year) for a Gramps date-bearing element."""
    if el is None:
        return None, None
    tag = localname(el.tag)
    if tag == "datestr":
        val = el.get("val", "")
        m = YEAR_RE.search(val)
        return val or None, int(m.group(1)) if m else None
    if tag == "dateval":
        display, year = format_date_value(el.get("val", ""))
        kind = el.get("type", "")
        if kind == "about":
            display = "c. " + display
        elif kind == "before":
            display = "before " + display
        elif kind == "after":
            display = "after " + display
        return display, year
    if tag in ("daterange", "datespan"):
        start, year = format_date_value(el.get("start", ""))
        stop, _ = format_date_value(el.get("stop", ""))
        return f"{start} – {stop}", year
    return None, None


def event_date(event_el):
    for name in ("dateval", "datestr", "daterange", "datespan"):
        d = child(event_el, name)
        if d is not None:
            return date_from_element(d)
    return None, None


def build_places(root):
    by_handle = {}
    parent_of = {}
    for po in root.iter():
        if localname(po.tag) != "placeobj":
            continue
        handle = po.get("handle")
        pname = child(po, "pname")
        name = pname.get("value", "") if pname is not None else ""
        by_handle[handle] = name
        ref = child(po, "placeref")
        if ref is not None:
            parent_of[handle] = ref.get("hlink")
    cache = {}

    def full(handle, depth=0):
        if handle in cache:
            return cache[handle]
        if handle not in by_handle or depth > 20:
            return ""
        parent = parent_of.get(handle)
        name = by_handle[handle]
        parent_name = full(parent, depth + 1) if parent else ""
        cache[handle] = ", ".join(p for p in (name, parent_name) if p)
        return cache[handle]

    for handle in by_handle:
        full(handle)
    return cache


def tags_map(root):
    out = {}
    for t in root.iter():
        if localname(t.tag) == "tag" and t.get("handle"):
            out[t.get("handle")] = (t.get("name") or "").strip()
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("export", help="Gramps XML export (.gramps, .xml, or gzipped)")
    ap.add_argument("--config", default="docs/config.yml")
    ap.add_argument("--out", default="docs/data/tree.json")
    args = ap.parse_args(argv)

    cfg = yaml.safe_load(Path(args.config).read_text(encoding="utf-8")) or {}
    privacy = cfg.get("privacy") or {}
    narr = cfg.get("narratives") or {}

    hide_living = privacy.get("hide_living", True)
    living_years = int(privacy.get("living_years", 100))
    living_label = privacy.get("living_label", "Living")
    always_public = set(privacy.get("always_public", []) or [])
    honor_private = privacy.get("respect_private_flag", True)
    exclude_tags = {t.lower() for t in privacy.get("exclude_tags", ["private", "draft"])}
    check_mentions = privacy.get("scan_stories_for_living_names", True)
    # redact: replace a living person's full name in story text with living_label
    # drop:   leave the whole story out instead
    living_mentions = privacy.get("living_names_in_stories", "redact")
    include_notes = privacy.get("include_notes", True)

    narrative_types = {t.lower() for t in narr.get("note_types", DEFAULT_NARRATIVE_TYPES)}
    narrative_tags = {t.lower() for t in narr.get("tags", ["blog", "story", "narrative"])}
    min_words = int(narr.get("min_words", 200))
    auto_types = {t.lower() for t in narr.get("auto_detect_types", ["Person Note", "Family Note", "Event Note", "Place Note"])}
    narratives_enabled = narr.get("enabled", True)

    root = load_tree(args.export)
    today = dt.date.today().year
    places = build_places(root)
    tags = tags_map(root)

    warnings = []

    # --- Raw people ---------------------------------------------------------
    events = {}
    for ev in root.iter():
        if localname(ev.tag) == "event" and ev.get("handle"):
            events[ev.get("handle")] = ev

    people_raw = {}
    handle_to_id = {}
    for p in root.iter():
        if localname(p.tag) != "person" or not p.get("handle"):
            continue
        pid = p.get("id")
        handle_to_id[p.get("handle")] = pid
        people_raw[pid] = p

    private_ids = {pid for pid, p in people_raw.items() if honor_private and p.get("priv") == "1"}

    def person_events(p):
        out = []
        for ref in children(p, "eventref"):
            ev = events.get(ref.get("hlink"))
            if ev is None:
                continue
            etype = text(child(ev, "type"))
            date_text, year = event_date(ev)
            place_el = child(ev, "place")
            place = places.get(place_el.get("hlink"), "") if place_el is not None else ""
            out.append({
                "type": etype,
                "role": ref.get("role", ""),
                "date": date_text,
                "year": year,
                "place": place,
                "description": text(child(ev, "description")),
            })
        return out

    # --- Living detection --------------------------------------------------
    people = {}
    hidden_names = []
    for pid, p in people_raw.items():
        if pid in private_ids:
            continue
        evs = person_events(p)
        birth = next((e for e in evs if e["type"] == "Birth" and e["role"] == "Primary"), None) \
            or next((e for e in evs if e["type"] == "Birth"), None)
        death = next((e for e in evs if e["type"] in DEATH_EVENTS and e["role"] == "Primary"), None) \
            or next((e for e in evs if e["type"] in DEATH_EVENTS), None)
        birth_year = birth["year"] if birth else None
        deceased = death is not None
        if deceased:
            living = False
        elif birth_year is None:
            living = True
        else:
            living = (today - birth_year) < living_years
        if pid in always_public:
            living = False

        name_el = child(p, "name")
        given = text(child(name_el, "first")) if name_el is not None else ""
        surnames = [text(s) for s in children(name_el, "surname")] if name_el is not None else []
        surname = " ".join(s for s in surnames if s)
        suffix = text(child(name_el, "suffix")) if name_el is not None else ""
        full = " ".join(s for s in (given, surname, suffix) if s) or "Unnamed"
        alt = []
        for alt_el in children(p, "alternatename"):
            n = child(alt_el, "first")
            s = " ".join(text(x) for x in children(alt_el, "surname") if text(x))
            label = " ".join(x for x in (text(n), s) if x)
            if label and label != full:
                alt.append(label)

        rec = {
            "id": pid,
            "gender": text(child(p, "gender")) or "U",
            "living": living,
            "name": {"display": full, "given": given, "surname": surname, "alternates": alt},
            "birth": None,
            "death": None,
            "events": [],
            "families": [r.get("hlink") for r in children(p, "parentin")],
            "parent_family": None,
            "notes": [],
            "stories": [],
        }
        if living and hide_living:
            rec["name"] = {"display": living_label, "given": "", "surname": "", "alternates": []}
            rec["hidden"] = True
            hidden_names.append(full)
        else:
            if birth:
                rec["birth"] = {k: birth[k] for k in ("date", "year", "place")}
            if death:
                rec["death"] = {k: death[k] for k in ("date", "year", "place")}
            rec["events"] = [{k: e[k] for k in ("type", "date", "year", "place", "description")}
                             for e in evs if e is not birth and e is not death]
        people[pid] = rec

    # --- Families ------------------------------------------------------------
    families = {}
    fam_handle = {}
    for f in root.iter():
        if localname(f.tag) != "family" or not f.get("handle"):
            continue
        fid = f.get("id")
        fam_handle[f.get("handle")] = fid
        father = child(f, "father")
        mother = child(f, "mother")
        f_id = handle_to_id.get(father.get("hlink")) if father is not None else None
        m_id = handle_to_id.get(mother.get("hlink")) if mother is not None else None
        kids = []
        for c in children(f, "childref"):
            cid = handle_to_id.get(c.get("hlink"))
            if cid:
                kids.append(cid)
        marriage = None
        for ref in children(f, "eventref"):
            ev = events.get(ref.get("hlink"))
            if ev is not None and text(child(ev, "type")) == "Marriage":
                d, y = event_date(ev)
                pl = child(ev, "place")
                marriage = {"date": d, "year": y,
                            "place": places.get(pl.get("hlink"), "") if pl is not None else ""}
                break
        rel = child(f, "rel")
        families[fid] = {
            "id": fid,
            "father": f_id,
            "mother": m_id,
            "children": kids,
            "relation": rel.get("type", "") if rel is not None else "",
            "marriage": marriage,
            "_handle": f.get("handle"),
        }

    # Drop references to private or hidden-away people, keep structure.
    visible = set(people)
    for fam in families.values():
        if fam["father"] not in visible:
            fam["father"] = None
        if fam["mother"] not in visible:
            fam["mother"] = None
        fam["children"] = [c for c in fam["children"] if c in visible]
    for rec in people.values():
        rec["families"] = [fid for fid in rec["families"] if fid in families]
    for fid, fam in families.items():
        for cid in fam["children"]:
            if cid in people:
                people[cid]["parent_family"] = fid
        for pid in (fam["father"], fam["mother"]):
            if pid and fid not in people[pid]["families"]:
                people[pid]["families"].append(fid)
    # Keep the family list for people that also appear as parents-in-family
    for rec in people.values():
        rec["families"] = list(dict.fromkeys(rec["families"]))
    for fam in families.values():
        fam.pop("_handle", None)

    # --- Notes and stories ---------------------------------------------------
    subjects = {}
    for kind_el in root.iter():
        tag = localname(kind_el.tag)
        if tag == "person" and kind_el.get("id") in people_raw:
            pid = kind_el.get("id")
            for ref in children(kind_el, "noteref"):
                subjects.setdefault(ref.get("hlink"), {"people": set(), "places": set()})["people"].add(pid)
            for er in children(kind_el, "eventref"):
                ev = events.get(er.get("hlink"))
                if ev is not None:
                    for ref in children(ev, "noteref"):
                        subjects.setdefault(ref.get("hlink"), {"people": set(), "places": set()})["people"].add(pid)
        elif tag == "family":
            fid = kind_el.get("id")
            if fid not in families:
                continue
            fam = families[fid]
            partners = [x for x in (fam["father"], fam["mother"]) if x]
            for ref in children(kind_el, "noteref"):
                entry = subjects.setdefault(ref.get("hlink"), {"people": set(), "places": set()})
                entry["people"].update(partners)
        elif tag == "placeobj":
            for ref in children(kind_el, "noteref"):
                subjects.setdefault(ref.get("hlink"), {"people": set(), "places": set()})["places"].add(
                    places.get(kind_el.get("handle"), ""))

    # Full names only: single given names collide too often to be a safe test.
    hidden_name_pats = [(name, re.compile(r"\b" + re.escape(name) + r"\b", re.I))
                        for name in dict.fromkeys(hidden_names) if len(name) >= 5] if check_mentions else []
    redacted = []

    notes_out = []
    stories_dropped = []
    for n in root.iter():
        if localname(n.tag) != "note" or not n.get("handle"):
            continue
        if honor_private and n.get("priv") == "1":
            continue
        handle = n.get("handle")
        note_type = n.get("type", "")
        tag_names = [tags.get(r.get("hlink"), "") for r in children(n, "tagref")]
        tag_lower = {t.lower() for t in tag_names if t}
        body = (child(n, "text").text if child(n, "text") is not None else "") or ""
        body = body.replace("\r\n", "\n").strip()
        if not body:
            continue

        subj = subjects.get(handle, {"people": set(), "places": set()})
        subj_people = sorted(p for p in subj["people"] if p in people and not people[p].get("hidden"))
        subj_places = sorted(p for p in subj["places"] if p)
        if subj["people"] and not subj_people and not subj_places:
            continue  # only about private or living people
        if tag_lower & exclude_tags:
            continue

        words = len(re.findall(r"\w+", body))
        is_story = narratives_enabled and (
            note_type.lower() in narrative_types
            or bool(tag_lower & narrative_tags)
            or (note_type.lower() in auto_types and words >= min_words)
        )

        if is_story and hidden_name_pats:
            hit = next((label for label, pat in hidden_name_pats if pat.search(body)), None)
            if hit and living_mentions == "drop":
                stories_dropped.append((handle, hit))
                continue
            if hit:
                for label, pat in hidden_name_pats:
                    body, count = pat.subn(living_label, body)
                    if count:
                        redacted.append((handle, label, count))

        lines = body.split("\n")
        title = None
        first = lines[0].strip()
        if first.startswith("# "):
            title = first[2:].strip()
            body_text = "\n".join(lines[1:]).strip()
        elif len(lines) > 1 and len(first) <= 120:
            title = first
            body_text = "\n".join(lines[1:]).strip()
        else:
            body_text = body
        if not body_text:
            body_text, title = title or body, None

        if not include_notes and not is_story:
            continue

        paragraphs = [re.sub(r"[ \t]+", " ", p).strip() for p in re.split(r"\n\s*\n", body_text) if p.strip()]
        changed = n.get("change")
        updated = dt.datetime.fromtimestamp(int(changed), dt.timezone.utc).date().isoformat() if changed and changed.isdigit() else None

        notes_out.append({
            "id": n.get("id"),
            "type": note_type,
            "title": title,
            "is_story": is_story,
            "tags": sorted({t for t in tag_names if t}),
            "words": words,
            "paragraphs": paragraphs,
            "people": subj_people,
            "places": subj_places,
            "updated": updated,
        })
        for pid in subj_people:
            people[pid]["notes"].append(n.get("id"))
            if is_story:
                people[pid]["stories"].append(n.get("id"))

    stories = [n for n in notes_out if n["is_story"]]
    home = None
    for pe in root.iter():
        if localname(pe.tag) == "people" and pe.get("home"):
            home = pe.get("home")
    if home not in people or people[home].get("hidden"):
        visible_people = [p for p in people.values() if not p.get("hidden")]
        best = max(visible_people, key=lambda p: len(p["families"]), default=None)
        home = best["id"] if best else next(iter(people), None)

    counts = {
        "people": len(people),
        "hidden_living": sum(1 for p in people.values() if p.get("hidden")),
        "families": len(families),
        "stories": len(stories),
        "notes": len(notes_out),
        "places": len(places),
    }

    data = {
        "schema": "kula.site/1.0",
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source": Path(args.export).name,
        "home": home,
        "counts": counts,
        "people": list(people.values()),
        "families": list(families.values()),
        "notes": notes_out,
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"Wrote {out}")
    print(f"  people: {counts['people']} ({counts['hidden_living']} living hidden)")
    print(f"  families: {counts['families']}")
    print(f"  notes: {counts['notes']} ({counts['stories']} stories)")
    for handle, label, count in redacted:
        print(f"  redacted {count}x '{label}' in story {handle}")
    for handle, label in stories_dropped:
        print(f"  WARNING: story {handle} excluded: mentions living person '{label}'", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
