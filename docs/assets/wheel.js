// Ancestor fan chart (pedigree wheel) with a configurable number of rings.
//
// Uses d3-hierarchy (loaded as a global script) to partition a full binary
// ancestor tree into equal-angle sectors. Each generation occupies one ring:
//   ring 0 = focus person (centre)
//   ring 1 = parents
//   ring 2 = grandparents
//   ...  up to 10 rings of ancestors.
//
// Missing ancestors are rendered as dim placeholders so the fan stays
// balanced and the classic fan-chart shape is preserved. Deep rings are
// mostly placeholders, so their labels are dropped; pan and zoom do the
// reading.

const d3 = typeof window !== "undefined" ? window.d3 : null;

function genderTone(p) {
  if (!p || p.hidden) return "var(--other)";
  if (p.gender === "M") return "var(--male)";
  if (p.gender === "F") return "var(--female)";
  return "var(--other)";
}

function yearsText(p) {
  if (!p || p.hidden) return "";
  const b = p.birth?.year;
  const d = p.death?.year;
  if (b && d) return `${b}–${d}`;
  if (b) return String(b);
  if (d) return String(d);
  return "";
}

function displayName(p) {
  return p?.name?.display || "Unknown";
}

function initials(p) {
  if (!p || p.hidden) return "?";
  const words = displayName(p).replace(/[\/()]/g, " ").split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  const first = words[0]?.[0] || "?";
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return (first + last).toUpperCase();
}

// Manual SVG annular-sector path. Avoids pulling in d3-shape just for d3.arc.
function sectorPath(startAngle, endAngle, innerR, outerR) {
  const p = (angle, r) => {
    const a = angle - Math.PI / 2;
    return [Math.cos(a) * r, Math.sin(a) * r];
  };
  const [x0, y0] = p(startAngle, innerR);
  const [x1, y1] = p(endAngle, innerR);
  const [x2, y2] = p(endAngle, outerR);
  const [x3, y3] = p(startAngle, outerR);
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  return `M${x0} ${y0} A${innerR} ${innerR} 0 ${largeArc} 1 ${x1} ${y1} L${x2} ${y2} A${outerR} ${outerR} 0 ${largeArc} 0 ${x3} ${y3} Z`;
}

// Build a full binary ancestor tree of `rings` generations.
// Each node stores the person (or null) and the path [0,1,0,...] where
// 0 = father, 1 = mother so the visual order is consistent.
function ancestorTree(index, focusId, rings) {
  const build = (id, depth, path) => {
    const person = id ? index.people[id] : null;
    const node = { id, person, depth, path, children: [] };
    if (depth >= rings) return node;
    const fam = person?.parent_family ? index.families[person.parent_family] : null;
    const fatherId = fam?.father && index.people[fam.father] ? fam.father : null;
    const motherId = fam?.mother && index.people[fam.mother] ? fam.mother : null;
    node.children.push(build(fatherId, depth + 1, [...path, 0]));
    node.children.push(build(motherId, depth + 1, [...path, 1]));
    return node;
  };
  return build(focusId, 0, []);
}

// Deepest ancestor generation actually present in the data, so the fan can
// size itself to the family instead of drawing rings of empty placeholders.
function knownAncestorDepth(index, focusId, cap) {
  let depth = 0;
  let frontier = [focusId];
  const seen = new Set(frontier);
  while (frontier.length && depth < cap) {
    const next = [];
    for (const id of frontier) {
      const fam = index.people[id]?.parent_family
        ? index.families[index.people[id].parent_family]
        : null;
      for (const pid of [fam?.father, fam?.mother]) {
        if (pid && index.people[pid] && !seen.has(pid)) {
          seen.add(pid);
          next.push(pid);
        }
      }
    }
    if (!next.length) break;
    depth += 1;
    frontier = next;
  }
  return depth;
}

// Label tiers by how much arc a wedge has: full = name + years, name =
// name only, initials when the wedge is thin, none for slivers and missing
// ancestors.
function labelTier(isUnknown, isCenter, arc) {
  if (isUnknown) return "none";
  if (isCenter || arc >= 104) return "full";
  if (arc >= 64) return "name";
  if (arc >= 26) return "initials";
  return "none";
}

