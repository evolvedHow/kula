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
const { relationship, sentenceFor } = await loadModule("assets/relate.js");

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

test("ancestors are labelled by their distance, not as 'self'", () => {
  assert.equal(relationship(index, "I0003", "I0001").label, "father");
  assert.equal(relationship(index, "I0003", "I0000").label, "grandfather");
  assert.equal(relationship(index, "I0005", "I0000").label, "great-grandfather");
  assert.equal(relationship(index, "I0009", "I0000").label, "great-great-great-grandfather");
  assert.equal(relationship(index, "I0000", "I0003").label, "granddaughter");
});

test("descendants, siblings and spouses keep their labels", () => {
  assert.equal(relationship(index, "I0000", "I0001").label, "son");
  assert.equal(relationship(index, "I0000", "I0115").label, "daughter");
  assert.equal(relationship(index, "I0023", "I0005").label, "sister");
  assert.equal(relationship(index, "I0000", "I0000").label, "you");
  assert.equal(sentenceFor(relationship(index, "I0003", "I0000"), "Venkiteswara Iyer", "Rajam Narayanan"),
    "Venkiteswara Iyer is Rajam Narayanan's grandfather");
});

test("tagged stories are attached to the tagged relatives and the story", () => {
  const story = tree.notes.find((n) => n.id === "N0047");
  assert.ok(story?.is_story, "N0047 should be published as a story");
  assert.ok(story.people.includes("I0000"), "N0047 should be tagged to I0000");
  assert.ok(people.I0000.stories.includes("N0047"), "I0000 should list N0047 as a story");
  assert.equal(story.title, "The Patriarch and Matriarch");
});
