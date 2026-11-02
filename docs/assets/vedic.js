// Vedic gotra / pravara helpers. Pure functions so they can be tested in Node.
//
// Pravara is strictly tied to gotra. It is always derived here rather than
// read from stored data, so a typo or stale PRAVARA column cannot disagree
// with the gotra. New gotras belong in docs/data/vedic.json.

export function normalizeGotra(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z]/g, "")
    .replace(/gotra$/, "");
}

function aliasIndex(data) {
  const index = {};
  for (const [key, entry] of Object.entries(data?.gotras || {})) {
    const canonical = normalizeGotra(key);
    const record = { canonical, entry };
    index[canonical] = record;
    index[normalizeGotra(entry.display)] = record;
    for (const alias of entry.aliases || []) index[normalizeGotra(alias)] = record;
  }
  return index;
}

/**
 * Return the pravara for a gotra, or null when the gotra is unknown.
 * Shape: { key, display, rishis, type, label, about, source }
 */
export function pravaraFor(gotra, data) {
  const key = normalizeGotra(gotra);
  if (!key) return null;
  const record = aliasIndex(data)[key];
  if (!record) return null;
  const { canonical, entry } = record;
  const rishis = [...(entry.pravara || [])];
  return {
    key: canonical,
    display: entry.display,
    rishis,
    type: entry.type || "",
    label: `${rishis.join(", ")}${entry.type ? ` (${entry.type})` : ""}`,
    about: entry.about || "",
    source: entry.source || "",
  };
}
