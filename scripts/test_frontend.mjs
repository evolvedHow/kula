// Front-end regression tests for the pure modules and the built data.
//
// Run with:  node --test scripts/test_frontend.mjs
//
// The browser modules are plain ES modules without imports, so they can be
// loaded through a data: URL without adding a package.json to the site.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = path.resolve(here, "..", "docs");
const read = (p) => fs.readFileSync(path.join(docs, p), "utf8");

async function loadModule(relativePath) {
  const source = read(relativePath);
  const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  return import(url);
}

const { layoutTree } = await loadModule("assets/layout.js");
const { layoutGraph } = await loadModule("assets/graph.js");
const { layoutOutline, outlineHTML } = await loadModule("assets/list.js");
const { relationship, sentenceFor } = await loadModule("assets/relate.js");
const { normalizeGotra, pravaraFor } = await loadModule("assets/vedic.js");
const { RASI_BOXES, GRAHA_ORDER, degText, renderSouthIndianChart, renderChartReport, renderJatagam } =
  await loadModule("assets/chart.js");

const vedic = JSON.parse(read("data/vedic.json"));

const tree = JSON.parse(read("data/tree.json"));
const people = Object.fromEntries(tree.people.map((p) => [p.id, p]));
const families = Object.fromEntries(tree.families.map((f) => [f.id, f]));
const index = { people, families };

const views = ["hourglass", "ancestors", "descendants"];
const orientations = ["vertical", "horizontal"];
const focus = tree.home || tree.people[0].id;
const layoutFor = (view, orientation) =>
  layoutTree(index, focus, {
    view,
    orientation,
    up: 4,
    down: 4,
    cardW: 188,
    cardH: 84,
    gapX: 26,
    gapY: 92,
  });

test("layout produces finite, unique cards in every view and orientation", () => {
  for (const view of views) {
    for (const orientation of orientations) {
      const layout = layoutFor(view, orientation);
      assert.ok(layout, `${orientation}/${view} should produce a layout`);
      assert.ok(layout.cards.length > 0, `${orientation}/${view} should have cards`);

      const ids = layout.cards.map((c) => c.id);
      assert.equal(new Set(ids).size, ids.length, `${orientation}/${view} has duplicate cards`);

      for (const card of layout.cards) {
        assert.ok(Number.isFinite(card.x) && Number.isFinite(card.y), `${orientation}/${view} card ${card.id} has a bad position`);
        assert.ok(Number.isFinite(layout.focus.x) && Number.isFinite(layout.focus.y), `${orientation}/${view} focus is not finite`);
        assert.ok(layout.width > 0 && layout.height > 0, `${orientation}/${view} has a bad size`);
      }
    }
  }
});

test("layout covers the same relatives in both orientations", () => {
  for (const view of views) {
    const vertical = layoutFor(view, "vertical").cards.map((c) => c.id).sort();
    const horizontal = layoutFor(view, "horizontal").cards.map((c) => c.id).sort();
    assert.deepEqual(horizontal, vertical, `${view} changes which people are drawn when rotated`);
  }
});

test("links match the requested orientation and are all finite", () => {
  for (const view of views) {
    for (const orientation of orientations) {
      const layout = layoutFor(view, orientation);
      for (const link of layout.links) {
        if (orientation === "horizontal") {
          assert.equal(link.horizontal, true, `${view} vertical link leaked into the horizontal layout`);
          assert.ok(Number.isFinite(link.sx) && Number.isFinite(link.tx), `${view} horizontal link bad x`);
          assert.ok(Array.isArray(link.sy) && Array.isArray(link.ty), `${view} horizontal link bad y lists`);
          assert.ok([...link.sy, ...link.ty].every(Number.isFinite), `${view} horizontal link bad y`);
        } else {
          assert.ok(!link.horizontal, `${view} horizontal link leaked into the vertical layout`);
          assert.ok(Array.isArray(link.sx) && Array.isArray(link.tx), `${view} vertical link bad x lists`);
          assert.ok(Number.isFinite(link.sy) && Number.isFinite(link.ty), `${view} vertical link bad y`);
          assert.ok([...link.sx, ...link.tx].every(Number.isFinite), `${view} vertical link bad x`);
        }
      }
    }
  }
});