export function layoutWheel(index, focusId, options = {}) {
  if (!d3 || !index.people[focusId]) return null;

  // `cap` bounds the automatic ring count; `rings` forces an exact count.
  // Auto = deepest known ancestor + one placeholder ring, at least 4.
  const cap = Math.max(3, Math.min(10, options.cap ?? 7));
  const rings = options.rings
    ? Math.max(2, Math.min(10, options.rings))
    : Math.max(4, Math.min(cap, knownAncestorDepth(index, focusId, cap) + 1));

  const size = 2 * (96 + rings * 46) + 24;
  const width = options.width ?? size;
  const height = options.height ?? size;
  const margin = options.margin ?? 14;

  const radius = Math.min(width, height) / 2 - margin;
  const innerRadius = radius * 0.22;
  const ringWidth = (radius - innerRadius) / rings;

  const rootData = ancestorTree(index, focusId, rings);
  const root = d3
    .hierarchy(rootData)
    .sum(() => 1)
    .sort((a, b) => {
      for (let i = 0; i < Math.max(a.data.path.length, b.data.path.length); i += 1) {
        const av = a.data.path[i] ?? 0;
        const bv = b.data.path[i] ?? 0;
        if (av !== bv) return av - bv;
      }
      return 0;
    });

  d3.partition().size([2 * Math.PI, rings + 1])(root);

  const sectors = root.descendants().map((d) => {
    const p = d.data.person;
    const isUnknown = !p;
    const isCenter = d.depth === 0;
    const span = d.x1 - d.x0;
    const midAngle = (d.x0 + d.x1) / 2;
    const innerR = isCenter ? 0 : innerRadius + (d.depth - 1) * ringWidth;
    const outerR = isCenter ? innerRadius : innerRadius + d.depth * ringWidth;
    // Labels sit mid-ring and run along the spoke. The chord available to a
    // label is roughly span * mid-ring radius.
    const midR = isCenter ? innerRadius * 0.62 : innerRadius + (d.depth - 0.5) * ringWidth;
    const labelX = Math.cos(midAngle - Math.PI / 2) * midR;
    const labelY = Math.sin(midAngle - Math.PI / 2) * midR;
    const arc = span * midR;
    // Radial labels: keep text upright by flipping on the left half.
    let rotate = 0;
    if (!isCenter) {
      let angle = (midAngle * 180) / Math.PI;
      if (angle > 90 && angle < 270) {
        angle += 180;
      }
      rotate = angle - 90;
    }

    const dPath = isCenter
      ? `M0 -${innerRadius} A${innerRadius} ${innerRadius} 0 1 1 0 ${innerRadius} A${innerRadius} ${innerRadius} 0 1 1 0 -${innerRadius} Z`
      : sectorPath(d.x0, d.x1, innerR, outerR);

    return {
      id: d.data.id,
      person: p,
      depth: d.depth,
      path: d.data.path,
      unknown: isUnknown,
      center: isCenter,
      d: dPath,
      startAngle: d.x0,
      endAngle: d.x1,
      innerRadius: innerR,
      outerRadius: outerR,
      labelX,
      labelY,
      rotate,
      textAnchor: "middle",
      span,
      arc,
      label: labelTier(isUnknown, isCenter, arc),
      rim: !isUnknown && !isCenter && arc >= 8,
      tone: genderTone(p),
      name: isUnknown ? "Unknown" : displayName(p),
      initials: isUnknown ? "?" : initials(p),
      years: isUnknown ? "" : yearsText(p),
    };
  });

  return {
    width,
    height,
    radius,
    innerRadius,
    ringWidth,
    rings,
    focus: { x: width / 2, y: height / 2 },
    sectors,
  };
}

export function renderWheelSVG(layout, { onSelect } = {}) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `-${layout.width / 2} -${layout.height / 2} ${layout.width} ${layout.height}`);
  svg.setAttribute("class", "wheel-chart");
  svg.style.width = "100%";
  svg.style.height = "100%";

  const group = document.createElementNS(ns, "g");
  svg.appendChild(group);

  for (const s of layout.sectors) {
    const g = document.createElementNS(ns, "g");
    g.setAttribute("class", `wheel-sector depth-${s.depth}${s.unknown ? " unknown" : ""}`);
    g.setAttribute("data-id", s.id || "");
    g.setAttribute("role", "button");
    g.setAttribute("tabindex", s.unknown ? "-1" : "0");
    g.setAttribute("aria-label", s.name);

    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", s.d);
    path.setAttribute("fill", s.unknown ? "transparent" : "var(--surface)");
    path.setAttribute("stroke", s.unknown ? "var(--line)" : s.tone);
    path.setAttribute("stroke-width", s.depth === 0 ? "2" : "1.5");
    g.appendChild(path);

    // Tone accent on the outer rim for non-focus sectors wide enough to see.
    if (s.rim) {
      const rim = document.createElementNS(ns, "path");
      rim.setAttribute("d", s.d);
      rim.setAttribute("fill", "none");
      rim.setAttribute("stroke", s.tone);
      rim.setAttribute("stroke-width", "4");
      rim.setAttribute("class", "wheel-rim");
      g.appendChild(rim);
    }

    if (s.label !== "none") {
      const text = document.createElementNS(ns, "text");
      text.setAttribute("x", s.labelX);
      text.setAttribute("y", s.labelY);
      text.setAttribute("text-anchor", s.textAnchor);
      text.setAttribute("dominant-baseline", "middle");
      text.setAttribute("transform", s.depth > 0 ? `rotate(${s.rotate}, ${s.labelX}, ${s.labelY})` : "");

      // In the centre, prefer initials when the full name would overflow the
      // small circle. Everywhere, trim very long names so thin wedges do not
      // spill across their neighbours.
      const short = s.label === "initials" || (s.center && s.name.length > 14);
      const labelName = short ? s.initials
        : s.name.length > 26 ? `${s.name.slice(0, 25)}…`
        : s.name;
      const showYears = s.years && s.label === "full";
      const tspanName = document.createElementNS(ns, "tspan");
      tspanName.textContent = labelName;
      tspanName.setAttribute("x", s.labelX);
      tspanName.setAttribute("dy", showYears ? "-0.55em" : "0");
      text.appendChild(tspanName);

      if (showYears) {
        const tspanYears = document.createElementNS(ns, "tspan");
        tspanYears.textContent = s.years;
        tspanYears.setAttribute("x", s.labelX);
        tspanYears.setAttribute("dy", "1.15em");
        tspanYears.setAttribute("class", "wheel-years");
        text.appendChild(tspanYears);
      }

      g.appendChild(text);
    }

    group.appendChild(g);

    if (!s.unknown && onSelect) {
      g.addEventListener("click", (e) => {
        e.stopPropagation();
        onSelect(s.id);
      });
      g.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(s.id);
        }
      });
    }
  }

  return svg;
}
