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
const { relationship, sentenceFor } = await loadModule("assets/relate.js");
const { normalizeGotra, pravaraFor } = await loadModule("assets/vedic.js");

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

test("the Vedic sheet is attached to a person without storing a derived pravara", () => {
  const vedicPeople = tree.people.filter((p) => p.vedic);
  assert.ok(vedicPeople.length >= 1, "at least one person should have Vedic data");
  for (const p of vedicPeople) {
    assert.ok(p.vedic.gotra, `${p.id} Vedic data needs a gotra`);
    assert.equal(p.vedic.pravara, undefined, `${p.id} must not store a pravara; it is derived`);
    const pravara = pravaraFor(p.vedic.gotra, vedic);
    assert.ok(pravara, `${p.vedic.gotra} should resolve to a pravara`);
    assert.ok(pravara.rishis.length >= 2);
  }
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
  assert.ok(branch.cards.length < full.cards.length, "branch view should be smaller than the whole sheet");
  assert.ok(branch.cards.some((c) => c.id === focus), "focus must be in the branch");
  assert.ok(branch.links.every((l) => branch.cards.some((c) => c.id === l.from) &&
    branch.cards.some((c) => c.id === l.to)), "branch edges must stay inside the branch");
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
  for (const key of ["gotra", "pravara", "rashi", "nakshatra"]) {
    assert.ok(vedic.concepts[key]?.text, `concept ${key} needs help text`);
  }
});