// A tiny synthetic tree keeps relationship tests independent of any one
// family's data, so the app stays reusable.
const samplePeople = {
  A: { id: "A", gender: "M" },
  B: { id: "B", gender: "F" },
  C: { id: "C", gender: "M", parent_family: "F0" },
  D: { id: "D", gender: "F", parent_family: "F0" },
  E: { id: "E", gender: "M", parent_family: "F1" },
  F: { id: "F", gender: "F", parent_family: "F1" },
  G: { id: "G", gender: "M", parent_family: "F2" },
};
const sampleFamilies = {
  F0: { id: "F0", father: "A", mother: "B", children: ["C", "D"] },
  F1: { id: "F1", father: "C", mother: "D", children: ["E", "F"] },
  F2: { id: "F2", father: "E", mother: null, children: ["G"] },
};
const sampleIndex = { people: samplePeople, families: sampleFamilies };

// A separate branch for collateral kin: two siblings each have a child
// (first cousins); the cousin then has a child and a grandchild.
const cousinPeople = {
  G0: { id: "G0", gender: "M" },
  G1: { id: "G1", gender: "F" },
  P1: { id: "P1", gender: "M", parent_family: "R0" },
  P2: { id: "P2", gender: "F", parent_family: "R0" },
  Q1: { id: "Q1", gender: "F" },
  Q2: { id: "Q2", gender: "M" },
  ME: { id: "ME", gender: "M", parent_family: "R1" },
  COUSIN: { id: "COUSIN", gender: "F", parent_family: "R2" },
  S: { id: "S", gender: "M" },
  T: { id: "T", gender: "M" },
  CHILD: { id: "CHILD", gender: "F", parent_family: "R3" },
  GRAND: { id: "GRAND", gender: "M", parent_family: "R4" },
};
const cousinFamilies = {
  R0: { id: "R0", father: "G0", mother: "G1", children: ["P1", "P2"] },
  R1: { id: "R1", father: "P1", mother: "Q1", children: ["ME"] },
  R2: { id: "R2", father: "Q2", mother: "P2", children: ["COUSIN"] },
  R3: { id: "R3", father: "S", mother: "COUSIN", children: ["CHILD"] },
  R4: { id: "R4", father: "T", mother: "CHILD", children: ["GRAND"] },
};
const cousinIndex = { people: cousinPeople, families: cousinFamilies };

test("ancestors are labelled by their distance, not as 'self'", () => {
  assert.equal(relationship(sampleIndex, "C", "A").label, "father");
  assert.equal(relationship(sampleIndex, "E", "A").label, "grandfather");
  assert.equal(relationship(sampleIndex, "G", "A").label, "great-grandfather");
  assert.equal(relationship(sampleIndex, "A", "D").label, "daughter");
});

test("descendants, siblings and spouses keep their labels", () => {
  assert.equal(relationship(sampleIndex, "A", "C").label, "son");
  assert.equal(relationship(sampleIndex, "A", "E").label, "grandson");
  assert.equal(relationship(sampleIndex, "E", "F").label, "sister");
  assert.equal(relationship(sampleIndex, "E", "C").label, "father");
  assert.equal(relationship(sampleIndex, "A", "A").label, "you");
  assert.equal(sentenceFor(relationship(sampleIndex, "C", "A"), "Parent", "Child"),
    "Parent is Child's father");
});

test("a cousin's child is a niece or nephew, not a removed cousin", () => {
  assert.equal(relationship(cousinIndex, "ME", "COUSIN").label, "1st cousin");
  assert.equal(relationship(cousinIndex, "ME", "CHILD").label, "niece");
  assert.equal(relationship(cousinIndex, "CHILD", "ME").label, "uncle");
  assert.equal(relationship(cousinIndex, "ME", "GRAND").label, "grand-nephew");
  assert.equal(relationship(cousinIndex, "GRAND", "ME").label, "great-uncle");
  assert.equal(sentenceFor(relationship(cousinIndex, "ME", "CHILD"), "Child", "Me"),
    "Child is Me's niece");
});

