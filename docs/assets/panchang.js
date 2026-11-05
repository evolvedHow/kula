// Panchangam section: the family's tithi calendar.
//
// The events under data/panchang/ are generated at build time by
// scripts/panchang from docs/data/tree.json — the same Kula database the
// tree views use — so every shraddha, janma nakshatra and festival date here
// is sourced from the family sheet.  The small index.json loads eagerly and
// each year's panchang-<year>.json loads lazily.
//
// Pure helpers are exported so scripts/test_frontend.mjs can run them in Node.

export const KIND_LABELS = {
  shraddha: "Shraddha",
  janma_nakshatra: "Janma nakshatra",
  amavasya: "Amavasya",
  purnima: "Purnima",
  ekadasi: "Ekadasi",
  pradosham: "Pradosham",
  festival: "Festival",
  gregorian_birthday: "Birthday",
  death_anniversary: "Death anniversary",
};

export const KIND_ORDER = [
  "shraddha",
  "janma_nakshatra",
  "amavasya",
  "purnima",
  "festival",
  "ekadasi",
  "pradosham",
  "gregorian_birthday",
  "death_anniversary",
];

// Event kinds that describe a family member and belong on their profile.
export const PERSON_KINDS = new Set([
  "shraddha",
  "janma_nakshatra",
  "gregorian_birthday",
  "death_anniversary",
]);

