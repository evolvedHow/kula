// Outline ("List") view: the whole family as an indented running list.
//
// The list is rooted at the oldest known ancestor(s) of the focused person,
// not at the focus itself, so opening a grandchild still shows the full family
// from its founder. People are direct descendants; each union is a sibling row
// at the same indent, and the union's children sit one indent deeper.
//
// Rows are returned flat, each carrying a `depth` for indentation. Rendering
// is a plain HTML string so the layout can be tested without a browser.
//
// Branches collapse: a person row keeps a disclosure toggle, and passing their
// id in `options.collapsed` hides their union rows and everything below them.

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function displayName(p) {
  return p?.name?.display || "Unnamed";
}

function yearsText(p) {
  if (!p || p.hidden) return "";
  const b = p.birth?.year;
  const d = p.death?.year;
  if (b && d) return `${b} – ${d}`;
  if (b) return `b. ${b}`;
  if (d) return `d. ${d}`;
  return "";
}

function genderInfo(p) {
  if (!p) return { cls: "other", icon: "·", label: "Gender not recorded" };
  if (p.gender === "M") return { cls: "male", icon: "♂", label: "Male" };
  if (p.gender === "F") return { cls: "female", icon: "♀", label: "Female" };
  return { cls: "other", icon: "·", label: "Gender not recorded" };
}

// Fields that mean the person has recorded Vedic lineage or personal Vedic
// details. `chart` is handled separately because it powers the Jatagam view.
const VEDIC_FIELDS = [
  "gotra", "veda", "shakha", "sutra", "nakshatra", "kula_devatha",
  "sampradaya", "acharya_thirumaligai", "purvikam", "parvata",
];

function vedicMarks(person) {
  const vedic = person?.vedic && typeof person.vedic === "object" ? person.vedic : {};
  const gotra = String(vedic.gotra || "").trim();
  const hasRoots = VEDIC_FIELDS.some((field) => String(vedic[field] || "").trim());
  return { hasRoots, gotra, hasChart: Boolean(vedic.chart) };
}

function marksHTML(person) {
  const marks = vedicMarks(person);
  if (!marks.hasRoots && !marks.hasChart) return "";
  const vedicLabel = `Vedic roots${marks.gotra ? `: ${marks.gotra}` : ""}`;
  const om = marks.hasRoots
    ? `<span class="outline-mark vedic" title="${esc(vedicLabel)}" aria-hidden="true">ॐ</span>`
    : "";
  const chart = marks.hasChart
    ? `<span class="outline-mark jatakam" title="Jatakam available" aria-hidden="true">☉</span>`
    : "";
  return om + chart;
}

function markLabels(person) {
  const marks = vedicMarks(person);
  const labels = [];
  if (marks.hasRoots) labels.push(`Vedic roots${marks.gotra ? `, ${marks.gotra}` : ""}`);
  if (marks.hasChart) labels.push("Jatakam available");
  return labels;
}

function parentIds(index, id) {
  const fam = index.people[id]?.parent_family ? index.families[index.people[id].parent_family] : null;
  return [fam?.father, fam?.mother].filter((pid) => pid && index.people[pid]);
}

function partnerOf(fam, id) {
  if (!fam) return null;
  if (fam.father === id) return fam.mother || null;
  if (fam.mother === id) return fam.father || null;
  return null;
}

function marriageYear(fam) {
  return fam?.marriage?.year ?? 9999;
}

function comparePeople(index, a, b) {
  return (index.people[a]?.birth?.year ?? 9999) - (index.people[b]?.birth?.year ?? 9999)
    || displayName(index.people[a]).localeCompare(displayName(index.people[b]))
    || String(a).localeCompare(String(b));
}

function compareGeneration(index, a, b) {
  return String(index.people[a]?.generation || "").localeCompare(String(index.people[b]?.generation || ""))
    || String(a).localeCompare(String(b));
}