test("the sheet graph only references people and unions that exist", () => {
  assert.ok(tree.graph, "tree.json should include a graph");
  const nodes = Object.fromEntries(tree.graph.nodes.map((n) => [n.id, n]));
  assert.equal(tree.graph.nodes.length, tree.people.length + tree.families.length);

  for (const person of tree.people) {
    assert.ok(nodes[person.id], `${person.id} is missing a person node`);
    assert.equal(nodes[person.id].type, "person");
    assert.equal(nodes[person.id].person_id, person.id);
    assert.ok(nodes[person.id].ref_name, `${person.id} needs a REF_NAME`);
    assert.equal(typeof nodes[person.id].attributes, "object");
  }
  for (const fam of tree.families) {
    assert.ok(nodes[fam.id], `${fam.id} is missing a union node`);
    assert.equal(nodes[fam.id].type, "union");
    assert.ok(nodes[fam.id].ref_name, `${fam.id} needs a REF_NAME`);
    for (const child of fam.children) {
      assert.ok(people[child], `${fam.id} has unknown child ${child}`);
      assert.notEqual(child, fam.father, `${fam.id} lists a partner as its own child`);
      assert.notEqual(child, fam.mother, `${fam.id} lists a partner as its own child`);
    }
  }

  const edgeIds = tree.graph.edges.map((e) => e.id);
  assert.equal(new Set(edgeIds).size, edgeIds.length, "graph edge IDs should be unique");
  for (const e of tree.graph.edges) {
    assert.ok(nodes[e.from], `edge ${e.id} has unknown from ${e.from}`);
    assert.ok(nodes[e.to], `edge ${e.id} has unknown to ${e.to}`);
    assert.ok(["partner", "offspring"].includes(e.type), `edge ${e.id} has unknown type ${e.type}`);
    assert.equal(typeof e.attributes, "object");
    if (e.type === "partner") {
      assert.equal(nodes[e.from].type, "person");
      assert.equal(nodes[e.to].type, "union");
    } else {
      assert.equal(nodes[e.from].type, "union");
      assert.equal(nodes[e.to].type, "person");
    }
  }

  for (const fam of tree.families) {
    for (const partner of [fam.father, fam.mother].filter(Boolean)) {
      assert.ok(people[partner], `${fam.id} has unknown partner ${partner}`);
      assert.ok(people[partner].families.includes(fam.id), `${partner} should list ${fam.id}`);
    }
  }
});

test("living people publish locations at city level only", () => {
  for (const p of tree.people.filter((x) => x.living)) {
    for (const value of [p.birth?.place, p.current_location].filter(Boolean)) {
      assert.ok(!value.includes(","), `${p.id} leaks a sub-city location: ${value}`);
    }
  }
});

test("partial birth and death records stay safe to render", () => {
  for (const p of tree.people) {
    for (const key of ["birth", "death"]) {
      const record = p[key];
      if (!record) continue;
      assert.ok(record.date || record.place,
        `${p.id} has an empty ${key} object`);
      assert.ok(record.year == null || Number.isInteger(record.year),
        `${p.id} has a non-integer ${key} year`);
      if (record.date) assert.equal(typeof record.date, "string", `${p.id} ${key} date`);
      if (record.place) assert.equal(typeof record.place, "string", `${p.id} ${key} place`);
    }
  }
});

test("the Vedic sheet is attached to a person without storing a derived pravara", () => {
  const vedicPeople = tree.people.filter((p) => p.vedic?.gotra);
  assert.ok(vedicPeople.length >= 1, "at least one person should have Vedic sheet data");
  for (const p of tree.people.filter((p) => p.vedic)) {
    assert.equal(p.vedic.pravara, undefined, `${p.id} must not store a pravara; it is derived`);
  }
  for (const p of vedicPeople) {
    assert.ok(p.vedic.gotra, `${p.id} Vedic data needs a gotra`);
    const pravara = pravaraFor(p.vedic.gotra, vedic);
    assert.ok(pravara, `${p.vedic.gotra} should resolve to a pravara`);
    assert.ok(pravara.rishis.length >= 2);
  }
});

