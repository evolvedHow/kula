#!/usr/bin/env python3
"""Renumber people and unions with hierarchical generation-based IDs.

This is a cosmetic reorganization that makes the generation level visible in
the ID. It does NOT change the underlying relationships, just the identifiers.

Naming scheme:
  p.A001, p.A002  = Generation 1 (patriarch & matriarch)
  p.B001, p.B002  = Generation 2 (their children)
  p.C001, p.C002  = Generation 3 (grandchildren)
  u.A001          = Union in generation 1
  u.B001          = Union in generation 2

Usage:
  python3 scripts/renumber_hierarchical.py
  python3 scripts/renumber_hierarchical.py --config docs/config.yml --out docs/data/tree-renumbered.json
  python3 scripts/renumber_hierarchical.py --dry-run

The script reads the current tree.json, computes generation levels from
parent_family links, assigns new hierarchical IDs, updates all references
(parent_family, families, children, union partners, offspring edges, notes,
graph nodes/edges), and writes the renumbered tree.

It also outputs a CSV mapping old IDs to new IDs so you can update your
Google Sheet if desired.
"""

import argparse
import json
import sys
from collections import defaultdict, deque
from pathlib import Path


def compute_generations(people, families, root_person=None):
    """BFS DOWN from a root person (or auto-detected roots) to assign generations.
    
    Traces down through families (as parents) to their children, so the
    patriarch/matriarch are generation 0, their children are generation 1, etc.
    
    If root_person is given, start there. Otherwise find the oldest person
    (earliest birth year) with no parent_family.
    """
    by_id = {p["id"]: p for p in people}
    fam_by_id = {f["id"]: f for f in families}
    
    # Find root(s)
    if root_person:
        roots = [root_person] if root_person in by_id else []
    else:
        # Auto-detect: people with no parent_family, preferring earliest birth
        candidates = [p for p in people if not p.get("parent_family")]
        if not candidates:
            # No one has parent_family set (disconnected data), use everyone
            candidates = people
        
        # Sort by birth year (earliest first), then by ID
        def sort_key(p):
            year = p.get("birth", {}).get("year") or 9999
            return (year, p["id"])
        
        candidates.sort(key=sort_key)
        
        # Use the first one as the root, or take the first few if there are
        # multiple patriarch-level people
        roots = [candidates[0]["id"]] if candidates else []
        
        # Also include their spouse if they have a union with no children yet
        if roots:
            root_person = by_id[roots[0]]
            for fid in root_person.get("families", []):
                fam = fam_by_id.get(fid)
                if fam:
                    spouse = fam.get("mother") if fam.get("father") == roots[0] else fam.get("father")
                    if spouse and spouse not in roots:
                        roots.append(spouse)
    
    if not roots:
        print("WARNING: No root person found. Using everyone at generation 0.")
        return {p["id"]: 0 for p in people}
    
    print(f"Starting from root(s): {roots}")
    
    gen = {}
    queue = deque((pid, 0) for pid in roots)
    
    while queue:
        pid, level = queue.popleft()
        if pid in gen:
            continue
        gen[pid] = level
        
        # Trace DOWN: find families where this person is a parent
        person = by_id.get(pid)
        if not person:
            continue
        
        for fid in person.get("families", []):
            fam = fam_by_id.get(fid)
            if not fam:
                continue
            
            # The spouse is also at the same generation
            spouse = fam.get("mother") if fam.get("father") == pid else fam.get("father")
            if spouse and spouse not in gen:
                queue.append((spouse, level))
            
            # Children are one generation down
            for child_id in fam.get("children", []):
                if child_id not in gen:
                    queue.append((child_id, level + 1))
    
    # Anyone not reached gets assigned to generation 0 (disconnected branches)
    for p in people:
        if p["id"] not in gen:
            gen[p["id"]] = 0
    
    return gen


def hierarchical_id(entity_type, generation, sequence):
    """Generate a hierarchical ID.
    
    entity_type: 'p' for person, 'u' for union
    generation: 0-based integer (0=A, 1=B, 2=C, ...)
    sequence: 1-based integer within that generation
    """
    gen_letter = chr(ord('A') + min(generation, 25))  # A-Z, cap at Z
    return f"{entity_type}.{gen_letter}{sequence:03d}"


