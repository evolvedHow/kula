// Pure graph geometry for the "Relatives" view.
//
// The sheet is modelled as a graph with two node kinds:
//   person  a person card
//   union   a marriage/partnership node
// Edges are "partner" (person -> union) and "offspring" (union -> person).
// This module only computes positions and connector anchors; it touches no DOM.

const min = Math.min;
const max = Math.max;

function transposeLayout(layout, unionSize) {
  return {
    graph: true,
    width: layout.height,
    height: layout.width,
    focus: { x: layout.focus.y, y: layout.focus.x },
    cards: layout.cards.map((c) => ({
      ...c,
      x: c.y,
      y: c.x,
      w: c.h,
      h: c.w,
      // Union nodes stay square, so a simple swap is enough.
      ...(c.kind === "union" ? { x: c.y, y: c.x, w: unionSize, h: unionSize } : {}),
    })),
    links: layout.links.map((l) => ({
      ...l,
      horizontal: true,
      sx: l.sy,
      sy: l.sx,
      tx: l.ty,
      ty: l.tx,
    })),
  };
}

export function layoutGraph(graph, focusId, options = {}) {
  const allNodes = graph?.nodes || [];
  const allEdges = graph?.edges || [];
  if (!allNodes.length) return null;

  const allById = Object.fromEntries(allNodes.map((n) => [n.id, n]));
  const selected = allById[focusId] || allNodes.find((n) => n.type === "person") || allNodes[0];

  // By default show the connected family branch around the focus. The full
  // sheet can contain many unrelated branches; drawing all of them makes one
  // very wide row. Pass all: true to render the whole graph.
  let keep = null;
  if (!options.all) {
    keep = new Set([selected.id]);
    const queue = [selected.id];
    const adjacency = new Map(allNodes.map((n) => [n.id, []]));
    for (const e of allEdges) {
      if (!allById[e.from] || !allById[e.to]) continue;
      adjacency.get(e.from).push(e.to);
      adjacency.get(e.to).push(e.from);
    }
    while (queue.length) {
      const id = queue.pop();
      for (const next of adjacency.get(id) || []) {
        if (keep.has(next)) continue;
        keep.add(next);
        queue.push(next);
      }
    }
  }

  const nodes = keep ? allNodes.filter((n) => keep.has(n.id)) : allNodes;
  const edges = (keep ? allEdges.filter((e) => keep.has(e.from) && keep.has(e.to)) : allEdges);
  if (!nodes.length) return null;

  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const focus = byId[selected.id] || nodes.find((n) => n.type === "person") || nodes[0];
  const horizontal = options.orientation === "horizontal";
  const cardW = options.cardW ?? 188;
  const cardH = options.cardH ?? 84;
  const unionSize = options.unionSize ?? 44;
  const gapX = options.gapX ?? 40;
  const gapY = options.gapY ?? 94;
  // When horizontal, generations run left-to-right, so lay out with the card
  // dimensions transposed and rotate the result at the end.
  const cw = horizontal ? cardH : cardW;
  const ch = horizontal ? cardW : cardH;
  const uw = unionSize;

  const neighbours = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (!byId[e.from] || !byId[e.to]) continue;
    neighbours.get(e.from).push(e);
    neighbours.get(e.to).push(e);
  }

  // --- Generations -------------------------------------------------------
  // Partner edges keep both ends on the same row. Offspring edges always put
  // the child one row below the union. Repeated relaxation handles multiple
  // parents and many disconnected branches.
  const gen = new Map(nodes.map((n) => [n.id, 0]));
  const rounds = Math.min(nodes.length + 2, 400);
  for (let i = 0; i < rounds; i += 1) {
    let changed = false;
    for (const e of edges) {
      if (!byId[e.from] || !byId[e.to]) continue;
      if (e.type === "offspring") {
        const want = gen.get(e.from) + 1;
        if (gen.get(e.to) < want) {
          gen.set(e.to, want);
          changed = true;
        }
      } else {
        const want = max(gen.get(e.from), gen.get(e.to));
        if (gen.get(e.from) !== want) {
          gen.set(e.from, want);
          changed = true;
        }
        if (gen.get(e.to) !== want) {
          gen.set(e.to, want);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  const minGen = min(...gen.values());
  for (const [id, g] of gen) gen.set(id, g - minGen);
  const maxGen = max(...gen.values());

  // --- Ordering within each row -----------------------------------------
  const rows = [];
  for (let g = 0; g <= maxGen; g += 1) rows.push([]);
  // Start with people, then place each union next to its partners so the
  // first pass already looks like a family chart.
  for (const n of nodes) if (n.type === "person") rows[gen.get(n.id)].push(n);
  const rowIndex = new Map();
  for (const row of rows) {
    row.forEach((n, i) => rowIndex.set(n.id, i));
  }
  for (const n of nodes) {
    if (n.type !== "union") continue;
    const partners = neighbours.get(n.id)
      .filter((e) => e.type === "partner")
      .map((e) => (e.from === n.id ? e.to : e.from))
      .filter((id) => byId[id]?.type === "person" && gen.get(id) === gen.get(n.id));
    const row = rows[gen.get(n.id)];
    let at = row.length;
    if (partners.length) {
      at = partners.reduce((sum, id) => sum + (rowIndex.get(id) ?? 0), 0) / partners.length + 0.5;
    }
    at = Math.round(Math.max(0, Math.min(row.length, at)));
    row.splice(at, 0, n);
    row.forEach((node, i) => rowIndex.set(node.id, i));
  }

  const order = () => {
    for (const row of rows) row.forEach((n, i) => rowIndex.set(n.id, i));
  };

  // A few barycentre passes pull parents above their children and partners
  // close to their union. Sorting by a numeric key keeps this deterministic.
  for (let pass = 0; pass < 8; pass += 1) {
    for (const row of rows) {
      for (const n of row) {
        const links = neighbours.get(n.id);
        const nearby = links
          .map((e) => (e.from === n.id ? e.to : e.from))
          .filter((id) => id !== n.id && Math.abs(gen.get(id) - gen.get(n.id)) <= 1)
          .map((id) => rowIndex.get(id))
          .filter((v) => v != null);
        if (nearby.length) {
          n._order = nearby.reduce((a, v) => a + v, 0) / nearby.length;
        } else if (n.type === "union") {
          const partners = links
            .filter((e) => e.type === "partner")
            .map((e) => (e.from === n.id ? e.to : e.from))
            .map((id) => rowIndex.get(id))
            .filter((v) => v != null);
          n._order = partners.length ? partners.reduce((a, v) => a + v, 0) / partners.length : rowIndex.get(n.id);
        } else {
          n._order = rowIndex.get(n.id);
        }
      }
      row.sort((a, b) => (a._order - b._order) || a.id.localeCompare(b.id));
      row.forEach((n, i) => rowIndex.set(n.id, i));
    }
  }
  for (const row of rows) for (const n of row) delete n._order;

  // --- Coordinates -------------------------------------------------------
  const rowHeights = rows.map((row) => {
    let h = ch;
    for (const n of row) if (n.type === "union") h = max(h, uw);
    return h;
  });
  const rowWidths = rows.map((row) => {
    let w = 0;
    row.forEach((n, i) => {
      w += n.type === "union" ? uw : cw;
      if (i) w += gapX;
    });
    return w;
  });
  const width = rowWidths.length ? max(...rowWidths) : cw;
  const tops = [];
  let y = 0;
  rows.forEach((_, g) => {
    tops.push(y);
    y += rowHeights[g] + gapY;
  });
  const height = max(0, y - gapY);
  const lhs = rows[0]?.[0]?.id;

  const cards = [];
  rows.forEach((row, g) => {
    const offset = (width - rowWidths[g]) / 2;
    let x = offset;
    for (const n of row) {
      if (n.type === "union") {
        cards.push({
          id: n.id,
          kind: "union",
          x,
          y: tops[g] + (rowHeights[g] - uw) / 2,
          w: uw,
          h: uw,
          node: n,
        });
        x += uw + gapX;
      } else {
        cards.push({
          id: n.id,
          kind: "person",
          x,
          y: tops[g],
          w: cw,
          h: ch,
          node: n,
        });
        x += cw + gapX;
      }
    }
  });

  // --- Edges -------------------------------------------------------------
  const cardById = Object.fromEntries(cards.map((c) => [c.id, c]));
  const links = [];
  for (const e of edges) {
    const a = cardById[e.from];
    const b = cardById[e.to];
    if (!a || !b) continue;
    if (e.type === "offspring") {
      // union -> child
      const sx = a.x + a.w / 2;
      const sy = a.y + a.h;
      const tx = b.x + b.w / 2;
      const ty = b.y;
      links.push({ ...e, kind: "offspring", sx, sy, tx, ty });
    } else {
      // person -> union. Start at the side facing the union.
      const acx = a.x + a.w / 2;
      const bcx = b.x + b.w / 2;
      const sx = bcx >= acx ? a.x + a.w : a.x;
      const sy = a.y + a.h / 2;
      const tx = bcx + (acx >= bcx ? b.w / 2 : -b.w / 2);
      const ty = b.y + b.h / 2;
      links.push({ ...e, kind: "partner", sx, sy, tx, ty });
    }
  }

  const focusCard = cardById[focus.id] || cards[0];
  const layout = {
    graph: true,
    width,
    height,
    focus: { x: focusCard.x, y: focusCard.y },
    cards,
    links,
    // Keep this internal hint out of the renderer; tests and debugging use it.
    generations: rows.map((row) => row.map((n) => n.id)),
    lhs,
  };
  return horizontal ? transposeLayout(layout, uw) : layout;
}