test("the EMAIL attribute is imported and Iyengar fields are supported", () => {
  // EMAIL field (Persons tab) - at least one person may have it, but the
  // field should be preserved in attributes when present
  const withEmail = tree.people.filter((p) => p.attributes?.EMAIL);
  for (const p of withEmail) {
    assert.ok(p.attributes.EMAIL.includes("@"), `${p.id} EMAIL should look like an email`);
  }

  // Iyengar-specific Vedic fields: sampradaya and acharya_thirumaligai
  // should be carried through into person.vedic when present in the sheet
  for (const p of tree.people.filter((x) => x.vedic)) {
    if (p.vedic.sampradaya) {
      assert.equal(typeof p.vedic.sampradaya, "string", `${p.id} sampradaya should be a string`);
    }
    if (p.vedic.acharya_thirumaligai) {
      assert.equal(typeof p.vedic.acharya_thirumaligai, "string", `${p.id} acharya_thirumaligai should be a string`);
    }
  }

  // Concept help must exist for the Iyengar fields so the "i" icons work
  assert.ok(vedic.concepts.sampradaya?.text, "sampradaya needs concept help text");
  assert.ok(vedic.concepts.sampradaya?.title, "sampradaya needs a concept title");
  assert.ok(vedic.concepts.acharya_thirumaligai?.text, "acharya_thirumaligai needs concept help text");
  assert.ok(vedic.concepts.acharya_thirumaligai?.title, "acharya_thirumaligai needs a concept title");
});

test("graph layout keeps cards finite, unique and on whole edges", () => {
  for (const orientation of orientations) {
    const L = layoutGraph(tree.graph, focus, {
      orientation,
      cardW: 188,
      cardH: 84,
      gapX: 40,
      gapY: 94,
    });
    assert.ok(L, `${orientation} graph should produce a layout`);
    assert.ok(L.cards.length > 0);
    const ids = L.cards.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, `${orientation} graph has duplicate cards`);
    for (const card of L.cards) {
      assert.ok(Number.isFinite(card.x) && Number.isFinite(card.y), `${orientation}/${card.id} has a bad position`);
      assert.ok(Number.isFinite(card.w) && card.w > 0, `${orientation}/${card.id} has a bad width`);
      assert.ok(Number.isFinite(card.h) && card.h > 0, `${orientation}/${card.id} has a bad height`);
    }
    assert.ok(Number.isFinite(L.focus.x) && Number.isFinite(L.focus.y));
    assert.ok(L.width > 0 && L.height > 0);
    const byId = Object.fromEntries(L.cards.map((c) => [c.id, c]));
    for (const link of L.links) {
      assert.ok(byId[link.from] && byId[link.to], `${orientation} edge ${link.id} is missing a card`);
      assert.ok([link.sx, link.sy, link.tx, link.ty].every(Number.isFinite), `${orientation} edge ${link.id} has a bad anchor`);
    }
  }
});

test("graph layout focuses the connected family branch", () => {
  const full = layoutGraph(tree.graph, focus, { all: true, orientation: "vertical" });
  const branch = layoutGraph(tree.graph, focus, { orientation: "vertical" });
  assert.equal(full.cards.length, tree.graph.nodes.length);
  assert.ok(branch.cards.length <= full.cards.length, "branch view cannot exceed the whole sheet");
  assert.ok(branch.cards.some((c) => c.id === focus), "focus must be in the branch");
  assert.ok(branch.links.every((l) => branch.cards.some((c) => c.id === l.from) &&
    branch.cards.some((c) => c.id === l.to)), "branch edges must stay inside the branch");

  // A disconnected person must be left out of the branch even when the real
  // family happens to be one fully connected tree.
  const synthetic = {
    nodes: [
      { id: "P1", type: "person" },
      { id: "U1", type: "union" },
      { id: "P2", type: "person" },
      { id: "X1", type: "person" },
    ],
    edges: [
      { id: "E1", type: "partner", from: "P1", to: "U1" },
      { id: "E2", type: "offspring", from: "U1", to: "P2" },
    ],
  };
  const syntheticFull = layoutGraph(synthetic, "P1", { all: true, orientation: "vertical" });
  const syntheticBranch = layoutGraph(synthetic, "P1", { orientation: "vertical" });
  assert.equal(syntheticFull.cards.length, 4);
  assert.equal(syntheticBranch.cards.length, 3);
  assert.ok(!syntheticBranch.cards.some((c) => c.id === "X1"), "unrelated person should be trimmed");
});

