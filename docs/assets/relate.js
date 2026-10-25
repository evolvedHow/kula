// Relationship labels between two people in the tree. Pure functions.

function ancestorDistances(idx, startId) {
  const dist = new Map([[startId, 0]]);
  let frontier = [startId];
  let depth = 0;
  while (frontier.length && depth < 40) {
    depth += 1;
    const next = [];
    for (const id of frontier) {
      const person = idx.people[id];
      const fam = person && person.parent_family ? idx.families[person.parent_family] : null;
      if (!fam) continue;
      for (const parent of [fam.father, fam.mother]) {
        if (parent && !dist.has(parent)) {
          dist.set(parent, depth);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return dist;
}

function greats(n) {
  return "great-".repeat(Math.max(0, n));
}

function ordinal(n) {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th";
  return `${n}${suffix}`;
}

function pick(gender, male, female, neutral) {
  if (gender === "M") return male;
  if (gender === "F") return female;
  return neutral;
}

function describeRelation(a, b, gender) {
  const up = a;
  const down = b;
  if (down === 0) return "self";
  if (up === 0) {
    // b is a descendant of the start person, `down` generations below
    if (down === 1) return pick(gender, "son", "daughter", "child");
    return greats(down - 2) + pick(gender, "grandson", "granddaughter", "grandchild");
  }
  if (down === 0) {
    if (up === 1) return pick(gender, "father", "mother", "parent");
    if (up === 2) return pick(gender, "grandfather", "grandmother", "grandparent");
    return greats(up - 2) + pick(gender, "grandfather", "grandmother", "grandparent");
  }
  return null;
}

export function relationship(idx, meId, otherId) {
  if (!meId || !otherId || !idx.people[meId] || !idx.people[otherId]) return null;
  const gender = idx.people[otherId].gender;
  if (meId === otherId) return { label: "you", kind: "self" };

  const me = idx.people[meId];
  const spouse = (me.families || []).some((fid) => {
    const f = idx.families[fid];
    return f && (f.father === otherId || f.mother === otherId);
  });
  if (spouse) {
    return { label: pick(gender, "husband", "wife", "spouse"), kind: "spouse" };
  }

  const meUp = ancestorDistances(idx, meId);
  const otherUp = ancestorDistances(idx, otherId);

  if (meUp.has(otherId)) {
    return { label: describeRelation(meUp.get(otherId), 0, gender), kind: "ancestor" };
  }
  if (otherUp.has(meId)) {
    return { label: describeRelation(0, otherUp.get(meId), gender), kind: "descendant" };
  }

  let best = null;
  for (const [common, da] of meUp) {
    if (!otherUp.has(common)) continue;
    const db = otherUp.get(common);
    const score = da + db;
    if (!best || score < best.score) best = { da, db, score };
  }
  if (!best) return null;

  const { da, db } = best;
  if (da === 1 && db === 1) {
    return { label: pick(gender, "brother", "sister", "sibling"), kind: "sibling" };
  }
  if (db === 1) {
    return { label: greats(da - 2) + pick(gender, "uncle", "aunt", "aunt or uncle"), kind: "aunt-uncle" };
  }
  if (da === 1) {
    return { label: greats(db - 2) + pick(gender, "nephew", "niece", "nephew or niece"), kind: "nephew-niece" };
  }
  const degree = Math.min(da, db) - 1;
  const removed = Math.abs(da - db);
  const removedText = removed ? ` ${removed === 1 ? "once" : removed === 2 ? "twice" : `${removed} times`} removed` : "";
  return { label: `${ordinal(degree)} cousin${removedText}`, kind: "cousin" };
}

export function sentenceFor(relation, otherName, meName) {
  if (!relation) return null;
  if (relation.kind === "self") return null;
  if (relation.kind === "spouse") return `${otherName} is ${meName ? `${meName}'s` : "a"} ${relation.label}`;
  if (relation.label.endsWith("cousin") || relation.label.includes("cousin ")) {
    return `${otherName} is a ${relation.label} of ${meName || "you"}`;
  }
  return `${otherName} is ${meName ? `${meName}'s` : "your"} ${relation.label}`;
}