def renumber(data, dry_run=False):
    """Renumber all people and unions with hierarchical IDs."""
    people = data.get("people", [])
    families = data.get("families", [])
    notes = data.get("notes", [])
    graph = data.get("graph", {})
    
    print(f"Computing generations for {len(people)} people...")
    gen = compute_generations(people, families)
    
    # Group people by generation
    by_gen = defaultdict(list)
    for p in people:
        by_gen[gen[p["id"]]].append(p)
    
    # Sort within each generation by original ID for stable ordering
    for g in by_gen:
        by_gen[g].sort(key=lambda p: p["id"])
    
    # Assign new person IDs
    old_to_new = {}
    sequence = defaultdict(int)
    
    for g in sorted(by_gen.keys()):
        for p in by_gen[g]:
            sequence[g] += 1
            new_id = hierarchical_id("p", g, sequence[g])
            old_to_new[p["id"]] = new_id
    
    print(f"Generated {len(old_to_new)} new person IDs across {len(by_gen)} generations")
    
    # Assign new union IDs (based on the generation of the parents)
    union_map = {}
    union_sequence = defaultdict(int)
    
    for fam in families:
        # Use the generation of the father/mother (they should be same gen)
        parents = [fam.get("father"), fam.get("mother")]
        parent_ids = [p for p in parents if p and p in gen]
        if parent_ids:
            union_gen = gen[parent_ids[0]]
        else:
            union_gen = 0
        
        union_sequence[union_gen] += 1
        new_uid = hierarchical_id("u", union_gen, union_sequence[union_gen])
        union_map[fam["id"]] = new_uid
    
    print(f"Generated {len(union_map)} new union IDs")
    
    if dry_run:
        print("\n=== DRY RUN: Sample ID mappings ===")
        print("Old ID -> New ID (generation)")
        for old_id in sorted(old_to_new.keys())[:20]:
            g = gen.get(old_id, 0)
            print(f"  {old_id:12} -> {old_to_new[old_id]:12} (gen {g})")
        print(f"  ... ({len(old_to_new)} total)")
        print("\nOld Union -> New Union")
        for old_id in sorted(union_map.keys())[:10]:
            print(f"  {old_id:12} -> {union_map[old_id]:12}")
        print(f"  ... ({len(union_map)} total)")
        return None, None
    
    # Update people
    for p in people:
        old_id = p["id"]
        p["id"] = old_to_new[old_id]
        
        # Update parent_family reference
        if p.get("parent_family") and p["parent_family"] in union_map:
            p["parent_family"] = union_map[p["parent_family"]]
        
        # Update families list
        p["families"] = [union_map.get(fid, fid) for fid in p.get("families", [])]
        
        # Update notes/stories references (note IDs point to people)
        # We'll update the notes' people lists separately
        
        # Update attributes if they contain old IDs
        attrs = p.get("attributes", {})
        if "PID" in attrs:
            attrs["PID"] = p["id"]
        if "REF_NAME" in attrs:
            # REF_NAME is like "P049-Sriram", update the PID part
            parts = attrs["REF_NAME"].split("-", 1)
            if len(parts) == 2 and parts[0] in old_to_new:
                attrs["REF_NAME"] = f"{p['id']}-{parts[1]}"
        
        p["ref_name"] = p.get("ref_name", "").replace(old_id, p["id"])
    
    # Update families
    for fam in families:
        old_id = fam["id"]
        fam["id"] = union_map[old_id]
        
        if fam.get("father") and fam["father"] in old_to_new:
            fam["father"] = old_to_new[fam["father"]]
        if fam.get("mother") and fam["mother"] in old_to_new:
            fam["mother"] = old_to_new[fam["mother"]]
        
        fam["children"] = [old_to_new.get(cid, cid) for cid in fam.get("children", [])]
        
        # Update attributes
        attrs = fam.get("attributes", {})
        if "UID" in attrs:
            attrs["UID"] = fam["id"]
        for key in ["PID1", "PID2"]:
            if key in attrs and attrs[key] in old_to_new:
                attrs[key] = old_to_new[attrs[key]]
        
        # Update ref_name
        if fam.get("ref_name"):
            ref = fam["ref_name"]
            for old_id, new_id in old_to_new.items():
                ref = ref.replace(old_id, new_id)
            fam["ref_name"] = ref
    
    # Update notes
    for note in notes:
        note["people"] = [old_to_new.get(pid, pid) for pid in note.get("people", [])]
    
    # Update graph nodes
    if graph and "nodes" in graph:
        for node in graph["nodes"]:
            old_id = node["id"]
            if node.get("type") == "person" and old_id in old_to_new:
                node["id"] = old_to_new[old_id]
                node["person_id"] = old_to_new[old_id]
                # Update ref_name
                if node.get("ref_name"):
                    ref = node["ref_name"]
                    for oid, nid in old_to_new.items():
                        ref = ref.replace(oid, nid)
                    node["ref_name"] = ref
            elif node.get("type") == "union" and old_id in union_map:
                node["id"] = union_map[old_id]
                node["union_id"] = union_map[old_id]
                if node.get("ref_name"):
                    ref = node["ref_name"]
                    for oid, nid in old_to_new.items():
                        ref = ref.replace(oid, nid)
                    node["ref_name"] = ref
    
    # Update graph edges
    if graph and "edges" in graph:
        for edge in graph["edges"]:
            if edge.get("from"):
                if edge["from"] in old_to_new:
                    edge["from"] = old_to_new[edge["from"]]
                elif edge["from"] in union_map:
                    edge["from"] = union_map[edge["from"]]
            
            if edge.get("to"):
                if edge["to"] in old_to_new:
                    edge["to"] = old_to_new[edge["to"]]
                elif edge["to"] in union_map:
                    edge["to"] = union_map[edge["to"]]
    
    # Update home person
    if data.get("home") and data["home"] in old_to_new:
        data["home"] = old_to_new[data["home"]]
    
    print(f"✓ Renumbered {len(people)} people and {len(families)} unions")
    
    # Return mapping for CSV export
    mapping = []
    for old_id in sorted(old_to_new.keys()):
        mapping.append({"old_id": old_id, "new_id": old_to_new[old_id], 
                       "type": "person", "generation": gen.get(old_id, 0)})
    for old_id in sorted(union_map.keys()):
        mapping.append({"old_id": old_id, "new_id": union_map[old_id], "type": "union"})
    
    return data, mapping


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, 
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default="docs/config.yml", 
                   help="Config file (not used currently, reserved)")
    ap.add_argument("--in", dest="input", default="docs/data/tree.json",
                   help="Input tree.json")
    ap.add_argument("--out", default="docs/data/tree-renumbered.json",
                   help="Output renumbered tree.json")
    ap.add_argument("--mapping", default="private/id-mapping.csv",
                   help="CSV mapping old IDs to new IDs")
    ap.add_argument("--root", default=None,
                   help="Root person ID to start generation numbering from (default: auto-detect oldest)")
    ap.add_argument("--dry-run", action="store_true",
                   help="Show what would change without writing anything")
    args = ap.parse_args(argv)
    
    in_path = Path(args.input)
    if not in_path.exists():
        raise SystemExit(f"Input file not found: {in_path}")
    
    print(f"Reading {in_path}...")
    data = json.loads(in_path.read_text(encoding="utf-8"))
    
    # Allow overriding the root person
    if args.root:
        print(f"Using root person: {args.root}")
        # Temporarily inject the root into the compute_generations call
        old_compute = globals()['compute_generations']
        def compute_with_root(people, families):
            return old_compute(people, families, root_person=args.root)
        globals()['compute_generations'] = compute_with_root
    
    result, mapping = renumber(data, dry_run=args.dry_run)
    
    if args.dry_run:
        print("\nDry run complete. No files written.")
        return 0
    
    # Write renumbered tree
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=1), 
                       encoding="utf-8")
    print(f"✓ Wrote {out_path}")
    
    # Write mapping CSV
    if mapping:
        map_path = Path(args.mapping)
        map_path.parent.mkdir(parents=True, exist_ok=True)
        lines = ["old_id,new_id,type,generation"]
        for m in mapping:
            gen = m.get("generation", "")
            lines.append(f"{m['old_id']},{m['new_id']},{m['type']},{gen}")
        map_path.write_text("\n".join(lines), encoding="utf-8")
        print(f"✓ Wrote {map_path} ({len(mapping)} mappings)")
    
    print("\nTo use the renumbered tree:")
    print("  1. Review docs/data/tree-renumbered.json")
    print("  2. Update your Google Sheet PIDs using private/id-mapping.csv")
    print("  3. Copy tree-renumbered.json → tree.json")
    print("  4. Commit and push")
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