// ---------- Indented list layout ----------

function descendantDepth(startId) {
  let depth = 0;
  let frontier = [startId];
  const seen = new Set(frontier);
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      for (const fid of people[id]?.families || []) {
        for (const c of families[fid]?.children || []) {
          if (people[c] && !seen.has(c)) { seen.add(c); next.push(c); }
        }
      }
    }
    if (!next.length) break;
    depth += 1;
    frontier = next;
  }
  return depth;
}

test("the list starts at the oldest known ancestor of the focused person", () => {
  const L = layoutOutline(index, focus);
  assert.ok(L, "list layout should be produced");
  assert.equal(L.rows[0].kind, "person");
  assert.equal(L.rows[0].personId, "A001");
  assert.equal(L.rows[0].depth, 0);
  assert.equal(L.rows[0].isRoot, true);
  assert.ok(L.rows.some((r) => r.kind === "union" && r.personId === "A002" && r.depth === 0),
    "the founding couple's marriage should sit at the root indent");

  const deep = tree.people.find((p) => p.generation === "F" && p.parent_family);
  assert.ok(deep, "fixture should include a generation-F descendant");
  const fromDeep = layoutOutline(index, deep.id);
  assert.equal(fromDeep.rows[0].personId, "A001", "opening a grandchild still roots the list at the founder");
  assert.equal(fromDeep.roots.length, 1, "married-in ancestors must not create extra root blocks");
  assert.deepEqual(fromDeep.roots[0].people.map((p) => p.id), ["A001", "A002"]);
});

test("unions share the person's indent and offspring move one level deeper", () => {
  const L = layoutOutline(index, focus);
  const firstPerson = L.rows[0];
  const firstUnion = L.rows[1];
  assert.equal(firstUnion.kind, "union");
  assert.equal(firstUnion.depth, firstPerson.depth, "a union is a sibling row, not a child");
  const firstChild = L.rows.find((r) => r.kind === "person" && r.isRoot !== true);
  assert.ok(firstChild, "root should have descendants");
  assert.equal(firstChild.depth, 1, "offspring indent once past their parents");
  assert.equal(L.generations, descendantDepth(focus) + 1, "one list level per generation");
});

test("every descendant appears exactly once, including cousins who marry", () => {
  const L = layoutOutline(index, focus);
  const ids = L.rows.filter((r) => r.kind === "person").map((r) => r.personId);
  assert.equal(new Set(ids).size, ids.length, "a person may not have two rows");
  for (const id of ["E011", "E012"]) {
    assert.ok(ids.includes(id), `${id} should still appear under one of its two lines`);
  }
});

test("list rows order siblings by birth year and carry the union's children beneath it", () => {
  const L = layoutOutline(index, focus);
  const rootKids = L.rows.filter((r) => r.kind === "person" && r.depth === 1);
  const years = rootKids.map((r) => r.person.birth?.year ?? 9999);
  assert.deepEqual(years, [...years].sort((a, b) => a - b), "children should read eldest-first");

  const unionIndex = L.rows.findIndex((r) => r.kind === "union" && r.familyId === "U043");
  assert.ok(unionIndex > 0, "the founding union should be in the list");
  assert.equal(L.rows[unionIndex].depth, 0);
  assert.ok(
    L.rows.slice(unionIndex + 1).some((r) => r.kind === "person" && r.depth === 1),
    "U043's children should follow the union row",
  );
});