// Every union this person is a partner in that has a spouse or at least one
// recorded child. Ordered by marriage year, then by union id.
function unionsFor(index, id) {
  const person = index.people[id];
  const out = [];
  const seen = new Set();
  for (const fid of person?.families || []) {
    if (seen.has(fid)) continue;
    seen.add(fid);
    const fam = index.families[fid];
    if (!fam || (fam.father !== id && fam.mother !== id)) continue;
    const spouseId = partnerOf(fam, id);
    const spouse = spouseId && index.people[spouseId] ? index.people[spouseId] : null;
    const kids = (fam.children || []).filter((cid) => index.people[cid]);
    if (!spouse && !kids.length) continue;
    out.push({ fam, spouseId: spouse?.id || null });
  }
  out.sort((a, b) => marriageYear(a.fam) - marriageYear(b.fam) || String(a.fam.id).localeCompare(String(b.fam.id)));
  return out;
}

// Walk upward and keep only the deepest ancestor generation reachable from the
// focus. Married-in spouses with no parents of their own are ancestors too,
// but they belong under their partner's line; only the oldest generation is a
// root. Couples share one root group so a founder and their spouse do not
// produce two duplicate trees.
function rootGroups(index, focusId) {
  const depthOf = new Map();
  const stack = [{ id: focusId, depth: 0 }];
  let maxDepth = 0;
  while (stack.length) {
    const { id, depth } = stack.pop();
    if (!index.people[id] || depth > 64) continue;
    if (depthOf.has(id) && depthOf.get(id) >= depth) continue;
    depthOf.set(id, depth);
    const parents = parentIds(index, id);
    if (!parents.length) {
      if (depth > maxDepth) maxDepth = depth;
    } else {
      for (const pid of parents) stack.push({ id: pid, depth: depth + 1 });
    }
  }

  const roots = [...depthOf.entries()]
    .filter(([, depth]) => depth === maxDepth)
    .map(([id]) => id);
  if (!roots.length) roots.push(focusId);

  const ordered = [...roots].sort((a, b) => compareGeneration(index, a, b));
  const groups = [];
  const used = new Set();
  for (const id of ordered) {
    if (used.has(id)) continue;
    const group = [id];
    used.add(id);
    // Pull in a partner who is also an oldest ancestor (no parents of their own).
    for (const { fam } of unionsFor(index, id)) {
      const sid = partnerOf(fam, id);
      if (sid && index.people[sid] && !used.has(sid) && !parentIds(index, sid).length) {
        group.push(sid);
        used.add(sid);
      }
    }
    groups.push(group);
  }

  // Prefer the partner listed as the father, then a male partner, then the
  // lowest id, so a founder couple always reads from the same person.
  const fatherFirst = (a, b) => {
    const aFather = unionsFor(index, a).some(({ fam }) => fam.father === a && fam.mother === b);
    const bFather = unionsFor(index, b).some(({ fam }) => fam.father === b && fam.mother === a);
    if (aFather !== bFather) return aFather ? -1 : 1;
    const aMale = index.people[a]?.gender === "M";
    const bMale = index.people[b]?.gender === "M";
    if (aMale !== bMale) return aMale ? -1 : 1;
    return String(a).localeCompare(String(b));
  };
  for (const group of groups) group.sort(fatherFirst);
  return groups;
}

// Build the flat rows for one root group. `placed` is shared across groups so
// a person reached through two lines (cousins who marry) appears only once.
function buildRows(index, rootId, groups, rows, placed, collapsed) {
  const rootIndex = groups.findIndex((g) => g.includes(rootId));

  const visit = (id, depth, trail, ancestors) => {
    if (!index.people[id] || placed.has(id) || trail.has(id)) return;
    const person = index.people[id];
    const unions = unionsFor(index, id);
    const isCollapsed = collapsed.has(id);
    placed.add(id);
    rows.push({
      kind: "person",
      id,
      key: `p:${id}`,
      personId: id,
      person,
      depth,
      rootIndex,
      isRoot: depth === 0,
      hidden: Boolean(person.hidden),
      generation: String(person.generation || "").trim(),
      ancestors: [...ancestors],
      hasDetails: unions.length > 0,
      collapsed: isCollapsed,
    });

    // A collapsed branch keeps its own row so it stays a visible handle, but
    // none of its unions or descendants are listed.
    if (isCollapsed) return;

    const nextTrail = new Set(trail).add(id);
    const childAncestors = [...ancestors, id];
    for (const { fam, spouseId } of unions) {
      const spouse = spouseId ? index.people[spouseId] : null;
      const kids = (fam.children || []).filter((cid) => index.people[cid]).sort((a, b) => comparePeople(index, a, b));
      rows.push({
        kind: "union",
        id: fam.id,
        key: `u:${fam.id}`,
        familyId: fam.id,
        ownerId: id,
        ownerName: displayName(index.people[id]),
        personId: spouse?.id || null,
        person: spouse,
        depth,
        rootIndex,
        generation: String(index.people[id]?.generation || spouse?.generation || "").trim(),
        ancestors: childAncestors,
        unknown: !spouse,
        marriage: fam.marriage?.year ?? null,
      });

      for (const cid of kids) {
        if (nextTrail.has(cid) || placed.has(cid)) continue;
        visit(cid, depth + 1, nextTrail, childAncestors);
      }
    }
  };

  visit(rootId, 0, new Set(), []);
}

