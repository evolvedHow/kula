// 3-ring ancestor pedigree wheel / fan chart.
//
// Uses d3-hierarchy (loaded as a global script) to partition a full binary
// ancestor tree into equal-angle sectors. Each generation occupies one ring:
//   ring 0 = focus person (centre)
//   ring 1 = parents
//   ring 2 = grandparents
//   ring 3 = great-grandparents
//
// Missing ancestors are rendered as dim "Unknown" placeholders so the wheel
// stays balanced and the classic fan-chart shape is preserved.

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

export function layoutWheel(index, focusId, options = {}) {
  if (!d3 || !index.people[focusId]) return null;

  const rings = Math.max(1, Math.min(5, options.rings ?? 3));
  const width = options.width ?? 640;
  const height = options.height ?? 640;
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
    // Text anchor point: pull labels slightly toward the outer edge so they
    // sit comfortably inside the sector.
    const labelR = isCenter ? innerRadius * 0.62 : innerRadius + (d.depth - 0.45) * ringWidth;
    const labelX = Math.cos(midAngle - Math.PI / 2) * labelR;
    const labelY = Math.sin(midAngle - Math.PI / 2) * labelR;
    // For ring 1+ we rotate text to follow the arc; keep it upright when possible.
    let rotate = 0;
    let textAnchor = "middle";
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
      textAnchor,
      span,
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

    // Tone accent on the outer rim for non-focus sectors.
    if (!s.unknown && s.depth > 0) {
      const rim = document.createElementNS(ns, "path");
      rim.setAttribute("d", s.d);
      rim.setAttribute("fill", "none");
      rim.setAttribute("stroke", s.tone);
      rim.setAttribute("stroke-width", "4");
      rim.setAttribute("class", "wheel-rim");
      g.appendChild(rim);
    }

    const text = document.createElementNS(ns, "text");
    text.setAttribute("x", s.labelX);
    text.setAttribute("y", s.labelY);
    text.setAttribute("text-anchor", s.textAnchor);
    text.setAttribute("dominant-baseline", "middle");
    text.setAttribute("transform", s.depth > 0 ? `rotate(${s.rotate}, ${s.labelX}, ${s.labelY})` : "");

    // Hide long names on very thin sectors; keep initials. In the centre,
    // prefer initials when the full name would overflow the small circle.
    const showFull = s.span > 0.12 && !(s.center && s.name.length > 14);
    const tspanName = document.createElementNS(ns, "tspan");
    tspanName.textContent = showFull ? s.name : s.initials;
    tspanName.setAttribute("x", s.labelX);
    tspanName.setAttribute("dy", s.years ? "-0.55em" : "0");
    text.appendChild(tspanName);

    if (s.years && (showFull || s.depth === 0)) {
      const tspanYears = document.createElementNS(ns, "tspan");
      tspanYears.textContent = s.years;
      tspanYears.setAttribute("x", s.labelX);
      tspanYears.setAttribute("dy", "1.15em");
      tspanYears.setAttribute("class", "wheel-years");
      text.appendChild(tspanYears);
    }

    g.appendChild(text);
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
