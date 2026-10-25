import { layoutTree } from "./layout.js";
import { relationship, sentenceFor } from "./relate.js";

const DEFAULTS = {
  site: { title: "Family Tree", subtitle: "", intro: "", footer: "", default_person: "home", repo: "" },
  theme: { preset: "", mode: "auto", colors: { light: {}, dark: {} } },
  fonts: { heading: "Georgia", body: "system-ui", load_from_google: false },
  layout: {
    default_view: "hourglass", generations_up: 4, generations_down: 4,
    card_width: 188, card_height: 84, gap_x: 26, gap_y: 92, corner_radius: 18,
    connector_style: "curved", show_years: true, show_places: true, show_child_counts: true,
  },
  narratives: { enabled: true, section_title: "Stories" },
  text: {
    search_placeholder: "Find a family member…", tree_tab: "Tree", people_tab: "Everyone",
    stories_tab: "Stories", set_me: "This is me", view_hourglass: "Both",
    view_ancestors: "Ancestors", view_descendants: "Descendants", read_story: "Read story", back: "Back",
  },
  presets: {},
};

const ME_KEY = "family-tree:me";
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function merge(base, extra) {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return extra ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = base && typeof base[k] === "object" && !Array.isArray(base[k]) && v && typeof v === "object" && !Array.isArray(v)
      ? merge(base[k], v)
      : v;
  }
  return out;
}

let CFG = DEFAULTS;
let DATA = null;
let IDX = null;
const state = { focus: null, view: "hourglass", selected: null, layout: null, k: 1, x: 0, y: 0, meId: null };

const el = {
  viewport: () => $("#viewport"),
  canvas: () => $("#canvas"),
  cards: () => $("#cards"),
  links: () => $("#links"),
  panel: () => $("#panel"),
};

// ---------- Boot ----------

async function boot() {
  const [cfgText, dataRes] = await Promise.all([
    fetch("config.yml", { cache: "no-cache" }).then((r) => (r.ok ? r.text() : "")).catch(() => ""),
    fetch("data/tree.json", { cache: "no-cache" }),
  ]);
  if (!dataRes.ok) throw new Error("Could not load data/tree.json. Run scripts/build_site.py first.");
  const userCfg = cfgText && window.jsyaml ? window.jsyaml.load(cfgText) : {};
  CFG = merge(DEFAULTS, userCfg || {});
  DATA = await dataRes.json();
  IDX = buildIndex(DATA);
  state.meId = localStorage.getItem(ME_KEY);
  if (state.meId && !IDX.people[state.meId]) state.meId = null;
  state.view = CFG.layout.default_view || "hourglass";

  applyTheme();
  applyText();
  bindEvents();
  window.addEventListener("hashchange", route);
  route();
  $("#loading").hidden = true;
  document.querySelector(".app").dataset.view = "ready";
}

function buildIndex(data) {
  const people = {};
  for (const p of data.people) people[p.id] = p;
  const families = {};
  for (const f of data.families) families[f.id] = f;
  const notes = {};
  for (const n of data.notes) notes[n.id] = n;
  const stories = data.notes.filter((n) => n.is_story);
  stories.sort((a, b) => (b.updated || "").localeCompare(a.updated || "") || (a.id < b.id ? -1 : 1));
  return { people, families, notes, stories };
}