test("the list renders full-name pill rows with gender icons and both colours", () => {
  const L = layoutOutline(index, focus);
  const html = outlineHTML(L);
  assert.ok(html.includes("outline-pill"), "each person should be a pill");
  assert.ok(html.includes("Venkiteswara Iyer"), "the full root name should be rendered");
  assert.ok(html.includes("♂") && html.includes("♀"), "male and female icons should be rendered");
  assert.ok(html.includes("outline-row outline-union"), "union rows should have their own styling hook");
  assert.ok(html.includes("is-root"), "the oldest ancestor should be marked as the root");
  assert.ok(!html.includes("…"), "names must not be truncated with an ellipsis");
});

test("a person with no parents or children is a single root row", () => {
  const leaf = tree.people.find((p) => !p.parent_family
    && !(p.families || []).some((f) => families[f]?.children?.length));
  assert.ok(leaf, "fixture should include a childless person with no parents");
  const L = layoutOutline(index, leaf.id);
  assert.equal(L.rows[0].personId, leaf.id);
  assert.equal(L.rows.filter((r) => r.kind === "person").length, 1);
});

test("layoutOutline rejects an unknown focus", () => {
  assert.equal(layoutOutline(index, "NOPE"), null);
});

// ---------- Vedic gotra / pravara ----------

test("gotra normalisation ignores case, spacing, punctuation and a trailing 'gotra'", () => {
  assert.equal(normalizeGotra("Bharadwaja Gotra"), "bharadwaja");
  assert.equal(normalizeGotra("  bharad-vaja  "), "bharadvaja");
  assert.equal(normalizeGotra("Srī Vatsa"), "srivatsa");
  assert.equal(normalizeGotra(""), "");
  assert.equal(normalizeGotra(null), "");
});

test("pravara is derived from gotra with the traditional rishis and type", () => {
  const expected = {
    Bharadwaja: {
      rishis: ["Angirasa", "Barhaspatya", "Bharadwaja"],
      type: "Tryarsheya",
    },
    Kashyapa: {
      rishis: ["Kashyapa", "Avatsara", "Naidhruva"],
      type: "Tryarsheya",
    },
    Srivatsa: {
      rishis: ["Bhargava", "Chyavana", "Apnavana", "Aurva", "Jamadagnya"],
      type: "Pancharsheya",
    },
  };

  for (const [gotra, want] of Object.entries(expected)) {
    const result = pravaraFor(gotra, vedic);
    assert.ok(result, `${gotra} should resolve`);
    assert.deepEqual(result.rishis, want.rishis, `${gotra} rishis`);
    assert.equal(result.type, want.type, `${gotra} type`);
    assert.equal(result.display, gotra, `${gotra} display name`);
    assert.ok(result.label.includes(want.rishis.join(", ")), `${gotra} label lists every rishi`);
    assert.ok(result.label.includes(want.type), `${gotra} label includes the type`);
    assert.ok(result.about, `${gotra} should carry a short explanation`);
  }
});

test("gotra aliases resolve to the same pravara, including a trailing 'gotra'", () => {
  assert.equal(pravaraFor("Bharadwaja Gotra", vedic).key, "bharadwaja");
  assert.equal(pravaraFor("Bharadwaj", vedic).key, "bharadwaja");
  assert.equal(pravaraFor("kasyapa", vedic).key, "kashyapa");
  assert.equal(pravaraFor("Shrivatsa", vedic).key, "srivatsa");
  assert.equal(pravaraFor("sreevatsa", vedic).key, "srivatsa");
  assert.deepEqual(pravaraFor("sreevatsa", vedic).rishis, pravaraFor("Srivatsa", vedic).rishis);
});

test("unknown or empty gotras do not invent a pravara", () => {
  assert.equal(pravaraFor("Unknown", vedic), null);
  assert.equal(pravaraFor("", vedic), null);
  assert.equal(pravaraFor(null, vedic), null);
  assert.equal(pravaraFor("Bharadwaja", { gotras: {} }), null);
});

