// Pure tree geometry with explicit union nodes. No DOM access, so it can be
// tested outside the browser.
//
// A "block" is a sub-tree laid out in its own coordinate space, with its
// cards at (x, y) top-left and its connector links at absolute points inside
// that space. Blocks are composed by translating them into place.

const min = Math.min;
const max = Math.max;

function leaf(id, cw, ch, more) {
  return {
    w: cw,
    h: ch,
    rootCx: cw / 2,
    cards: [{ id, x: 0, y: 0, kind: "person", ...(more ? { more } : {}) }],
    links: [],
  };
}

function translateInto(block, dx, dy, out) {
  for (const c of block.cards) out.cards.push({ ...c, x: c.x + dx, y: c.y + dy });
  for (const l of block.links) {
    out.links.push({
      ...l,
      sx: l.sx.map((v) => v + dx),
      sy: l.sy + dy,
      tx: l.tx.map((v) => v + dx),
      ty: l.ty + dy,
    });
  }
}

function shiftOut(out, dx) {
  for (const c of out.cards) c.x += dx;
  for (const l of out.links) {
    l.sx = l.sx.map((v) => v + dx);
    l.tx = l.tx.map((v) => v + dx);
  }
}

// Turn a top-to-bottom layout into a left-to-right one. The layout is first
// computed with the card dimensions and gaps transposed, so cards keep their
// real width/height after the swap.
function transposeLayout(layout) {
  return {
    width: layout.height,
    height: layout.width,
    focus: { x: layout.focus.y, y: layout.focus.x },
    cards: layout.cards.map((c) => ({ ...c, x: c.y, y: c.x, w: c.h, h: c.w })),
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

function uniqueValues(arr) {
  return [...new Set(arr)];
}

// ---- Ancestors: parents above, union between parents and child ------------

function ancestorBlock(pid, depth, ctx) {
  const { cw, ch, gx, gy, uSize, idx } = ctx;
  const person = idx.people[pid];
  const fam = person && person.parent_family ? idx.families[person.parent_family] : null;
  const parentIds = fam ? [fam.father, fam.mother].filter((id) => id && idx.people[id]) : [];
  if (!parentIds.length) return leaf(pid, cw, ch);
  if (depth <= 0) return leaf(pid, cw, ch, parentIds.length);

  const blocks = parentIds.map((id) => ancestorBlock(id, depth - 1, ctx));
  const hp = Math.max(...blocks.map((b) => b.h));
  const placed = [];
  let x = 0;
  for (const b of blocks) {
    placed.push({ b, x, y: hp - b.h });
    x += b.w + gx;
  }
  const parentCx = placed.map((p) => p.x + p.b.rootCx);
  const rootCx = parentCx.reduce((a, v) => a + v, 0) / parentCx.length;

  const out = { cards: [], links: [] };
  let minX = rootCx - cw / 2;
  let maxX = rootCx + cw / 2;
  for (const p of placed) {
    translateInto(p.b, p.x, p.y, out);
    minX = min(minX, p.x);
    maxX = max(maxX, p.x + p.b.w);
  }

  const unionY = hp + gy * 0.25;
  out.cards.push({
    id: fam.id,
    kind: "union",
    x: rootCx - uSize / 2,
    y: unionY,
    w: uSize,
    h: uSize,
  });
  out.cards.push({ id: pid, kind: "person", x: rootCx - cw / 2, y: hp + gy });
  out.links.push({
    kind: "partner",
    sx: uniqueValues(parentCx),
    sy: hp,
    tx: [rootCx],
    ty: unionY + uSize / 2,
  });
  out.links.push({
    kind: "offspring",
    sx: [rootCx],
    sy: unionY + uSize,
    tx: [rootCx],
    ty: hp + gy,
  });

  shiftOut(out, -minX);
  return { w: maxX - minX, h: hp + gy + ch, rootCx: rootCx - minX, cards: out.cards, links: out.links };
}

// ---- Descendants: partners beside the person, union node below, children below ----

function familySlots(personId, ctx, slots) {
  const { idx } = ctx;
  const person = idx.people[personId];
  for (const fid of person.families || []) {
    const fam = idx.families[fid];
    if (!fam || ctx.seenFam.has(fid)) continue;
    ctx.seenFam.add(fid);
    const other = fam.father === personId ? fam.mother : fam.mother === personId ? fam.father : fam.father || fam.mother;
    const otherId = other && idx.people[other] && !ctx.seenPeople.has(other) ? other : null;
    if (otherId) ctx.seenPeople.add(otherId);
    slots.push({ id: otherId, fam, owner: personId });
    if (otherId) familySlots(otherId, ctx, slots);
  }
}

function descendantBlock(pid, depth, ctx) {
  const { cw, ch, gx, gy, uSize, idx } = ctx;
  const person = idx.people[pid];
  ctx.seenPeople.add(pid);

  const slots = [{ id: pid, owner: null, fam: null }];
  if (depth > 0) familySlots(pid, ctx, slots);
  const more = depth > 0 ? 0 : (person.families || []).reduce((n, fid) => n + (idx.families[fid]?.children.length || 0), 0);

  const regions = new Map();
  let cursor = 0;
  slots.forEach((s, i) => {
    if (!s.fam) return;
    const kidIds = s.fam.children.filter((c) => idx.people[c] && !ctx.seenPeople.has(c));
    const blocks = kidIds.map((c) => descendantBlock(c, depth - 1, ctx));
    const childrenW = blocks.reduce((a, b) => a + b.w, 0) + gx * Math.max(0, blocks.length - 1);
    const w = Math.max(childrenW, cw, uSize);
    regions.set(i, { left: cursor, w, center: cursor + w / 2, blocks, childrenW });
    cursor += w + gx;
  });

  const cx = new Map();
  if (regions.size) {
    const firstIdx = regions.keys().next().value;
    const first = regions.get(firstIdx);
    cx.set(0, slots[firstIdx].id ? first.center - (cw + gx) : first.center);
    for (const [i, r] of regions) if (slots[i].id) cx.set(i, r.center);
  } else {
    cx.set(0, cw / 2);
  }

  const out = { cards: [], links: [] };
  let minX = Infinity;
  let maxX = -Infinity;
  const addCard = (id, center, extra) => {
    out.cards.push({ id, kind: "person", x: center - cw / 2, y: 0, ...extra });
    minX = min(minX, center - cw / 2);
    maxX = max(maxX, center + cw / 2);
  };
  addCard(pid, cx.get(0), more ? { more } : null);
  slots.forEach((s, i) => {
    if (i > 0 && s.id && cx.has(i)) addCard(s.id, cx.get(i));
  });

  let maxChildH = 0;
  let hasKids = false;
  for (const [i, r] of regions) {
    const s = slots[i];
    const ownerIdx = slots.findIndex((x) => x.id === s.owner);
    const ownerCx = ownerIdx >= 0 ? cx.get(ownerIdx) : undefined;
    const partnerCx = s.id ? cx.get(i) : undefined;
    let sx;
    if (ownerCx !== undefined && partnerCx !== undefined) sx = (ownerCx + partnerCx) / 2;
    else sx = ownerCx ?? partnerCx ?? r.center;

    minX = min(minX, r.left);
    maxX = max(maxX, r.left + r.w);

    const unionY = ch + gy * 0.25;
    out.cards.push({
      id: s.fam.id,
      kind: "union",
      x: sx - uSize / 2,
      y: unionY,
      w: uSize,
      h: uSize,
    });

    const tx = [];
    if (r.blocks.length) {
      hasKids = true;
      let x = r.left + (r.w - r.childrenW) / 2;
      for (const b of r.blocks) {
        translateInto(b, x, ch + gy, out);
        tx.push(x + b.rootCx);
        minX = min(minX, x);
        maxX = max(maxX, x + b.w);
        x += b.w + gx;
        maxChildH = max(maxChildH, b.h);
      }
    }

    const spouseCx = uniqueValues([ownerCx, partnerCx].filter((v) => v != null));
    out.links.push({ kind: "partner", sx: spouseCx, sy: ch, tx: [sx], ty: unionY + uSize / 2 });
    out.links.push({ kind: "offspring", sx: [sx], sy: unionY + uSize, tx, ty: ch + gy });
  }

  const h = ch + (hasKids ? gy + maxChildH : 0);
  const rootCx = cx.get(0);
  const dx = -minX;
  shiftOut(out, dx);
  return { w: maxX - minX, h, rootCx: rootCx + dx, cards: out.cards, links: out.links };
}

// ---- Public API --------------------------------------------------------

export function layoutTree(index, focusId, options = {}) {
  if (!index.people[focusId]) return null;
  const horizontal = options.orientation === "horizontal";
  const cardW = options.cardW ?? 188;
  const cardH = options.cardH ?? 84;
  const cw = horizontal ? cardH : cardW;
  const ch = horizontal ? cardW : cardH;
  const gx = options.gapX ?? 26;
  const gy = options.gapY ?? 92;
  const uSize = options.unionSize ?? 44;
  const view = options.view ?? "hourglass";
  const up = options.up ?? 4;
  const down = options.down ?? 4;

  const ctx = (extra) => ({
    cw, ch, gx, gy, uSize, idx: index, seenFam: new Set(), seenPeople: new Set(), ...extra,
  });
  const done = (layout) => (horizontal ? transposeLayout(layout) : layout);

  if (view === "ancestors") {
    const a = ancestorBlock(focusId, up, ctx());
    return done({ width: a.w, height: a.h, focus: { x: a.rootCx - cw / 2, y: a.h - ch }, cards: a.cards, links: a.links });
  }
  if (view === "descendants") {
    const d = descendantBlock(focusId, down, ctx());
    return done({ width: d.w, height: d.h, focus: { x: d.rootCx - cw / 2, y: 0 }, cards: d.cards, links: d.links });
  }

  const anc = ancestorBlock(focusId, up, ctx());
  const desc = descendantBlock(focusId, down, ctx());
  const focusTop = anc.h - ch;
  const cards = anc.cards.filter((c) => !(c.id === focusId && Math.abs(c.y - focusTop) < 0.5));
  const links = anc.links.slice();
  const dx = anc.rootCx - desc.rootCx;
  const dy = focusTop;
  const merged = { cards: [], links: [] };
  translateInto(desc, dx, dy, merged);
  cards.push(...merged.cards);
  links.push(...merged.links);

  let minX = Infinity;
  let maxX = -Infinity;
  for (const c of cards) {
    const right = c.x + (c.kind === "union" ? c.w : cw);
    minX = min(minX, c.x);
    maxX = max(maxX, right);
  }
  for (const c of cards) c.x -= minX;
  for (const l of links) {
    l.sx = l.sx.map((v) => v - minX);
    l.tx = l.tx.map((v) => v - minX);
  }
  return done({
    width: maxX - minX,
    height: max(anc.h, dy + desc.h),
    focus: { x: anc.rootCx - minX - cw / 2, y: focusTop },
    cards,
    links,
  });
}