function buildOutlineRows(index, groups, collapsed) {
  const rows = [];
  // Seed the root couples so a spouse cannot reappear lower down as a
  // descendant of their own partnership.
  const placed = new Set();
  for (const group of groups) for (const id of group) placed.add(id);

  for (const group of groups) {
    const rootId = group[0];
    placed.delete(rootId);
    buildRows(index, rootId, groups, rows, placed, collapsed);
  }
  return rows;
}

function uniquePeople(rows) {
  return new Set(rows.map((row) => row.personId).filter(Boolean)).size;
}

function maxDepth(rows) {
  return rows.reduce((max, row) => Math.max(max, row.depth), 0);
}

export function layoutOutline(index, focusId, options = {}) {
  if (!index?.people?.[focusId]) return null;

  const groups = rootGroups(index, focusId);
  if (!groups.length) return null;

  const collapsed = new Set(options.collapsed || []);
  const rows = buildOutlineRows(index, groups, collapsed);
  // The totals describe the whole family, not just the expanded branches, so
  // the header does not appear to lose people when a branch is collapsed.
  const allRows = collapsed.size ? buildOutlineRows(index, groups, new Set()) : rows;

  return {
    focusId,
    rows,
    roots: groups.map((group) => ({
      id: group[0],
      people: group.map((id) => index.people[id]).filter(Boolean),
    })),
    people: uniquePeople(allRows),
    visiblePeople: uniquePeople(rows),
    generations: maxDepth(allRows) + 1,
    collapsed: [...collapsed],
  };
}

function personPill(row) {
  const p = row.person;
  const g = genderInfo(p);
  const years = yearsText(p);
  const marks = marksHTML(p);
  const labels = markLabels(p);
  const cls = ["outline-row", "outline-person"];
  if (row.isRoot) cls.push("is-root");
  if (row.hidden) cls.push("is-living");
  if (row.collapsed) cls.push("is-collapsed");
  const toggle = row.hasDetails
    ? `<button class="outline-toggle" type="button" data-toggle-person="${esc(row.personId)}"
        aria-expanded="${row.collapsed ? "false" : "true"}"
        aria-label="${row.collapsed ? "Expand" : "Collapse"} ${esc(displayName(p))} family">${row.collapsed ? "▸" : "▾"}</button>`
    : `<span class="outline-toggle-spacer" aria-hidden="true"></span>`;
  const label = [
    displayName(p),
    g.label,
    years,
    ...labels,
  ].filter(Boolean).join(", ");
  return `<div class="${cls.join(" ")}" style="--depth:${row.depth}" data-person="${esc(row.personId)}"
    data-row-key="${esc(row.key)}" data-generation="${esc(row.generation)}"
    data-ancestors="${esc(row.ancestors.join(" "))}">
  <span class="outline-guides" aria-hidden="true"></span>
  ${toggle}
  <button class="outline-pill" type="button" data-person="${esc(row.personId)}" aria-label="${esc(label)}">
    <span class="outline-dot" aria-hidden="true"></span>
    <span class="outline-gender ${g.cls}" title="${esc(g.label)}" aria-hidden="true">${g.icon}</span>
    <span class="outline-id" aria-hidden="true">${esc(row.personId)}</span>
    <span class="outline-name">${esc(displayName(p))}</span>
    ${years ? `<span class="outline-years">${esc(years)}</span>` : ""}
    ${marks}
  </button>
</div>`;
}