test("every gotra in vedic.json has a well-formed pravara and concept help", () => {
  assert.ok(Object.keys(vedic.gotras).length >= 3);
  for (const [key, entry] of Object.entries(vedic.gotras)) {
    assert.ok(entry.display, `${key} needs a display name`);
    assert.ok(Array.isArray(entry.pravara) && entry.pravara.length >= 2, `${key} needs at least two rishis`);
    assert.ok(entry.pravara.every((r) => typeof r === "string" && r.trim()), `${key} has an empty rishi name`);
    assert.ok(["Tryarsheya", "Pancharsheya", "Dvarsheya"].includes(entry.type), `${key} has an unknown pravara type`);
    assert.ok(vedic.concepts[entry.type.toLowerCase()], `${key} type should have concept help`);
  }
  for (const key of ["gotra", "pravara", "rashi", "nakshatra", "pada", "lagna", "jatagam"]) {
    assert.ok(vedic.concepts[key]?.text, `concept ${key} needs help text`);
  }
});

// ---------- Jatagam (birth chart) ----------

const SAMPLE_CHART = {
  engine: "swisseph-lahiri/test",
  lagna: "Vrishabha",
  lagna_deg: 3.25,
  moon: { rashi: "Tula", nakshatra: "Swati", pada: 4 },
  planets: {
    Su: { name: "Sun", rasi: "Dhanus", deg: 16.52, nakshatra: "Purva Ashadha", pada: 1, retro: false },
    Mo: { name: "Moon", rasi: "Tula", deg: 19.47, nakshatra: "Swati", pada: 4, retro: false },
    Ma: { name: "Mars", rasi: "Kumbha", deg: 4.11, nakshatra: "Dhanishta", pada: 4, retro: false },
    Me: { name: "Mercury", rasi: "Dhanus", deg: 8.04, nakshatra: "Mula", pada: 3, retro: false },
    Ju: { name: "Jupiter", rasi: "Mesha", deg: 1.4, nakshatra: "Ashwini", pada: 1, retro: false },
    Ve: { name: "Venus", rasi: "Vrischika", deg: 7.71, nakshatra: "Anuradha", pada: 2, retro: false },
    Sa: { name: "Saturn", rasi: "Mesha", deg: 16.54, nakshatra: "Bharani", pada: 1, retro: true },
    Ra: { name: "Rahu", rasi: "Kataka", deg: 11.19, nakshatra: "Pushya", pada: 3, retro: true },
    Ke: { name: "Ketu", rasi: "Makara", deg: 11.19, nakshatra: "Shravana", pada: 1, retro: true },
  },
  rasis: {
    Mesha: ["Ju", "Sa"], Vrishabha: ["La"], Dhanus: ["Su", "Me"], Tula: ["Mo"],
    Kumbha: ["Ma"], Vrischika: ["Ve"], Kataka: ["Ra"], Makara: ["Ke"],
  },
};

test("the South Indian chart fixes the twelve rasis to their traditional boxes", () => {
  assert.equal(RASI_BOXES.length, 12);
  const at = (row, col) => RASI_BOXES.find((b) => b.row === row && b.col === col)?.sign;
  assert.equal(at(0, 1), "Mesha");      // top row, second box
  assert.equal(at(0, 0), "Meena");      // top-left corner
  assert.equal(at(0, 3), "Mithuna");    // top-right corner
  assert.equal(at(3, 3), "Kanya");      // bottom-right corner
  assert.equal(at(3, 0), "Dhanus");     // bottom-left corner
  assert.equal(at(3, 2), "Tula");
  assert.equal(at(2, 0), "Makara");
  const signs = new Set(RASI_BOXES.map((b) => b.sign));
  assert.equal(signs.size, 12);
});