const KIND_TONES = {
  shraddha: "var(--accent)",
  janma_nakshatra: "var(--female)",
  amavasya: "var(--male)",
  purnima: "var(--male)",
  festival: "var(--other)",
  ekadasi: "var(--other)",
  pradosham: "var(--other)",
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export function kindLabel(kind) {
  return KIND_LABELS[kind] || String(kind || "").replace(/_/g, " ");
}

// Noon keeps the calendar day stable in every viewer timezone; these dates
// are all-day civil dates, not instants.
export function parseDay(iso) {
  return new Date(`${iso}T12:00:00`);
}

export function dayParts(iso) {
  const d = parseDay(iso);
  return { day: d.getDate(), dow: WEEKDAYS[d.getDay()] };
}

export function monthKey(iso) {
  return String(iso || "").slice(0, 7);
}

export function monthLabel(key) {
  const [year, month] = String(key).split("-").map(Number);
  return MONTHS[month - 1] ? `${MONTHS[month - 1]} ${year}` : key;
}

// The short explanation under an event: nakshatra for a janma nakshatra,
// tithi for a shraddha, the masa for panchang-wide days.
export function eventDetail(event) {
  const bits = [];
  if (event.kind === "janma_nakshatra" && event.nakshatra?.name) bits.push(event.nakshatra.name);
  if (event.kind === "shraddha" && event.tithi?.label) bits.push(event.tithi.label);
  if (event.masa?.label && event.kind !== "janma_nakshatra") bits.push(event.masa.label);
  if (event.gotra) bits.push(event.gotra);
  return [...new Set(bits)].join(" · ");
}

export function filterEvents(events, { kind = "", q = "", person = null, personNameFor = () => "" } = {}) {
  const term = q.trim().toLowerCase();
  return events.filter((event) => {
    if (kind && event.kind !== kind) return false;
    if (person && event.person_id !== person) return false;
    if (!term) return true;
    const haystack = [
      event.summary,
      event.person_name,
      personNameFor(event.person_id),
      kindLabel(event.kind),
      event.tithi?.label,
      event.masa?.label,
      event.nakshatra?.name,
      ...(event.festivals || []),
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(term);
  });
}

export function groupByMonth(events) {
  const groups = [];
  let current = null;
  for (const event of [...events].sort((a, b) => a.date.localeCompare(b.date))) {
    const key = monthKey(event.date);
    if (!current || current.key !== key) {
      current = { key, label: monthLabel(key), events: [] };
      groups.push(current);
    }
    current.events.push(event);
  }
  return groups;
}

export function eventRowHTML(event, helpers = {}) {
  const {
    personFor = () => null,
    displayName = (p) => p?.name?.display || "Unnamed",
    yearsText = () => "",
  } = helpers;
  // The display name comes from the tree (the Kula database); the event
  // payload's name is only a fallback for someone not in the published tree.
  const person = event.person_id ? personFor(event.person_id) : null;
  const name = person ? displayName(person) : (event.person_name || "");
  const years = person ? yearsText(person) : "";
  const { day, dow } = dayParts(event.date);
  const detail = eventDetail(event);
  const fests = (event.festivals || []).filter((f) => f !== event.summary);
  const who = person
    ? `<button type="button" class="panchang-who" data-focus="${esc(event.person_id)}">${esc(name)}</button>`
    : `<span class="panchang-who plain">${esc(name || event.summary)}</span>`;
  return `<div class="panchang-row kind-${esc(event.kind)}">
    <span class="panchang-date"><strong>${day}</strong><span>${esc(dow)}</span></span>
    <span class="panchang-main">
      <span class="panchang-title">${who}${years ? ` <span class="muted">${esc(years)}</span>` : ""}</span>
      ${detail ? `<span class="panchang-detail">${esc(detail)}</span>` : ""}
      ${fests.length ? `<span class="panchang-fests">${fests.map((f) => `<span class="panchang-fest">${esc(f)}</span>`).join("")}</span>` : ""}
    </span>
    <span class="panchang-kind" style="--ktone:${KIND_TONES[event.kind] || "var(--line)"}">${esc(kindLabel(event.kind))}</span>
  </div>`;
}

export function listHTML(events, helpers = {}) {
  if (!events.length) return `<p class="note-count">No tithis match these filters.</p>`;
  const parts = [];
  for (const group of groupByMonth(events)) {
    parts.push(`<div class="group-label">${esc(group.label)}</div>`);
    for (const event of group.events) parts.push(eventRowHTML(event, helpers));
  }
  return parts.join("");
}

/**
 * Load and hold the panchang event data.  The browser wires the returned
 * object to the Tithis section; tests exercise the pure helpers above.
 *
 * deps: { fetchJson, personFor, displayName, yearsText, formatDate, today }
 */
export function createPanchang(deps) {
  const eventsByYear = new Map();
  const inflight = new Map();
  const state = { year: null, kind: "", q: "", person: null };
  let index = null;

  const helpers = {
    personFor: deps.personFor,
    displayName: deps.displayName,
    yearsText: deps.yearsText,
  };

  function useIndex(payload) {
    index = payload && Array.isArray(payload.years) && payload.years.length ? payload : null;
    if (index) {
      const now = (deps.today ? deps.today() : new Date()).getFullYear();
      state.year = index.years.includes(now)
        ? now
        : (index.years.find((y) => y >= now) ?? index.years[index.years.length - 1]);
    }
    return index;
  }

  function years() {
    return index?.years || [];
  }

  function yearJsonFile(year) {
    return index?.per_year?.[String(year)]?.json || `panchang-${year}.json`;
  }

  async function ensureYear(year) {
    if (eventsByYear.has(year)) return eventsByYear.get(year);
    if (!inflight.has(year)) {
      inflight.set(year, Promise.resolve(deps.fetchJson(`data/panchang/${yearJsonFile(year)}`))
        .then((payload) => eventsByYear.set(year, payload?.events || []))
        .catch(() => eventsByYear.set(year, []))
        .finally(() => inflight.delete(year)));
    }
    await inflight.get(year);
    return eventsByYear.get(year);
  }

  async function prefetchAll() {
    await Promise.all(years().map((year) => ensureYear(year)));
  }

  function personNameFor(pid) {
    const person = pid && deps.personFor(pid);
    return person ? deps.displayName(person) : "";
  }

  // A person filter spans every loaded year; otherwise only the selected year.
  function events() {
    const pool = state.person
      ? [...eventsByYear.values()].flat()
      : (eventsByYear.get(state.year) || []);
    return filterEvents(pool, {
      kind: state.kind,
      q: state.q,
      person: state.person,
      personNameFor,
    });
  }

  function personEvents(pid) {
    return [...eventsByYear.values()].flat()
      .filter((event) => event.person_id === pid && PERSON_KINDS.has(event.kind))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  // The profile-panel block: one row per ritual date found in the loaded years.
  function personRowsHTML(pid) {
    const list = personEvents(pid);
    if (!list.length) return "";
    const formatDate = deps.formatDate || ((iso) => iso);
    return list.map((event) => {
      const detail = [eventDetail(event), ...(event.festivals || [])].filter(Boolean).join(" · ");
      return `<li><span class="k">${esc(kindLabel(event.kind))} ${esc(String(parseDay(event.date).getFullYear()))}</span>
        <span>${esc(formatDate(event.date))}${detail ? ` · ${esc(detail)}` : ""}</span></li>`;
    }).join("");
  }

  function feedUrl() {
    return index?.feed ? `data/panchang/${index.feed}` : null;
  }

  return {
    state,
    helpers,
    get available() { return Boolean(index); },
    get index() { return index; },
    useIndex,
    years,
    ensureYear,
    prefetchAll,
    events,
    personEvents,
    personRowsHTML,
    feedUrl,
  };
}