function unionPill(row) {
  const p = row.person;
  const cls = ["outline-row", "outline-union"];
  const pillCls = ["outline-pill", "union"];
  if (!p) pillCls.push("is-unknown");
  const marriage = row.marriage ? `<span class="outline-years">m. ${esc(row.marriage)}</span>` : "";
  const body = p
    ? (() => {
      const g = genderInfo(p);
      const years = yearsText(p);
      return `<span class="outline-gender ${g.cls}" title="${esc(g.label)}" aria-hidden="true">${g.icon}</span>
        <span class="outline-id" aria-hidden="true">${esc(p.id)}</span>
        <span class="outline-name">${esc(displayName(p))}</span>
        ${years ? `<span class="outline-years">${esc(years)}</span>` : ""}
        ${marksHTML(p)}`;
    })()
    : `<span class="outline-name is-unknown">Partner not recorded</span>`;

  const owner = row.ownerName || "partner";
  const tag = p ? "button" : "div";
  const attrs = p ? `type="button" data-person="${esc(p.id)}"` : "";
  const labels = p ? markLabels(p) : [];
  const label = p
    ? [displayName(p), `spouse of ${owner}`, ...labels].filter(Boolean).join(", ")
    : "Partner not recorded";
  return `<div class="${cls.join(" ")}" style="--depth:${row.depth}"${p ? ` data-person="${esc(p.id)}"` : ""} data-family="${esc(row.familyId)}"
    data-row-key="${esc(row.key)}" data-generation="${esc(row.generation)}"
    data-ancestors="${esc(row.ancestors.join(" "))}">
  <span class="outline-guides" aria-hidden="true"></span>
  <span class="outline-toggle-spacer" aria-hidden="true"></span>
  <${tag} class="${pillCls.join(" ")}" ${attrs} aria-label="${esc(label)}">
    <span class="outline-dot" aria-hidden="true"></span>
    <span class="outline-union-icon" aria-hidden="true">⚭</span>
    ${body}
    ${marriage}
  </${tag}>
</div>`;
}

export function outlineHTML(layout) {
  if (!layout || !layout.rows.length) return "";
  const rootNames = layout.roots
    .map((root) => root.people.map(displayName).join(" & "))
    .join(" · ");
  const kicker = layout.roots.length > 1 ? "Oldest known ancestors" : "Oldest known ancestor";
  const total = layout.people ?? layout.visiblePeople;
  const visible = layout.visiblePeople ?? total;
  const count = visible < total
    ? `${visible} of ${total} people · ${layout.generations} generations`
    : `${total} people · ${layout.generations} generations`;
  const head = `<div class="outline-head">
    <span class="outline-kicker">${kicker}</span>
    <span class="outline-root">${esc(rootNames)}</span>
    <span class="outline-count">${count}</span>
    <div class="outline-actions">
      <span class="outline-legend" aria-hidden="true">
        <span class="outline-mark vedic" title="Vedic roots">ॐ</span>
        <span class="outline-legend-label">Vedic</span>
        <span class="outline-mark jatakam" title="Jatakam available">☉</span>
        <span class="outline-legend-label">Jatakam</span>
      </span>
      <button class="outline-action" type="button" data-list-action="expand">Expand all</button>
      <button class="outline-action" type="button" data-list-action="collapse">Collapse all</button>
    </div>
  </div>`;

  let previousRoot = null;
  const body = layout.rows.map((row) => {
    const divider = previousRoot !== null && row.rootIndex !== previousRoot && row.kind === "person"
      ? `<div class="outline-divider" aria-hidden="true"></div>`
      : "";
    previousRoot = row.rootIndex;
    return divider + (row.kind === "union" ? unionPill(row) : personPill(row));
  }).join("");

  return `<div class="outline-inner">${head}<div class="outline-list">${body}</div></div>`;
}