test("the chart renderer places grahas in their rasis and marks the lagna", () => {
  const html = renderSouthIndianChart(SAMPLE_CHART, { name: "Test Person", birthText: "1 Jan 2000, 12:00 · Chennai" });
  // Every rasi box appears exactly once with its grid position.
  for (const { sign, row, col } of RASI_BOXES) {
    assert.ok(html.includes(`data-sign="${sign}"`), `${sign} box missing`);
    assert.ok(html.includes(`grid-row:${row + 1}`), `row ${row + 1} missing`);
    assert.ok(html.includes(`grid-column:${col + 1}`), `col ${col + 1} missing`);
  }
  // Sun and Mercury are in Dhanus.
  const box = html.match(/<div class="rasi-box[^"]*"[^>]*data-sign="Dhanus"[\s\S]*?<\/div>/);
  assert.ok(box, "Dhanus box not found");
  assert.ok(box[0].includes("graha-Su"), "Sun should be in Dhanus");
  assert.ok(box[0].includes("graha-Me"), "Mercury should be in Dhanus");
  // Lagna box carries the La chip and the lagna class.
  assert.ok(html.includes('rasi-box lagna'), "lagna box should have the lagna class");
  assert.ok(html.includes(">La<"), "lagna box should contain the La chip");
  // Center panel shows name and lagna.
  assert.ok(html.includes("Test Person"));
  assert.ok(html.includes("Lagna: Vrishabha"));
  // Retrograde graha is marked.
  assert.ok(html.includes('class="retro"'), "retrograde marker missing");
});

test("the report lists lagna plus all nine grahas in traditional order", () => {
  const html = renderChartReport(SAMPLE_CHART, { disclaimer: "Test disclaimer." });
  assert.ok(html.includes("Moon rashi"), "summary missing moon rashi");
  assert.ok(html.includes("Swati"), "summary missing janma nakshatra");
  assert.ok(html.includes("pada 4"), "summary missing pada");
  const bodyRows = [...html.matchAll(/<th scope="row">([^<]+)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(bodyRows, ["Lagna", ...GRAHA_ORDER.map((c) => SAMPLE_CHART.planets[c].name)]);
  assert.ok(html.includes("Retrograde"), "retrograde column should show for Saturn");
  assert.ok(html.includes("Test disclaimer."));
  assert.ok(html.includes("Lahiri"));
});

test("degText renders degrees as deg°min′ and renderJatagam combines grid + report", () => {
  assert.equal(degText(16.52), "16°31′");
  assert.equal(degText(0), "0°00′");
  const html = renderJatagam(SAMPLE_CHART, { name: "X" });
  assert.ok(html.includes('class="jatagam"'));
  assert.ok(html.includes("si-chart"));
  assert.ok(html.includes("chart-report"));
  assert.equal(renderJatagam(null), "");
});

test("chart payloads in tree.json are well formed when present", () => {
  const withCharts = tree.people.filter((p) => p.vedic?.chart);
  for (const p of withCharts) {
    const chart = p.vedic.chart;
    assert.ok(chart.lagna, `${p.id} chart needs a lagna`);
    assert.ok(chart.moon?.rashi && chart.moon?.nakshatra, `${p.id} chart needs moon rashi/nakshatra`);
    assert.ok(chart.moon.pada >= 1 && chart.moon.pada <= 4, `${p.id} moon pada out of range`);
    assert.equal(Object.keys(chart.planets).length, 9, `${p.id} chart needs nine grahas`);
    const ra = chart.planets.Ra, ke = chart.planets.Ke;
    // Zodiacal order for the opposition check, not the South-Indian grid order.
    const zodiac = ["Mesha", "Vrishabha", "Mithuna", "Kataka", "Simha", "Kanya",
                    "Tula", "Vrischika", "Dhanus", "Makara", "Kumbha", "Meena"];
    assert.equal(
      (zodiac.indexOf(ke.rasi) - zodiac.indexOf(ra.rasi) + 12) % 12, 6,
      `${p.id}: Ketu must be opposite Rahu`,
    );
    // Engine-derived vedic fields mirror the chart.
    assert.equal(p.vedic.rashi, chart.moon.rashi, `${p.id} rashi should come from the engine`);
    assert.equal(p.vedic.pada, chart.moon.pada, `${p.id} pada should come from the engine`);
  }
});