function applyTheme() {
  const root = document.documentElement;
  const dark = CFG.theme.mode === "dark" || (CFG.theme.mode !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  const mode = dark ? "dark" : "light";
  root.dataset.mode = mode;
  const preset = CFG.presets?.[CFG.theme.preset] || {};
  const palette = { ...(preset[mode] || {}), ...((CFG.theme.colors || {})[mode] || {}) };
  for (const [key, value] of Object.entries(palette)) {
    root.style.setProperty(`--${key.replace(/_/g, "-")}`, value);
  }
  root.style.setProperty("--font-heading", `"${CFG.fonts.heading}", Georgia, serif`);
  root.style.setProperty("--font-body", `"${CFG.fonts.body}", system-ui, sans-serif`);
  root.style.setProperty("--card-radius", `${CFG.layout.corner_radius}px`);
}

function applyText() {
  const { site, text, narratives } = CFG;
  document.title = site.title;
  $("#site-title").textContent = site.title;
  $("#site-subtitle").textContent = site.subtitle || "";
  $("#search").placeholder = text.search_placeholder;
  $("#tab-tree").textContent = text.tree_tab;
  $("#tab-people").textContent = text.people_tab;
  $("#tab-stories").textContent = narratives.section_title || text.stories_tab;
  $("#tab-stories").hidden = !(narratives.enabled && IDX.stories.length);
  $("#stories-heading").textContent = narratives.section_title || text.stories_tab;
  const views = $$("#view-switch button");
  views[0].textContent = text.view_hourglass;
  views[1].textContent = text.view_ancestors;
  views[2].textContent = text.view_descendants;
  const visible = DATA.people.filter((p) => !p.hidden).length;
  const counts = DATA.counts || {};
  $("#footer").innerHTML = `<span>${esc(site.footer || "")}</span>
    <span class="counts"> · ${visible} people${counts.hidden_living ? ` (${counts.hidden_living} private)` : ""} · ${counts.families} families${IDX.stories.length ? ` · ${IDX.stories.length} stories` : ""}</span>`;
  if (site.intro) $("#people-heading").title = site.intro;
  refreshMeChip();
}

// ---------- Helpers ----------

function displayName(p) {
  return p?.name?.display || "Unnamed";
}

function yearsText(p) {
  if (!CFG.layout.show_years || p.hidden) return "";
  const b = p.birth?.year;
  const d = p.death?.year;
  if (b && d) return `${b} – ${d}`;
  if (b) return `b. ${b}`;
  if (d) return `d. ${d}`;
  return "";
}

function initials(p) {
  if (p.hidden) return "•";
  const words = displayName(p).replace(/[\/()]/g, " ").split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  const first = words[0]?.[0] || "?";
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return (first + last).toUpperCase();
}

function toneVar(gender) {
  if (gender === "M") return "var(--male)";
  if (gender === "F") return "var(--female)";
  return "var(--other)";
}

function partnerOf(fam, id) {
  if (fam.father === id) return fam.mother;
  if (fam.mother === id) return fam.father;
  return null;
}

function nameOf(id) {
  const p = IDX.people[id];
  return p ? displayName(p) : "Unknown";
}

function storyTitle(n) {
  if (n.title) return n.title;
  const names = n.people.map(nameOf).filter(Boolean);
  return names.length ? `Stories of ${names.join(" & ")}` : "Untitled story";
}

function readMinutes(words) {
  return Math.max(1, Math.round((words || 0) / 230));
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(`${iso}T12:00:00`);
  return isNaN(d) ? iso : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function defaultFocus() {
  const wanted = CFG.site.default_person;
  const id = wanted === "home" ? DATA.home : wanted;
  if (id && IDX.people[id]) return id;
  return DATA.people[0]?.id || null;
}

// ---------- Routing ----------

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  return { route: parts[0] || "tree", arg: parts[1] ? decodeURIComponent(parts[1]) : null, params: Object.fromEntries(new URLSearchParams(query)) };
}

function go(route, arg = null, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const hash = `#/${route}${arg ? `/${encodeURIComponent(arg)}` : ""}${qs ? `?${qs}` : ""}`;
  if (location.hash === hash) route_(); else location.hash = hash;
}

function route_() {
  route();
}

function showView(name) {
  for (const id of ["tree", "people", "stories", "story"]) $(`#view-${id}`).hidden = id !== name;
  const tab = name === "story" ? "stories" : name;
  for (const a of $$(".tabs a")) {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  document.body.dataset.route = name;
}

function route() {
  if (!IDX) return;
  const { route: r, arg, params } = parseHash();
  if (r === "people") {
    showView("people");
    renderPeople();
  } else if (r === "stories") {
    showView("stories");
    renderStoriesIndex();
  } else if (r === "story") {
    showView("story");
    renderStory(arg);
  } else {
    showView("tree");
    const focus = arg && IDX.people[arg] ? arg : defaultFocus();
    const view = ["hourglass", "ancestors", "descendants"].includes(params.v) ? params.v : state.view;
    const changed = focus !== state.focus || view !== state.view;
    state.view = view;
    if (changed || !state.layout) {
      renderTree(focus);
      if (focus !== state.selected) {
        state.selected = null;
        if (window.innerWidth > 640) selectPerson(focus, { silent: true });
        else hidePanel();
      }
    }
  }
  if (r === "tree") markSelectedCards();
}

// ---------- Tree ----------

function layoutOptions(view) {
  const L = CFG.layout;
  return {
    view,
    up: L.generations_up,
    down: L.generations_down,
    cardW: L.card_width,
    cardH: L.card_height,
    gapX: L.gap_x,
    gapY: L.gap_y,
  };
}

function renderTree(focusId) {
  const L = layoutTree(IDX, focusId, layoutOptions(state.view));
  if (!L) {
    $("#tree-empty").hidden = false;
    return;
  }
  $("#tree-empty").hidden = true;
  state.focus = focusId;
  state.layout = L;

  $("#cards").innerHTML = L.cards.map((c) => cardHTML(c, focusId)).join("");
  const svg = $("#links");
  svg.setAttribute("width", L.width);
  svg.setAttribute("height", L.height);
  svg.setAttribute("viewBox", `0 0 ${L.width} ${L.height}`);
  svg.style.width = `${L.width}px`;
  svg.style.height = `${L.height}px`;
  svg.innerHTML = linksSVG(L);

  for (const b of $$("#view-switch button")) {
    const on = b.dataset.view === state.view;
    b.setAttribute("aria-selected", on);
    b.setAttribute("aria-checked", on);
  }
  centerOn(L);
  refreshMeChip();
}

function cardHTML(c, focusId) {
  const p = IDX.people[c.id];
  if (!p) return "";
  const cw = CFG.layout.card_width;
  const ch = CFG.layout.card_height;
  const cls = ["card"];
  if (p.hidden) cls.push("living");
  if (c.id === focusId) cls.push("focus");
  if (c.id === state.meId) cls.push("me");
  const yrs = yearsText(p);
  const place = CFG.layout.show_places && !p.hidden ? p.birth?.place || "" : "";
  const more = c.more ? `<span class="more">+${c.more}</span>` : "";
  const stories = !p.hidden && p.stories?.length ? `<span class="stories-count">${p.stories.length}</span>` : "";
  return `<button type="button" class="${cls.join(" ")}" data-card="${esc(c.id)}"
      style="left:${c.x}px;top:${c.y}px;width:${cw}px;height:${ch}px;--tone:${toneVar(p.gender)}"
      aria-label="${esc(displayName(p))}">
      <span class="avatar">${esc(initials(p))}</span>
      <span class="meta">
        <span class="name">${esc(displayName(p))}</span>
        ${yrs ? `<span class="years">${esc(yrs)}</span>` : ""}
        ${place ? `<span class="place">${esc(place)}</span>` : ""}
      </span>
      ${stories}${more}
    </button>`;
}

const f = (n) => Math.round(n * 10) / 10;

function linksSVG(L) {
  const angular = CFG.layout.connector_style === "angular";
  let d = "";
  let extras = "";
  for (const l of L.links) {
    const sy = l.sy;
    const ty = l.ty;
    if (l.tx.length) {
      if (angular) {
        const bus = sy + (ty - sy) / 2;
        for (const sx of l.sx) d += `M${f(sx)} ${f(sy)}V${f(bus)}`;
        const all = [...l.sx, ...l.tx];
        d += `M${f(Math.min(...all))} ${f(bus)}H${f(Math.max(...all))}`;
        for (const tx of l.tx) d += `M${f(tx)} ${f(bus)}V${f(ty)}`;
      } else {
        const m = (ty - sy) * 0.5;
        for (const sx of l.sx) {
          for (const tx of l.tx) {
            d += `M${f(sx)} ${f(sy)}C${f(sx)} ${f(sy + m)} ${f(tx)} ${f(ty - m)} ${f(tx)} ${f(ty)}`;
          }
        }
      }
    }
    if (l.kind === "family" && l.sx.length) {
      const mx = f(l.sx[0]);
      extras += `<circle class="marriage" cx="${mx}" cy="${f(sy)}" r="6"/>`;
      if (l.label) extras += `<text x="${f(mx + 10)}" y="${f(sy + 4)}">${esc(l.label)}</text>`;
    }
  }
  return `<path d="${d}"></path>${extras}`;
}

function centerOn(L) {
  const vp = $("#viewport");
  const vw = vp.clientWidth;
  const vh = vp.clientHeight;
  if (!vw || !vh) return;
  const cw = CFG.layout.card_width;
  const ch = CFG.layout.card_height;
  const narrow = vw < 640;
  const panelOpen = !$("#panel").hidden && !narrow;
  const usableW = vw - (panelOpen ? 400 : 0);
  const pad = 24;
  const fitK = Math.min((usableW - pad * 2) / (L.width + cw), (vh - pad * 2) / (L.height + ch));
  const k = clamp(fitK, 0.4, 1.0);
  state.k = k;
  if (fitK >= 0.4) {
    state.x = usableW / 2 - (L.width / 2) * k;
    state.y = vh / 2 - (L.height / 2) * k;
  } else {
    const fx = L.focus.x + cw / 2;
    const fy = L.focus.y + ch / 2;
    state.x = usableW / 2 - fx * k;
    state.y = (narrow ? vh * 0.3 : vh * 0.42) - fy * k;
  }
  applyTransform();
}

function applyTransform() {
  $("#canvas").style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.k})`;
}

function zoomAt(px, py, factor) {
  const nk = clamp(state.k * factor, 0.2, 2.4);
  const ratio = nk / state.k;
  state.x = px - (px - state.x) * ratio;
  state.y = py - (py - state.y) * ratio;
  state.k = nk;
  applyTransform();
}

function markSelectedCards() {
  for (const card of $$(".card")) {
    card.classList.toggle("selected", card.dataset.card === state.selected);
  }
}

// ---------- Panel ----------

function selectPerson(id, { silent = false } = {}) {
  state.selected = id;
  markSelectedCards();
  const p = IDX.people[id];
  if (!p) return;
  const panel = $("#panel");
  panel.innerHTML = personPanelHTML(p);
  panel.hidden = false;
  panel.scrollTop = 0;
  if (!silent) {
    const narrow = window.innerWidth <= 640;
    if (!narrow && state.layout) centerOn(state.layout);
  }
}

function hidePanel() {
  $("#panel").hidden = true;
  state.selected = null;
  markSelectedCards();
}

function factRow(key, value) {
  return `<li><span class="k">${esc(key)}</span><span>${value}</span></li>`;
}

function personChip(id) {
  const p = IDX.people[id];
  if (!p) return "";
  return `<button type="button" class="chip" data-focus="${esc(id)}" style="--tone:${toneVar(p.gender)}">
    <span class="dot"></span>${esc(displayName(p))}${yearsText(p) ? ` <span class="muted">${esc(yearsText(p))}</span>` : ""}
  </button>`;
}

function personPanelHTML(p) {
  const parts = [];
  const meName = state.meId ? nameOf(state.meId) : null;
  const subtitle = [yearsText(p), p.birth?.place].filter(Boolean).join(" · ");

  parts.push(`<button class="close" type="button" data-action="close" aria-label="Close">×</button>`);
  parts.push(`<div class="person-head" style="--tone:${toneVar(p.gender)}">
      <div class="avatar">${esc(initials(p))}</div>
      <div>
        <h2 class="person-name">${esc(displayName(p))}</h2>
        ${p.name.alternates?.length && !p.hidden ? `<div class="person-sub">also: ${esc(p.name.alternates.join(", "))}</div>` : ""}
        ${subtitle ? `<div class="person-sub">${esc(subtitle)}</div>` : ""}
        ${p.hidden ? `<div class="person-sub">Details are private.</div>` : ""}
      </div>
    </div>`);

  if (state.meId && state.meId !== p.id) {
    const rel = relationship(IDX, state.meId, p.id);
    const sentence = rel ? sentenceFor(rel, displayName(p), meName) : null;
    parts.push(`<p class="relation">${esc(sentence || `No family link to ${meName} in this tree.`)}</p>`);
  } else if (state.meId === p.id) {
    parts.push(`<p class="relation">This is you.</p>`);
  }

  const buttons = [`<button class="btn primary" type="button" data-focus="${esc(p.id)}">Center tree here</button>`];
  if (state.meId === p.id) buttons.push(`<button class="btn" type="button" data-action="unme">Clear “me”</button>`);
  else if (!p.hidden) buttons.push(`<button class="btn" type="button" data-action="me" data-id="${esc(p.id)}">${esc(CFG.text.set_me)}</button>`);
  parts.push(`<div class="actions">${buttons.join("")}</div>`);

  const stories = (p.stories || []).map((sid) => IDX.notes[sid]).filter(Boolean);
  if (stories.length) {
    parts.push(`<div class="section-title">${esc(CFG.narratives.section_title || "Stories")}</div>`);
    parts.push(stories.map((n) => `<button type="button" class="story-card-mini" data-story="${esc(n.id)}">
        <strong>${esc(storyTitle(n))}</strong><span>${readMinutes(n.words)} min read</span></button>`).join(""));
  }

  const facts = [];
  if (p.birth) facts.push(factRow("Born", esc([p.birth.date, p.birth.place].filter(Boolean).join(" · ")) || "—"));
  if (p.death) facts.push(factRow("Died", esc([p.death.date, p.death.place].filter(Boolean).join(" · ")) || "—"));
  for (const ev of p.events || []) {
    const label = ev.type;
    const value = [ev.date, ev.place, ev.description].filter(Boolean).map(esc).join(" · ");
    if (value) facts.push(factRow(label, value));
  }
  if (facts.length) {
    parts.push(`<div class="section-title">Life</div><ul class="facts">${facts.join("")}</ul>`);
  }

  const famBlocks = [];
  const pf = p.parent_family ? IDX.families[p.parent_family] : null;
  const parents = pf ? [pf.father, pf.mother].filter(Boolean) : [];
  if (parents.length) famBlocks.push(`<div class="section-title">Parents</div><div class="chips">${parents.map(personChip).join("")}</div>`);
  const siblings = pf ? pf.children.filter((c) => c !== p.id && IDX.people[c]) : [];
  if (siblings.length) famBlocks.push(`<div class="section-title">Siblings</div><div class="chips">${siblings.map(personChip).join("")}</div>`);
  for (const fid of p.families || []) {
    const fam = IDX.families[fid];
    if (!fam) continue;
    const other = partnerOf(fam, p.id);
    const marriage = fam.marriage?.year ? ` · m. ${fam.marriage.year}` : "";
    const kids = fam.children.filter((c) => IDX.people[c]);
    const label = other ? `With ${esc(nameOf(other))}${esc(marriage)}` : `Children${esc(marriage)}`;
    famBlocks.push(`<div class="section-title">${label}</div>`);
    if (other) famBlocks.push(`<div class="chips">${personChip(other)}</div>`);
    if (kids.length) famBlocks.push(`<div class="chips">${kids.map(personChip).join("")}</div>`);
  }

  if (famBlocks.length) parts.push(famBlocks.join(""));

  const notes = (p.notes || []).map((id) => IDX.notes[id]).filter((n) => n && !n.is_story);
  if (notes.length) {
    parts.push(`<details class="section-title-wrap"><summary>Notes (${notes.length})</summary><div class="notes">${notes
      .map((n) => n.paragraphs.map((t) => `<p>${esc(t)}</p>`).join(""))
      .join("")}</div></details>`);
  }

  if (CFG.site.repo && !p.hidden) {
    const title = `Correction: ${displayName(p)} (${p.id})`;
    const body = [
      `Person: ${displayName(p)} (${p.id})`,
      "",
      "What is wrong or missing?",
      "",
      "Source or evidence (if any):",
      "",
      "Has this person died? If so, when and where?",
    ].join("\n");
    const url = `https://github.com/${CFG.site.repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    parts.push(`<div class="section-title">Help improve this</div>
      <p class="muted-note">Spot a mistake or something missing?</p>
      <a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Suggest a correction</a>`);
  }

  return parts.join("");
}

function refreshMeChip() {
  const chip = $("#me-chip");
  if (!chip) return;
  if (state.meId && IDX?.people[state.meId]) {
    chip.hidden = false;
    chip.dataset.focus = state.meId;
    chip.textContent = `◉ ${displayName(IDX.people[state.meId])}`;
    chip.title = "Center the tree on yourself";
  } else {
    chip.hidden = true;
  }
}

// ---------- People list ----------

function renderPeople() {
  const q = ($("#people-filter").value || "").trim().toLowerCase();
  const visible = DATA.people.filter((p) => !p.hidden);
  const matches = (p) => !q || `${displayName(p)} ${p.birth?.place || ""} ${p.death?.place || ""}`.toLowerCase().includes(q);
  const sorted = visible
    .filter(matches)
    .sort((a, b) => (a.name.surname || a.name.display).localeCompare(b.name.surname || b.name.display) || displayName(a).localeCompare(displayName(b)));
  let html = "";
  let letter = "";
  for (const p of sorted) {
    const key = ((p.name.surname || p.name.display || "?")[0] || "?").toUpperCase();
    if (key !== letter) {
      letter = key;
      html += `<div class="group-label">${esc(letter)}</div>`;
    }
    const yrs = yearsText(p);
    html += `<button class="person-row" type="button" data-focus="${esc(p.id)}" style="--tone:${toneVar(p.gender)}">
      <span class="avatar">${esc(initials(p))}</span>
      <span class="who"><strong>${esc(displayName(p))}</strong><span>${esc([yrs, p.birth?.place].filter(Boolean).join(" · "))}</span></span>
    </button>`;
  }
  const privateCount = DATA.people.length - visible.length;
  if (privateCount) html += `<p class="note-count">${privateCount} living family members are kept private.</p>`;
  $("#people-list").innerHTML = html || `<p class="note-count">No matches.</p>`;
}

// ---------- Stories ----------

function renderStoriesIndex() {
  const select = $("#stories-person");
  if (!select.options.length) {
    const subjects = new Set(IDX.stories.flatMap((n) => n.people));
    const opts = [...subjects].map((id) => ({ id, name: nameOf(id) })).sort((a, b) => a.name.localeCompare(b.name));
    select.innerHTML = `<option value="">All people</option>` + opts.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join("");
  }
  const q = ($("#stories-filter").value || "").trim().toLowerCase();
  const who = select.value;
  const list = IDX.stories.filter((n) => {
    if (who && !n.people.includes(who)) return false;
    if (!q) return true;
    return `${storyTitle(n)} ${n.paragraphs.join(" ")} ${n.people.map(nameOf).join(" ")}`.toLowerCase().includes(q);
  });
  $("#story-grid").innerHTML = list.map((n) => {
    const excerpt = (n.paragraphs[0] || "").slice(0, 220);
    const names = n.people.map(nameOf).join(", ");
    return `<button type="button" class="story-tile" data-story="${esc(n.id)}">
      <h3>${esc(storyTitle(n))}</h3>
      <p>${esc(excerpt)}${(n.paragraphs[0] || "").length > 220 ? "…" : ""}</p>
      <div class="meta">${names ? `<span>${esc(names)}</span>` : ""}<span>${readMinutes(n.words)} min read</span>${n.updated ? `<span>${esc(formatDate(n.updated))}</span>` : ""}</div>
    </button>`;
  }).join("") || `<p class="note-count">No stories match.</p>`;
}

function renderStory(id) {
  const n = id && IDX.notes[id];
  const article = $("#story");
  if (!n || !n.is_story) {
    article.innerHTML = `<p>That story could not be found.</p>`;
    return;
  }
  const names = n.people.map((pid) => `<button type="button" class="chip" data-focus="${esc(pid)}" style="--tone:${toneVar(IDX.people[pid].gender)}"><span class="dot"></span>${esc(nameOf(pid))}</button>`).join("");
  const others = n.people.flatMap((pid) => (IDX.people[pid]?.stories || []).filter((sid) => sid !== id))
    .filter((v, i, a) => a.indexOf(v) === i)
    .map((sid) => IDX.notes[sid])
    .filter(Boolean);
  article.innerHTML = `
    <button class="back" type="button" data-action="back">← ${esc(CFG.text.back)}</button>
    <h1 class="story-title">${esc(storyTitle(n))}</h1>
    <div class="story-byline">
      ${n.updated ? `<span>Updated ${esc(formatDate(n.updated))}</span>` : ""}
      <span>${readMinutes(n.words)} min read</span>
      ${n.tags?.length ? `<span>${esc(n.tags.join(" · "))}</span>` : ""}
    </div>
    <div class="story-body">${n.paragraphs.map((t) => `<p>${esc(t).replace(/\n/g, "<br>")}</p>`).join("")}</div>
    <div class="story-foot">
      ${names ? `<div class="section-title">About</div><div class="chips">${names}</div>` : ""}
      ${others.length ? `<div class="section-title">More stories</div>${others.map((o) => `<button type="button" class="story-card-mini" data-story="${esc(o.id)}"><strong>${esc(storyTitle(o))}</strong><span>${readMinutes(o.words)} min read</span></button>`).join("")}` : ""}
    </div>`;
  window.scrollTo?.(0, 0);
  const view = $("#view-story");
  if (view) view.scrollTop = 0;
}

// ---------- Search ----------

let searchItems = [];
let activeIndex = -1;

function searchPeople(q) {
  const term = q.trim().toLowerCase();
  if (!term) return [];
  return DATA.people
    .filter((p) => !p.hidden && `${displayName(p)} ${(p.name.alternates || []).join(" ")}`.toLowerCase().includes(term))
    .sort((a, b) => {
      const aStarts = displayName(a).toLowerCase().startsWith(term) ? 0 : 1;
      const bStarts = displayName(b).toLowerCase().startsWith(term) ? 0 : 1;
      return aStarts - bStarts || displayName(a).localeCompare(displayName(b));
    })
    .slice(0, 8);
}

function renderSearch() {
  const list = $("#search-results");
  const q = $("#search").value;
  searchItems = searchPeople(q);
  activeIndex = searchItems.length ? 0 : -1;
  if (!q.trim()) {
    list.hidden = true;
    return;
  }
  list.hidden = false;
  list.innerHTML = searchItems.length
    ? searchItems.map((p, i) => `<li role="option" data-focus="${esc(p.id)}" aria-selected="${i === activeIndex}">
        <span>${esc(displayName(p))}</span><span class="muted">${esc(yearsText(p))}</span></li>`).join("")
    : `<li class="muted">No one matches “${esc(q)}”</li>`;
}

function setActive(i) {
  const items = $$("#search-results li[role='option']");
  activeIndex = clamp(i, 0, items.length - 1);
  items.forEach((li, idx) => li.setAttribute("aria-selected", idx === activeIndex));
}

function closeSearch() {
  $("#search-results").hidden = true;
}

// ---------- Events ----------

let dragMoved = false;

function bindEvents() {
  const vp = $("#viewport");
  const pointers = new Map();
  let lastPinch = null;

  vp.addEventListener("pointerdown", (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragMoved = false;
    vp.classList.add("dragging");
  });
  window.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) dragMoved = true;
      state.x += dx;
      state.y += dy;
      applyTransform();
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const rect = vp.getBoundingClientRect();
      const cx = (a.x + b.x) / 2 - rect.left;
      const cy = (a.y + b.y) / 2 - rect.top;
      if (lastPinch) {
        dragMoved = true;
        zoomAt(cx, cy, dist / lastPinch);
      }
      lastPinch = dist;
    }
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) lastPinch = null;
    if (!pointers.size) vp.classList.remove("dragging");
  };
  window.addEventListener("pointerup", endPointer);
  window.addEventListener("pointercancel", endPointer);

  vp.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = vp.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  $("#zoom-in").addEventListener("click", () => zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, 1.2));
  $("#zoom-out").addEventListener("click", () => zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, 1 / 1.2));
  $("#zoom-fit").addEventListener("click", () => state.layout && centerOn(state.layout));

  $("#view-switch").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (!b) return;
    go("tree", state.focus, { v: b.dataset.view });
  });

  $("#cards").addEventListener("click", (e) => {
    if (dragMoved) return;
    const card = e.target.closest("[data-card]");
    if (card) selectPerson(card.dataset.card);
  });

  $("#panel").addEventListener("click", (e) => {
    const t = e.target.closest("[data-focus],[data-story],[data-action]");
    if (!t) return;
    if (t.dataset.action === "close") return hidePanel();
    if (t.dataset.action === "me") {
      setMe(t.dataset.id);
      return selectPerson(state.selected);
    }
    if (t.dataset.action === "unme") {
      setMe(null);
      return selectPerson(state.selected);
    }
    if (t.dataset.story) return go("story", t.dataset.story);
    if (t.dataset.focus) return go("tree", t.dataset.focus, { v: state.view });
  });

  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-focus],[data-story],[data-action='back']");
    if (!t) return;
    if (t.closest("#panel") || t.closest("#cards")) return;
    if (t.dataset.action === "back") {
      if (history.length > 1) history.back();
      else go("stories");
      return;
    }
    if (t.dataset.story) return go("story", t.dataset.story);
    if (t.dataset.focus) {
      closeSearch();
      return go("tree", t.dataset.focus, { v: state.view });
    }
  });

  $("#me-chip").addEventListener("click", () => {
    if (state.meId) go("tree", state.meId, { v: state.view });
  });

  const search = $("#search");
  search.addEventListener("input", renderSearch);
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(activeIndex + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(activeIndex - 1); }
    else if (e.key === "Enter" && searchItems[activeIndex]) {
      e.preventDefault();
      const id = searchItems[activeIndex].id;
      search.value = "";
      closeSearch();
      go("tree", id, { v: state.view });
    } else if (e.key === "Escape") {
      search.value = "";
      closeSearch();
      search.blur();
    }
  });
  search.addEventListener("blur", () => setTimeout(closeSearch, 150));
  search.addEventListener("focus", renderSearch);

  $("#people-filter").addEventListener("input", renderPeople);
  $("#stories-filter").addEventListener("input", renderStoriesIndex);
  $("#stories-person").addEventListener("change", renderStoriesIndex);

  $("#story-grid").addEventListener("click", (e) => {
    const t = e.target.closest("[data-story]");
    if (t) go("story", t.dataset.story);
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;
    if (e.key === "/") { e.preventDefault(); search.focus(); }
    if (e.key === "+" || e.key === "=") zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, 1.15);
    if (e.key === "-") zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, 1 / 1.15);
    if (e.key === "Escape") hidePanel();
  });

  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    applyTheme();
  });
}

function setMe(id) {
  state.meId = id;
  if (id) localStorage.setItem(ME_KEY, id);
  else localStorage.removeItem(ME_KEY);
  refreshMeChip();
  markSelectedCards();
  $$(".card").forEach((c) => c.classList.toggle("me", c.dataset.card === id));
}

boot().catch((err) => {
  console.error(err);
  $("#loading").hidden = true;
  const box = $("#error");
  box.hidden = false;
  box.innerHTML = `<h2>Something went wrong</h2><p>${esc(err.message)}</p>`;
});
