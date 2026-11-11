import { layoutTree } from "./layout.js";
import { layoutOutline, outlineHTML } from "./list.js";
import { layoutWheel, layoutDescendantFan, renderWheelSVG } from "./wheel.js";
import { relationship, sentenceFor } from "./relate.js";
import { pravaraFor } from "./vedic.js";
import { renderJatagam } from "./chart.js";
import { createPanchang, listHTML as panchangListHTML, KIND_ORDER, KIND_LABELS } from "./panchang.js";

const DEFAULTS = {
  site: { title: "Family Tree", subtitle: "", intro: "", footer: "", default_person: "home", repo: "" },
  theme: { preset: "", mode: "auto", colors: { light: {}, dark: {} } },
  fonts: { heading: "Roboto", body: "Roboto", load_from_google: false },
  layout: {
    default_view: "tree", orientation: "vertical", generations_up: 4, generations_down: 4,
    wheel_generations: 7,
    card_width: 188, card_height: 84, gap_x: 26, gap_y: 92, corner_radius: 16,
    connector_style: "angular", show_years: true, show_places: true, show_child_counts: true,
  },
  narratives: { enabled: true, section_title: "Stories" },
  auth: {
    google: { client_id: "", allowed_domains: [], people: {}, auto_me: true },
  },
  text: {
    search_placeholder: "Find a family member…", tree_tab: "Tree", people_tab: "Everyone",
    stories_tab: "Stories", set_me: "This is me", view_tree: "Tree",
    panchang_tab: "Tithis",
    view_ancestors: "Ancestors", view_descendants: "Descendants",
    view_vertical: "Vertical", view_horizontal: "Horizontal", view_list: "List", view_wheel: "Wheel", tagged_people: "Tagged relatives",
    read_story: "Read story", back: "Back",
  },
  presets: {},
};

const ME_KEY = "family-tree:me";
const AUTH_KEY = "family-tree:google";
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
let VEDIC = { gotras: {} };
let PANCHANG = null;
const state = {
  focus: null, view: "tree", orientation: "vertical", selected: null, layout: null,
  k: 1, x: 0, y: 0, meId: null, auth: null, authError: null, authMe: false,
  tree: null, trees: [],
  // List view: collapsed person ids and the generation last jumped to.
  collapsed: new Set(), listGen: null,
  wheelRings: null, wheelMode: null,
};
let googleReady = false;

const el = {
  viewport: () => $("#viewport"),
  canvas: () => $("#canvas"),
  cards: () => $("#cards"),
  links: () => $("#links"),
  panel: () => $("#panel"),
};

// ---------- Boot ----------

async function boot() {
  const cfgText = await fetch("config.yml", { cache: "no-cache" })
    .then((r) => (r.ok ? r.text() : "")).catch(() => "");
  const userCfg = cfgText && window.jsyaml ? window.jsyaml.load(cfgText) : {};
  CFG = merge(DEFAULTS, userCfg || {});

  initTrees();
  const tree = pickTree();
  if (!tree) {
    $("#loading").hidden = true;
    renderNoTree();
    return;
  }
  await loadTree(tree.id);
}

// ---------- Multi-tree support ----------

const TREE_KEY = "family-tree:tree";

function initTrees() {
  const configured = CFG.trees || [];
  if (!configured.length) {
    // Backwards compatibility: a single-tree site uses the legacy data/ folder.
    state.trees = [{
      id: "default",
      label: CFG.site?.title || "Family Tree",
      folder: "data",
      default: true,
    }];
  } else {
    state.trees = configured.map((t) => ({
      id: String(t.id),
      label: t.label || t.id,
      folder: (t.folder || `data/trees/${t.id}`).replace(/\/$/, ""),
      default: !!t.default,
      auth: t.auth || null,
    }));
  }
}

function treeById(id) {
  return state.trees.find((t) => t.id === id) || null;
}

function defaultTree() {
  return state.trees.find((t) => t.default) || state.trees[0] || null;
}

function pickTree() {
  const params = parseHash().params;
  const wanted = params.tree || localStorage.getItem(TREE_KEY) || "";
  const tree = treeById(wanted) || defaultTree();
  if (tree) state.tree = tree.id;
  return tree;
}

function treeFolder(path = "") {
  const tree = treeById(state.tree);
  const base = tree?.folder || "data";
  return path ? `${base}/${path}` : base;
}

function renderNoTree() {
  const app = document.querySelector(".app");
  if (app) app.dataset.view = "error";
  const loading = $("#loading");
  if (loading) {
    loading.textContent = "No trees configured. Add a `trees:` section to config.yml.";
    loading.hidden = false;
  }
}

function renderTreeSelector() {
  const slot = $("#tree-selector");
  if (!slot) return;
  if (state.trees.length <= 1) {
    slot.hidden = true;
    return;
  }
  slot.hidden = false;
  const visible = visibleTrees();
  slot.innerHTML = `<label for="tree-select" class="visually-hidden">Family tree</label>
    <select id="tree-select" aria-label="Family tree">
      ${visible.map((t) => `<option value="${esc(t.id)}" ${t.id === state.tree ? "selected" : ""}>${esc(t.label)}</option>`).join("")}
    </select>`;
  const select = $("#tree-select", slot);
  if (select) {
    select.addEventListener("change", (e) => switchTree(e.target.value));
  }
}

function visibleTrees() {
  return state.trees.filter((t) => {
    if (!t.auth?.google) return true;
    return isAuthorizedForTree(t);
  });
}

function treeAuth() {
  const tree = treeById(state.tree);
  const base = CFG.auth?.google || {};
  const override = tree?.auth?.google || {};
  if (!base.client_id && !override.client_id) return null;
  return {
    ...base,
    ...override,
    // client_id always comes from the top-level auth config; per-tree blocks
    // can only tighten allowed_domains / allowed_emails / people / auto_me.
    client_id: base.client_id || override.client_id,
  };
}

function isAuthorizedForTree(tree) {
  const auth = tree?.auth?.google;
  if (!auth) return true;
  if (!state.auth?.email) return false;
  const domains = (auth.allowed_domains || []).map((d) => String(d).toLowerCase()).filter(Boolean);
  const emails = (auth.allowed_emails || []).map((e) => String(e).toLowerCase()).filter(Boolean);
  const email = String(state.auth.email).toLowerCase();
  if (emails.length && emails.includes(email)) return true;
  if (domains.length) {
    const domain = email.split("@")[1] || "";
    if (domains.includes(domain)) return true;
  }
  return !domains.length && !emails.length;
}

function renderTreeAccessRequired() {
  const app = document.querySelector(".app");
  if (app) app.dataset.view = "error";
  const loading = $("#loading");
  if (loading) {
    loading.innerHTML = `<p>This tree is restricted. Please sign in with Google to continue.</p><div id="tree-signin"></div>`;
    loading.hidden = false;
  }
  bindTopbar();
  applyTheme();
  renderTreeSelector();
  renderTreeSignIn();
}

function renderTreeSignIn() {
  const slot = $("#tree-signin");
  if (!slot || !googleReady || !window.google?.accounts?.id) return;
  const google = treeAuth();
  if (!google?.client_id) return;
  window.google.accounts.id.renderButton(slot, {
    type: "standard",
    size: "large",
    text: "signin_with",
  });
}

async function switchTree(id) {
  if (!treeById(id)) return;
  localStorage.setItem(TREE_KEY, id);
  state.tree = id;
  // Reset view state so the new tree renders cleanly.
  state.focus = null;
  state.selected = null;
  state.layout = null;
  state.collapsed.clear();
  state.listGen = null;
  $("#loading").hidden = false;
  document.querySelector(".app").dataset.view = "loading";
  await loadTree(id);
  const focus = defaultFocus();
  go("tree", focus, { tree: id });
}

async function loadTree(id) {
  const tree = treeById(id);
  if (!tree) throw new Error(`Unknown tree ${id}`);
  state.tree = id;

  // Re-check auth for the newly selected tree.
  if (tree.auth?.google && !isAuthorizedForTree(tree)) {
    $("#loading").hidden = true;
    renderTreeAccessRequired();
    // Load the Google sign-in library so the restricted page can offer a button.
    initAuth();
    return;
  }

  const [dataRes, vedicData, panchangIndex] = await Promise.all([
    fetch(`${tree.folder}/tree.json`, { cache: "no-cache" }),
    fetch(`${tree.folder}/vedic.json`, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch(`${tree.folder}/panchang/index.json`, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  if (!dataRes.ok) throw new Error(`Could not load ${tree.folder}/tree.json. Run the importer first.`);
  if (vedicData && typeof vedicData === "object") VEDIC = vedicData;
  DATA = await dataRes.json();
  IDX = buildIndex(DATA);

  PANCHANG = createPanchang({
    fetchJson: (url) => fetch(url, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${url}: ${r.status}`)))),
    basePath: `${tree.folder}/panchang`,
    personFor: (id) => IDX.people[id],
    displayName,
    yearsText,
    formatDate,
  });
  PANCHANG.useIndex(panchangIndex);

  finishBoot();
}

function finishBoot() {
  state.meId = localStorage.getItem(ME_KEY);
  if (state.meId && !IDX.people[state.meId]) state.meId = null;
  state.auth = readStoredAuth();
  const google = treeAuth();
  if (!google?.client_id) {
    state.auth = null;
  } else if (state.auth?.email) {
    state.auth.pid = mappedPersonId(google, state.auth.email);
    if (google.auto_me !== false && state.auth.pid) {
      state.meId = state.auth.pid;
      state.authMe = true;
    }
  }
  const narrow = window.innerWidth <= 640;
  state.view = narrow ? "list" : (CFG.layout.default_view || "tree");
  if (!["tree", "list", "wheel"].includes(state.view)) state.view = "tree";
  if (state.view === "wheel" && !window.d3) state.view = "tree";
  state.orientation = CFG.layout.orientation === "horizontal" ? "horizontal" : "vertical";

  renderTreeSelector();
  applyTheme();
  applyText();
  bindEvents();
  initAuth();
  window.removeEventListener("hashchange", route);
  window.addEventListener("hashchange", route);
  route();
  renderGenerationsRail();
  $("#loading").hidden = true;
  document.querySelector(".app").dataset.view = "ready";

  if (PANCHANG.available) {
    PANCHANG.prefetchAll().then(() => {
      if (state.selected) selectPerson(state.selected);
      if (parseHash().route === "panchang") renderPanchang();
    });
  }
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
  const generations = data.generations || [];
  return { people, families, notes, stories, generations };
}

function renderGenerationsRail() {
  const rail = $("#gen-rail");
  if (!rail) return;
  // The list only offers generations that actually appear beneath the current
  // root, so a disconnected branch's letter cannot become a dead button.
  const gens = state.view === "list" && IDX
    ? [...new Set((layoutOutline(IDX, state.focus, {})?.rows || [])
      .map((row) => row.generation).filter(Boolean))].sort()
    : IDX?.generations || [];
  if (!gens.length) {
    rail.hidden = true;
    return;
  }
  rail.hidden = false;
  // In the tree the active generation follows the focus. In the list the
  // visitor can jump to any generation without re-rooting, so remember the
  // generation they last chose.
  const activeGen = (state.view === "list" && state.listGen)
    || IDX.people[state.focus]?.generation || "";
  rail.innerHTML = gens
    .map((gen) => `<button type="button" data-gen="${esc(gen)}" class="${gen === activeGen ? "active" : ""}" aria-label="Jump to generation ${esc(gen)}">${esc(gen)}</button>`)
    .join("");
}

function focusGeneration(gen) {
  const candidates = DATA.people.filter((p) => !p.hidden && p.generation === gen);
  if (!candidates.length) return;
  // Prefer someone related to the current focus, otherwise the first visible person.
  let pick = candidates.find((p) => p.id === state.focus);
  if (!pick && state.focus) {
    const current = IDX.people[state.focus];
    if (current?.generation === gen) {
      pick = current;
    }
  }
  if (!pick) {
    const home = defaultFocus();
    pick = candidates.find((p) => p.id === home) || candidates[0];
  }
  go("tree", pick.id, { v: state.view, o: state.orientation });
}

// In the list the whole family is already shown, so a generation button expands
// any collapsed ancestors above that generation and scrolls to the first row.
function jumpToGeneration(gen) {
  if (state.view !== "list") return focusGeneration(gen);
  state.listGen = gen;
  const full = layoutOutline(IDX, state.focus, {});
  const target = full?.rows.find((row) => row.generation === gen);
  if (!target) {
    renderGenerationsRail();
    return;
  }
  for (const id of target.ancestors || []) state.collapsed.delete(id);
  renderListStage(state.focus, { preserveScroll: true });
  const row = document.querySelector(`#list-stage .outline-row[data-row-key="${target.key}"]`);
  if (row) {
    row.scrollIntoView({ block: "center" });
    row.classList.add("gen-flash");
    setTimeout(() => row.classList.remove("gen-flash"), 1800);
  }
  renderGenerationsRail();
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
  root.style.setProperty("--font-heading", `"${CFG.fonts.heading}", system-ui, sans-serif`);
  root.style.setProperty("--font-body", `"${CFG.fonts.body}", system-ui, sans-serif`);
  root.style.setProperty("--card-radius", `${CFG.layout.corner_radius}px`);
  renderAuth();
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
  $("#tab-panchang").textContent = text.panchang_tab || "Tithis";
  $("#tab-panchang").hidden = !PANCHANG?.available;
  $("#panchang-heading").textContent = CFG.panchang?.name || text.panchang_tab || "Tithis";
  $("#stories-heading").textContent = narratives.section_title || text.stories_tab;
  const views = $$("#view-switch button");
  views[0].textContent = text.view_tree || "Tree";
  views[1].textContent = text.view_list || "List";
  if (views[2]) {
    views[2].textContent = text.view_wheel || "Wheel";
    views[2].hidden = !window.d3;
  }
  const orientations = $$("#orientation-switch button");
  orientations[0].textContent = text.view_vertical;
  orientations[1].textContent = text.view_horizontal;
  const wheelModes = $$("#wheel-mode button");
  if (wheelModes.length === 2) {
    wheelModes[0].textContent = text.view_ancestors || "Ancestors";
    wheelModes[1].textContent = text.view_descendants || "Descendants";
  }
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

// Vedic data may arrive either as a nested `vedic` object or as flat
// `vedic.*` attributes from the relatives sheet. Pravara is always derived
// from the gotra, never read from the sheet, so the two cannot disagree.
function attributeValue(person, key) {
  const attrs = person?.attributes || {};
  if (Object.prototype.hasOwnProperty.call(attrs, key)) return attrs[key];
  if (Object.prototype.hasOwnProperty.call(attrs, `vedic.${key}`)) return attrs[`vedic.${key}`];
  return "";
}

const VEDIC_LABELS = {
  veda: "Veda",
  shakha: "Shakha",
  sutra: "Sutra",
  purvikam: "Purvikam",
  kula_devatha: "Kula Devatha",
  sampradaya: "Sampradaya",
  acharya_thirumaligai: "Acharya Thirumaligai",
  parvata: "Parvata",
  rashi: "Rashi",
  nakshatra: "Nakshatra",
  pada: "Pada",
  birth_time: "Birth time",
  birth_place: "Vedic birth place",
  chart_url: "Birth chart",
  notes: "Notes",
};

function vedicFor(person) {
  if (!person || person.hidden) return null;
  const vedic = person.vedic && typeof person.vedic === "object" ? person.vedic : {};
  const gotra = String(vedic.gotra || attributeValue(person, "gotra") || "").trim();
  const pravara = pravaraFor(gotra, VEDIC);
  const concepts = VEDIC.concepts || {};
  const fields = [];
  const helps = {};
  // "chart" holds the computed jatagam payload; it renders via the Jatagam
  // button, not as a text field.
  const seen = new Set(["gotra", "pravara", "chart"]);

  const addHelp = (key, extraText = "", source = "") => {
    const concept = concepts[key];
    if (!concept && !extraText) return;
    const parts = [concept?.text, extraText].filter(Boolean);
    if (!parts.length) return;
    helps[key] = {
      title: concept?.title || key,
      text: parts.join(" "),
      source: source || concept?.source || "",
    };
  };

  addHelp("vedic_roots");
  if (gotra) {
    fields.push({ key: "gotra", label: "Gotra", html: esc(gotra) });
    addHelp("gotra", pravara?.about || "", pravara?.source || "");
  }
  if (pravara) {
    fields.push({ key: "pravara", label: "Pravara", html: esc(pravara.rishis.join(", ")) });
    addHelp("pravara");
    if (pravara.type) {
      const typeKey = pravara.type.toLowerCase();
      seen.add(typeKey);
      fields.push({ key: typeKey, label: "Pravara type", html: esc(pravara.type) });
      addHelp(typeKey);
    }
  }

  for (const [key, label] of Object.entries(VEDIC_LABELS)) {
    seen.add(key);
    const value = String(vedic[key] ?? attributeValue(person, key) ?? "").trim();
    if (!value) continue;
    if (key === "chart_url") {
      if (/^https?:\/\//i.test(value)) {
        fields.push({ key, label, html: `<a href="${esc(value)}" target="_blank" rel="noopener noreferrer">View chart</a>` });
      }
      continue;
    }
    fields.push({ key, label, html: esc(value) });
    addHelp(key);
  }

  for (const [key, value] of Object.entries(vedic)) {
    if (seen.has(key) || value == null || value === "") continue;
    fields.push({
      key,
      label: key.replace(/[_.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      html: esc(value),
    });
  }
  for (const [key, value] of Object.entries(person.attributes || {})) {
    const match = key.match(/^vedic\.(.+)$/);
    if (!match || seen.has(match[1]) || value == null || value === "") continue;
    fields.push({
      key: match[1],
      label: match[1].replace(/[_.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      html: esc(value),
    });
    addHelp(match[1]);
  }

  if (!fields.length) return null;
  return { fields, helps, gotra, pravara };
}

// ---------- Jatagam (birth chart) modal ----------

let chartReturnFocus = null;

function openJatagam(pid) {
  const p = IDX?.people[pid];
  const chart = p?.vedic?.chart;
  const modal = $("#chart-modal");
  const body = $("#chart-body");
  if (!p || !chart || !modal || !body) return;
  const birthText = [p.birth?.date, p.birth?.place].filter(Boolean).join(" · ");
  const html = renderJatagam(chart, {
    name: p.name?.display || pid,
    birthText,
    disclaimer: VEDIC?.disclaimer || "",
  });
  if (!html) return;
  $("#chart-title").textContent = `Jatagam — ${p.name?.display || pid}`;
  body.innerHTML = html;
  chartReturnFocus = document.activeElement;
  modal.hidden = false;
  document.body.classList.add("chart-open");
  $(".chart-dialog", modal)?.focus();
}

function closeJatagam() {
  const modal = $("#chart-modal");
  if (modal) modal.hidden = true;
  document.body.classList.remove("chart-open");
  chartReturnFocus?.focus?.();
  chartReturnFocus = null;
}

function googleAuthFor(person) {
  return state.auth && state.auth.pid === person?.id && !person.hidden ? state.auth : null;
}

function avatarHTML(person, className = "avatar") {
  const auth = googleAuthFor(person);
  const face = auth?.picture
    ? `<img src="${esc(auth.picture)}" alt="" referrerpolicy="no-referrer" loading="lazy">`
    : esc(initials(person));
  return `<span class="${className}">${face}</span>`;
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
  const current = parseHash().params;
  // Preserve the current tree across navigation unless explicitly overridden.
  const merged = { tree: state.tree, ...current, ...params };
  if (!merged.tree) delete merged.tree;
  const qs = new URLSearchParams(merged).toString();
  const hash = `#/${route}${arg ? `/${encodeURIComponent(arg)}` : ""}${qs ? `?${qs}` : ""}`;
  if (location.hash === hash) route_(); else location.hash = hash;
}

function route_() {
  route();
}

function showView(name) {
  for (const id of ["tree", "people", "stories", "story", "panchang"]) $(`#view-${id}`).hidden = id !== name;
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
  } else if (r === "panchang") {
    if (!PANCHANG?.available) {
      // No generated calendar: fall back to the tree.
      go("tree", null, {});
      return;
    }
    showView("panchang");
    openPanchang(arg, params);
  } else {
    showView("tree");
    const focus = arg && IDX.people[arg] ? arg : defaultFocus();
    let view = ["tree", "list", "wheel"].includes(params.v) ? params.v : state.view;
    if (view === "wheel" && !window.d3) view = "tree";
    const orientation = ["vertical", "horizontal"].includes(params.o) ? params.o : state.orientation;
    const ringsParam = parseInt(params.r, 10);
    const wheelRings = ringsParam >= 4 && ringsParam <= 10 ? ringsParam : state.wheelRings;
    const wheelMode = ["up", "down"].includes(params.m) ? params.m : state.wheelMode;
    const changed = focus !== state.focus || view !== state.view
      || orientation !== state.orientation || wheelRings !== state.wheelRings
      || wheelMode !== state.wheelMode;
    state.view = view;
    state.orientation = orientation;
    state.wheelRings = wheelRings;
    state.wheelMode = wheelMode;
    if (focus !== state.focus) {
      // A new focus re-roots the list; start that view fully expanded.
      state.collapsed.clear();
      state.listGen = null;
    }
    if (changed || !state.layout) {
      renderTree(focus);
      if (focus !== state.selected) {
        state.selected = null;
        if (window.innerWidth > 640) selectPerson(focus);
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
    orientation: state.orientation,
    up: L.generations_up,
    down: L.generations_down,
    cardW: L.card_width,
    cardH: L.card_height,
    gapX: L.gap_x,
    gapY: L.gap_y,
    unionSize: 44,
  };
}

function renderListStage(focusId, { preserveScroll = false } = {}) {
  const stage = $("#list-stage");
  const top = stage.scrollTop;
  const left = stage.scrollLeft;
  const L = layoutOutline(IDX, focusId, { collapsed: state.collapsed });
  if (!L || !L.rows.length) {
    stage.innerHTML = "";
    $("#tree-empty").hidden = false;
    return null;
  }
  $("#tree-empty").hidden = true;
  state.focus = focusId;
  state.layout = L;
  stage.innerHTML = outlineHTML(L);
  if (preserveScroll) {
    stage.scrollTop = top;
    stage.scrollLeft = left;
  } else {
    stage.scrollTop = 0;
    stage.scrollLeft = 0;
  }
  markSelectedCards();
  return L;
}

function renderTree(focusId) {
  const isList = state.view === "list";
  const isWheel = state.view === "wheel";
  const listStage = $("#list-stage");
  const wheelStage = $("#wheel-stage");
  $("#viewport").hidden = isList || isWheel;
  listStage.hidden = !isList;

  if (isList) {
    wheelStage.hidden = true;
    if (!renderListStage(focusId)) return;

    for (const b of $$("#view-switch button")) {
      const on = b.dataset.view === state.view;
      b.setAttribute("aria-selected", on);
      b.setAttribute("aria-checked", on);
    }
    document.body.dataset.treeview = "list";
    refreshMeChip();
    renderGenerationsRail();
    return;
  }

  $("#viewport").hidden = false;
  wheelStage.hidden = !isWheel;
  $("#cards").hidden = isWheel;
  $("#links").hidden = isWheel;

  if (isWheel) {
    // Auto direction: ancestors when the focus has known ancestors, otherwise
    // descendants (a founder like the patriarch has a full fan downward).
    let mode = state.wheelMode;
    if (!mode) {
      const p = IDX.people[focusId];
      const pf = p?.parent_family ? IDX.families[p.parent_family] : null;
      const hasParents = Boolean(pf?.father || pf?.mother);
      const hasKids = (p?.families || []).some((fid) => IDX.families[fid]?.children?.length);
      mode = hasParents || !hasKids ? "up" : "down";
    }
    const wheelOpts = {
      rings: state.wheelRings || undefined,
      cap: CFG.layout.wheel_generations ?? 7,
    };
    const L = mode === "down"
      ? layoutDescendantFan(IDX, focusId, wheelOpts)
      : layoutWheel(IDX, focusId, wheelOpts);
    if (!L) {
      $("#tree-empty").hidden = false;
      return;
    }
    $("#tree-empty").hidden = true;
    state.focus = focusId;
    state.layout = L;
    wheelStage.style.setProperty("--wheel-w", `${L.width}px`);
    wheelStage.style.setProperty("--wheel-h", `${L.height}px`);
    wheelStage.innerHTML = "";
    const svg = renderWheelSVG(L, {
      onSelect: (id) => {
        if (id && id !== focusId) go("tree", id, { v: "wheel" });
        else if (id) selectPerson(id);
      },
    });
    wheelStage.appendChild(svg);

    for (const b of $$("#view-switch button")) {
      const on = b.dataset.view === state.view;
      b.setAttribute("aria-selected", on);
      b.setAttribute("aria-checked", on);
    }
    for (const b of $$("#wheel-rings button")) {
      const on = Number(b.dataset.rings) === L.rings;
      b.setAttribute("aria-selected", on);
      b.setAttribute("aria-checked", on);
    }
    for (const b of $$("#wheel-mode button")) {
      const on = b.dataset.mode === mode;
      b.setAttribute("aria-selected", on);
      b.setAttribute("aria-checked", on);
    }
    document.body.dataset.treeview = "wheel";
    centerOn(L);
    refreshMeChip();
    renderGenerationsRail();
    return;
  }

  const L = layoutTree(IDX, focusId, layoutOptions(state.view === "tree" ? "hourglass" : state.view));
  if (!L) {
    $("#tree-empty").hidden = false;
    return;
  }
  $("#tree-empty").hidden = true;
  state.focus = focusId;
  state.layout = L;

  $("#cards").innerHTML = L.cards
    .map((c) => (c.kind === "union" ? unionCardHTML(c, focusId) : cardHTML(c, focusId)))
    .join("");
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
  for (const b of $$("#orientation-switch button")) {
    const on = b.dataset.orientation === state.orientation;
    b.setAttribute("aria-selected", on);
    b.setAttribute("aria-checked", on);
  }
  document.body.dataset.treeview = state.view;
  centerOn(L);
  refreshMeChip();
  renderGenerationsRail();
}

function cardHTML(c, focusId) {
  const p = IDX.people[c.id];
  if (!p) return "";
  const cw = c.w ?? CFG.layout.card_width;
  const ch = c.h ?? CFG.layout.card_height;
  const cls = ["card"];
  if (p.hidden) cls.push("living");
  if (c.id === focusId) cls.push("focus");
  if (c.id === state.meId) cls.push("me");
  const yrs = yearsText(p);
  const place = CFG.layout.show_places && !p.hidden ? p.birth?.place || p.current_location || "" : "";
  const more = c.more ? `<span class="more">+${c.more}</span>` : "";
  const stories = !p.hidden && p.stories?.length ? `<span class="stories-count">${p.stories.length}</span>` : "";
  return `<button type="button" class="${cls.join(" ")}" data-card="${esc(c.id)}"
      style="left:${c.x}px;top:${c.y}px;width:${cw}px;height:${ch}px;--tone:${toneVar(p.gender)}"
      aria-label="${esc(displayName(p))}">
      ${avatarHTML(p)}
      <span class="meta">
        <span class="name">${esc(displayName(p))}</span>
        ${yrs ? `<span class="years">${esc(yrs)}</span>` : ""}
        ${place ? `<span class="place">${esc(place)}</span>` : ""}
      </span>
      ${stories}${more}
    </button>`;
}

function unionCardHTML(c) {
  const fam = DATA.families?.find((f) => f.id === c.id) || {};
  const marriage = fam.marriage && fam.marriage.year ? `m. ${fam.marriage.year}` : "";
  return `<div class="union-card" data-union="${esc(c.id)}" style="left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px" title="${esc(fam.ref_name || c.id)}">
    <span class="union-dot"></span>
    ${marriage ? `<span class="union-label">${esc(marriage)}</span>` : ""}
  </div>`;
}

const f = (n) => Math.round(n * 10) / 10;

function linksSVG(L) {
  const angular = CFG.layout.connector_style === "angular";
  let d = "";
  let extras = "";
  for (const l of L.links) {
    if (l.horizontal) {
      // Horizontal links: one x per generation, one y per source/target card.
      const sx = l.sx;
      const sy = l.sy;
      const tx = l.tx;
      const ty = l.ty;
      if (ty.length) {
        if (angular) {
          const bus = sx + (tx - sx) / 2;
          for (const y of sy) d += `M${f(sx)} ${f(y)}H${f(bus)}`;
          const all = [...sy, ...ty];
          d += `M${f(bus)} ${f(Math.min(...all))}V${f(Math.max(...all))}`;
          for (const y of ty) d += `M${f(bus)} ${f(y)}H${f(tx)}`;
        } else {
          const m = (tx - sx) * 0.5;
          for (const y1 of sy) {
            for (const y2 of ty) {
              d += `M${f(sx)} ${f(y1)}C${f(sx + m)} ${f(y1)} ${f(tx - m)} ${f(y2)} ${f(tx)} ${f(y2)}`;
            }
          }
        }
      }
      if (l.kind === "family" && sy.length) {
        const my = f(sy[0]);
        extras += `<circle class="marriage" cx="${f(sx)}" cy="${my}" r="6"/>`;
        if (l.label) extras += `<text x="${f(sx + 12)}" y="${f(my + 4)}">${esc(l.label)}</text>`;
      }
      continue;
    }
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
  const narrow = vw < 640;
  const panelOpen = !$("#panel").hidden && !narrow;
  const usableW = vw - (panelOpen ? 400 : 0);

  if (state.view === "wheel") {
    const diameter = L.radius * 2;
    const pad = narrow ? 8 : 28;
    const fitK = Math.min((usableW - pad * 2) / diameter, (vh - pad * 2) / diameter);
    state.k = clamp(fitK, 0.15, 1.25);
    state.x = usableW / 2;
    state.y = vh / 2;
    applyTransform();
    return;
  }

  const cw = CFG.layout.card_width;
  const ch = CFG.layout.card_height;
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
  for (const node of $$(".union-card")) {
    node.classList.toggle("selected", node.dataset.union === state.selected);
  }
  for (const row of $$(".outline-row")) {
    const on = Boolean(state.selected)
      && (row.dataset.person === state.selected || row.dataset.family === state.selected);
    row.classList.toggle("selected", on);
  }
  for (const sector of $$(".wheel-sector")) {
    sector.classList.toggle("selected", Boolean(state.selected) && sector.dataset.id === state.selected);
  }
}

// ---------- Panel ----------

function selectPerson(id) {
  state.selected = id;
  markSelectedCards();
  const p = IDX.people[id];
  if (!p) return;
  const panel = $("#panel");
  panel.classList.remove("vedic-open");
  panel.innerHTML = personPanelHTML(p);
  panel.hidden = false;
  panel.scrollTop = 0;
  // The chart is deliberately NOT re-centred here: opening or closing the
  // details panel must leave the visitor's pan and zoom exactly as they were.
}

function selectUnion(id) {
  const fam = IDX.families[id];
  if (!fam) return;
  state.selected = id;
  markSelectedCards();
  const panel = $("#panel");
  panel.classList.remove("vedic-open");
  panel.innerHTML = unionPanelHTML(fam);
  panel.hidden = false;
  panel.scrollTop = 0;
}

function unionPanelHTML(fam) {
  const partners = [fam.father, fam.mother].filter((id) => id && IDX.people[id]);
  const children = (fam.children || []).filter((id) => IDX.people[id]);
  const attrs = fam.attributes || {};
  const parts = [];
  parts.push(`<button class="close" type="button" data-action="close" aria-label="Close">×</button>`);
  parts.push(`<div class="person-head" style="--tone:var(--accent)">
      <div class="avatar union-avatar">∞</div>
      <div>
        <h2 class="person-name">Union ${esc(fam.id)}</h2>
        <div class="person-sub">${esc(partners.map((id) => displayName(IDX.people[id])).join(" & ") || "Single partner")}</div>
        ${fam.marriage?.date ? `<div class="person-sub">${esc(fam.marriage.date)}</div>` : ""}
      </div>
    </div>`);

  if (partners.length) {
    parts.push(`<div class="section-title">Partners</div><div class="chips">${partners.map(personChip).join("")}</div>`);
  }
  if (children.length) {
    parts.push(`<div class="section-title">Offsprings</div><div class="chips">${children.map(personChip).join("")}</div>`);
  }
  const facts = [];
  if (attrs.REF_NAME) facts.push(factRow("Sheet reference", esc(attrs.REF_NAME)));
  if (fam.notes) facts.push(factRow("Notes", esc(fam.notes)));
  if (facts.length) parts.push(`<div class="section-title">Union record</div><ul class="facts">${facts.join("")}</ul>`);
  parts.push(`<p class="relation">Unions are derived from <code>spouseOf</code> edges in the KG tab; children come from <code>parentOf</code> and <code>childOf</code> edges.</p>`);
  return parts.join("");
}

function hidePanel() {
  $("#panel").hidden = true;
  $("#panel").classList.remove("vedic-open");
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
  const vedic = vedicFor(p);
  const auth = googleAuthFor(p);

  parts.push(`<button class="close" type="button" data-action="close" aria-label="Close">×</button>`);
  parts.push(`<div class="person-head" style="--tone:${toneVar(p.gender)}">
      ${avatarHTML(p, "avatar")}
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

  if (auth) {
    parts.push(`<div class="google-profile">
      ${auth.picture ? `<img src="${esc(auth.picture)}" alt="" referrerpolicy="no-referrer">` : ""}
      <div class="google-profile-text">
        <strong>${esc(auth.name || "Google account")}</strong>
        ${auth.email ? `<span>${esc(auth.email)}</span>` : ""}
        ${auth.sub ? `<span class="muted">Google account ID: ${esc(auth.sub)}</span>` : ""}
      </div>
    </div>`);
  }

  const buttons = [`<button class="btn primary" type="button" data-focus="${esc(p.id)}">Center tree here</button>`];
  if (state.meId === p.id) buttons.push(`<button class="btn" type="button" data-action="unme">Clear “me”</button>`);
  else if (!p.hidden) buttons.push(`<button class="btn" type="button" data-action="me" data-id="${esc(p.id)}">${esc(CFG.text.set_me)}</button>`);
  if (vedic) buttons.push(`<button class="btn vedic-btn" type="button" data-action="vedic" aria-expanded="false" aria-controls="vedic-${esc(p.id)}">Vedic roots</button>`);
  if (p.vedic?.chart) buttons.push(`<button class="btn jatagam-btn" type="button" data-action="jatagam" data-id="${esc(p.id)}">Jatagam</button>`);
  parts.push(`<div class="actions">${buttons.join("")}</div>`);

  if (vedic) {
    const rows = vedic.fields
      .map((f) => {
        const help = vedic.helps?.[f.key];
        const info = help
          ? `<button class="info-btn" type="button" data-info-key="${esc(f.key)}" aria-label="About ${esc(f.label)}">i</button>`
          : "";
        return `<li><span class="k">${esc(f.label)} ${info}</span><span>${f.html}</span></li>`;
      })
      .join("");
    const helpPayload = JSON.stringify(vedic.helps || {}).replace(/</g, "\\u003c");
    parts.push(`<section class="vedic-section" id="vedic-${esc(p.id)}" data-vedic="1" hidden>
      <div class="section-title">Vedic roots <button class="info-btn" type="button" data-info-key="vedic_roots" aria-label="About Vedic roots">i</button></div>
      <p class="vedic-lead">Gotra and pravara are derived from gotra and recited in Vedic rites.</p>
      <ul class="facts vedic-facts">${rows}</ul>
      <div class="vedic-help" data-vedic-help hidden></div>
      <script type="application/json" data-vedic-helps>${helpPayload}</script>
    </section>`);
  }

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

  // Ritual dates from the panchangam feed (built from this same tree).
  if (PANCHANG?.available && !p.hidden) {
    const tithiRows = PANCHANG.personRowsHTML(p.id);
    if (tithiRows) {
      parts.push(`<div class="section-title">Tithis</div><ul class="facts">${tithiRows}</ul>
        <p><button class="btn" type="button" data-action="panchang" data-id="${esc(p.id)}">Open in ${esc(CFG.text.panchang_tab || "Tithis")}</button></p>`);
    }
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

// ---------- Google sign-in ----------
//
// Client-side Google Identity Services. This identifies a visitor and can
// auto-set "This is me"; it is not access control. The published tree data is
// still public, so the only privacy gate is the importer: living people's
// places are reduced to city level in scripts/import_sheet.py.

function readStoredAuth() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.email ? parsed : null;
  } catch {
    return null;
  }
}

function decodeJwt(token) {
  const part = String(token || "").split(".")[1];
  if (!part) throw new Error("Invalid Google credential");
  const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function mappedPersonId(google, email) {
  const key = String(email || "").toLowerCase();
  if (!key) return null;

  // First check config.yml mapping
  const people = Object.fromEntries(
    Object.entries(google?.people || {}).map(([k, v]) => [String(k).toLowerCase(), v]),
  );
  let pid = people[key];
  if (pid && IDX?.people[pid] && !IDX.people[pid].hidden) return pid;

  // Fall back to EMAIL attribute in sheet data
  if (IDX?.people) {
    for (const [id, person] of Object.entries(IDX.people)) {
      if (person.hidden) continue;
      const personEmail = String(person.attributes?.EMAIL || "").toLowerCase();
      if (personEmail && personEmail === key) return id;
    }
  }

  return null;
}

function initAuth() {
  const google = treeAuth();
  const box = $("#auth");
  if (!box) return;
  if (!google?.client_id) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  if (window.google?.accounts?.id) {
    setupGoogle();
    return;
  }
  const script = document.createElement("script");
  script.src = "https://accounts.google.com/gsi/client";
  script.async = true;
  script.defer = true;
  script.onload = () => setupGoogle();
  script.onerror = () => {
    googleReady = false;
    renderAuth();
    if (!state.auth) box.hidden = true;
  };
  document.head.appendChild(script);
  renderAuth();
}

function setupGoogle() {
  const google = treeAuth();
  if (!google?.client_id || !window.google?.accounts?.id) return;
  googleReady = true;
  window.google.accounts.id.initialize({
    client_id: google.client_id,
    callback: handleGoogleCredential,
    auto_select: false,
    cancel_on_tap_outside: true,
  });
  renderAuth();
}

function renderAuth() {
  // While a tree is blocked for this visitor, render the sign-in button inside
  // the access-required message instead of the normal auth slot.
  const pending = $("#tree-signin");
  const box = pending || $("#auth");
  if (!box) return;
  const google = treeAuth();
  if (!google?.client_id) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;

  if (state.auth) {
    const name = state.auth.name || state.auth.email || "Google account";
    const person = state.auth.pid && IDX?.people[state.auth.pid] && !IDX.people[state.auth.pid].hidden
      ? IDX.people[state.auth.pid]
      : null;
    const avatar = state.auth.picture
      ? `<img class="auth-avatar" src="${esc(state.auth.picture)}" alt="" referrerpolicy="no-referrer">`
      : `<span class="auth-avatar">${esc((name[0] || "G").toUpperCase())}</span>`;
    box.innerHTML = `
      <button class="auth-chip" type="button" data-auth="toggle" aria-haspopup="menu" aria-expanded="false">
        ${avatar}<span class="auth-name">${esc(name)}</span>
      </button>
      <div class="auth-menu" id="auth-menu" role="menu" hidden>
        <div class="auth-menu-head"><strong>${esc(name)}</strong><span>${esc(state.auth.email || "")}</span></div>
        <div class="auth-menu-link">${person ? `Linked to ${esc(displayName(person))}` : "No family member is linked to this account."}</div>
        <button type="button" role="menuitem" data-auth="signout">Sign out</button>
      </div>`;
    return;
  }

  box.innerHTML = `${state.authError ? `<span class="auth-error" role="status">${esc(state.authError)}</span>` : ""}<div id="google-signin"></div>`;
  if (googleReady && window.google?.accounts?.id) {
    const slot = box.querySelector("#google-signin");
    if (slot) {
      window.google.accounts.id.renderButton(slot, {
        type: "standard",
        theme: document.documentElement.dataset.mode === "dark" ? "filled_black" : "outline",
        size: pending ? "large" : "large",
        shape: "pill",
        text: "signin_with",
        logo_alignment: "left",
        width: pending ? 250 : 190,
      });
    }
  }
}

function handleGoogleCredential(response) {
  const google = treeAuth();
  let payload;
  try {
    payload = decodeJwt(response.credential);
  } catch {
    setAuthError("Google sign-in failed. Please try again.");
    return;
  }
  if (!payload?.email) {
    setAuthError("Google did not return an email address.");
    return;
  }
  if (payload.email_verified === false) {
    setAuthError("Please verify your Google email first.");
    return;
  }

  const email = payload.email.toLowerCase();
  const allowed = (google.allowed_domains || []).map((d) => String(d).toLowerCase()).filter(Boolean);
  const allowedEmails = (google.allowed_emails || []).map((e) => String(e).toLowerCase()).filter(Boolean);
  const domain = email.split("@")[1] || "";
  if (allowedEmails.length && allowedEmails.includes(email)) {
    // explicit email allowlist wins
  } else if (allowed.length && !allowed.includes(domain)) {
    setAuthError(`Only ${allowed.join(", ")} accounts can sign in.`);
    return;
  }

  const linked = mappedPersonId(google, email);
  state.auth = {
    email,
    name: payload.name || "",
    picture: payload.picture || "",
    sub: payload.sub || "",
    pid: linked,
  };
  state.authError = null;
  localStorage.setItem(AUTH_KEY, JSON.stringify(state.auth));
  if (linked && google.auto_me !== false) {
    setMe(linked);
    state.authMe = true;
  }

  // If the current tree was blocked for this visitor, a successful sign-in may
  // now grant access; reload the tree data so the UI can unlock.
  const tree = treeById(state.tree);
  if (tree?.auth?.google) {
    if (!isAuthorizedForTree(tree)) {
      renderTreeAccessRequired();
      return;
    }
    if (!DATA) {
      loadTree(state.tree);
      return;
    }
  }

  renderAuth();
  renderTreeSelector();
  refreshMeChip();
  if (state.selected) selectPerson(state.selected, { silent: true });
}

function signOutGoogle() {
  const id = window.google?.accounts?.id;
  if (id?.disableAutoSelect) id.disableAutoSelect();
  const authPid = state.auth?.pid;
  localStorage.removeItem(AUTH_KEY);
  state.auth = null;
  state.authError = null;
  if (state.authMe && authPid && state.meId === authPid) setMe(null);
  state.authMe = false;
  renderAuth();
  refreshMeChip();
  if (state.selected) selectPerson(state.selected, { silent: true });
}

function setAuthError(message) {
  state.authError = message;
  renderAuth();
  window.setTimeout(() => {
    if (state.authError === message) {
      state.authError = null;
      renderAuth();
    }
  }, 6000);
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
      ${avatarHTML(p)}
      <span class="who"><strong>${esc(displayName(p))}</strong><span>${esc([yrs, p.birth?.place].filter(Boolean).join(" · "))}</span></span>
    </button>`;
  }
  const privateCount = DATA.people.length - visible.length;
  if (privateCount) html += `<p class="note-count">${privateCount} living family members are kept private.</p>`;
  $("#people-list").innerHTML = html || `<p class="note-count">No matches.</p>`;
}

// ---------- Panchangam (tithi calendar) ----------

async function openPanchang(personId, params) {
  const year = /^\d{4}$/.test(params.y || "") ? Number(params.y) : null;
  const kind = String(params.k || "");
  PANCHANG.state.person = personId && IDX.people[personId] ? personId : null;
  if (year && PANCHANG.years().includes(year)) PANCHANG.state.year = year;
  if (KIND_LABELS[kind]) PANCHANG.state.kind = kind;
  $("#panchang-list").innerHTML = `<p class="note-count">Loading…</p>`;
  renderPanchangControls();
  // A person view spans all years, so make sure every year is loaded.
  if (PANCHANG.state.person) await PANCHANG.prefetchAll();
  else await PANCHANG.ensureYear(PANCHANG.state.year);
  renderPanchang();
}

function renderPanchangControls() {
  const yearSel = $("#panchang-year");
  if (!yearSel.options.length) {
    yearSel.innerHTML = PANCHANG.years().map((y) => `<option value="${y}">${y}</option>`).join("");
  }
  yearSel.value = String(PANCHANG.state.year);
  yearSel.disabled = Boolean(PANCHANG.state.person);
  const kindSel = $("#panchang-kind");
  if (!kindSel.options.length) {
    const counts = PANCHANG.index?.counts || {};
    const kinds = KIND_ORDER.filter((k) => counts[k]);
    kindSel.innerHTML = `<option value="">All events</option>`
      + kinds.map((k) => `<option value="${k}">${esc(KIND_LABELS[k])}</option>`).join("");
  }
  kindSel.value = PANCHANG.state.kind;
  const filter = $("#panchang-filter");
  if (document.activeElement !== filter && filter.value !== PANCHANG.state.q) filter.value = PANCHANG.state.q;
}

function renderPanchang() {
  if (!PANCHANG?.available) return;
  renderPanchangControls();
  const banner = $("#panchang-person-banner");
  if (PANCHANG.state.person && IDX.people[PANCHANG.state.person]) {
    banner.hidden = false;
    banner.innerHTML = `Tithis for <strong>${esc(nameOf(PANCHANG.state.person))}</strong>, all years. <button class="btn" type="button" data-panchang-action="clear-person">Show everyone</button>`;
  } else {
    banner.hidden = true;
    banner.innerHTML = "";
  }
  const sub = $("#panchang-subscribe");
  if (sub && !sub.dataset.done) {
    const feed = PANCHANG.feedUrl();
    sub.innerHTML = feed ? `<a href="${esc(feed)}">Subscribe to the calendar (.ics)</a>` : "";
    sub.dataset.done = "1";
  }
  $("#panchang-list").innerHTML = panchangListHTML(PANCHANG.events(), PANCHANG.helpers);
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
      ${names ? `<div class="section-title">${esc(CFG.text.tagged_people)}</div><div class="chips">${names}</div>` : ""}
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

function bindTopbar() {
  const topbar = $("#topbar");
  const topbarToggle = $("#topbar-toggle");
  if (!topbar || !topbarToggle || topbarToggle.dataset.bound) return;
  topbarToggle.dataset.bound = "1";
  topbarToggle.addEventListener("click", () => {
    const expanded = topbar.classList.toggle("expanded");
    topbarToggle.setAttribute("aria-expanded", String(expanded));
  });
  // Close the mobile tray when a navigation or search choice is made.
  $("#topbar-tray").addEventListener("click", (e) => {
    if (e.target.closest(".tabs a, .me-chip, .auth-chip, #search, #tree-select")) {
      topbar.classList.remove("expanded");
      topbarToggle.setAttribute("aria-expanded", "false");
    }
  });
  document.addEventListener("click", (e) => {
    if (!topbar.classList.contains("expanded")) return;
    if (e.target.closest("#topbar")) return;
    topbar.classList.remove("expanded");
    topbarToggle.setAttribute("aria-expanded", "false");
  });
}

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
    go("tree", state.focus, { v: b.dataset.view, o: state.orientation });
  });

  $("#orientation-switch").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-orientation]");
    if (!b) return;
    go("tree", state.focus, { v: state.view, o: b.dataset.orientation });
  });

  $("#wheel-rings").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-rings]");
    if (!b) return;
    const rings = Number(b.dataset.rings);
    // Ignore clicks on the ring count that is already in effect.
    if (rings === (state.wheelRings ?? state.layout?.rings)) return;
    go("tree", state.focus, { v: "wheel", o: state.orientation, r: rings });
  });

  $("#wheel-mode").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (!b) return;
    // Ignore clicks on the direction that is already in effect.
    if (b.dataset.mode === (state.wheelMode ?? state.layout?.mode)) return;
    go("tree", state.focus, { v: "wheel", o: state.orientation, m: b.dataset.mode });
  });

  $("#list-stage").addEventListener("click", (e) => {
    const action = e.target.closest("[data-list-action]");
    if (action) {
      if (action.dataset.listAction === "expand") {
        state.collapsed.clear();
      } else {
        const full = layoutOutline(IDX, state.focus, {});
        if (full) {
          state.collapsed = new Set(full.rows
            .filter((row) => row.kind === "person" && row.hasDetails)
            .map((row) => row.personId));
        }
      }
      state.listGen = null;
      renderListStage(state.focus, { preserveScroll: true });
      renderGenerationsRail();
      return;
    }

    const toggle = e.target.closest("[data-toggle-person]");
    if (toggle) {
      const id = toggle.dataset.togglePerson;
      if (!id) return;
      if (state.collapsed.has(id)) state.collapsed.delete(id);
      else state.collapsed.add(id);
      state.listGen = null;
      renderListStage(state.focus, { preserveScroll: true });
      document.querySelector(`#list-stage [data-toggle-person="${id}"]`)?.focus({ preventScroll: true });
      renderGenerationsRail();
      return;
    }

    const pill = e.target.closest(".outline-pill[data-person]");
    if (!pill) return;
    const id = pill.dataset.person;
    if (id && IDX.people[id]) selectPerson(id);
  });

  $("#cards").addEventListener("click", (e) => {
    if (dragMoved) return;
    const union = e.target.closest("[data-union]");
    if (union) return selectUnion(union.dataset.union);
    const card = e.target.closest("[data-card]");
    if (card) selectPerson(card.dataset.card);
  });

  $("#gen-rail").addEventListener("click", (e) => {
    const b = e.target.closest("[data-gen]");
    if (!b) return;
    jumpToGeneration(b.dataset.gen);
  });

  $("#panel").addEventListener("click", (e) => {
    const t = e.target.closest("[data-focus],[data-story],[data-action],[data-info-key]");
    if (!t) return;
    if (t.dataset.infoKey) {
      const section = t.closest(".vedic-section");
      const payload = section?.querySelector("[data-vedic-helps]");
      const box = section?.querySelector("[data-vedic-help]");
      let help = null;
      try {
        help = payload ? JSON.parse(payload.textContent || "{}")[t.dataset.infoKey] : null;
      } catch {
        help = null;
      }
      if (!help || !box) return;
      const open = box.hidden;
      box.hidden = !open;
      box.innerHTML = open
        ? `<strong>${esc(help.title)}</strong><p>${esc(help.text)}</p>${help.source ? `<a href="${esc(help.source)}" target="_blank" rel="noopener noreferrer">Learn more</a>` : ""}`
        : "";
      t.classList.toggle("is-open", open);
      t.setAttribute("aria-expanded", String(open));
      return;
    }
    if (t.dataset.action === "vedic") {
      const section = $("#panel .vedic-section");
      if (!section) return;
      const open = section.hidden;
      section.hidden = !open;
      t.setAttribute("aria-expanded", String(open));
      t.classList.toggle("is-open", open);
      $("#panel").classList.toggle("vedic-open", open);
      return;
    }
    if (t.dataset.action === "jatagam") {
      return openJatagam(t.dataset.id);
    }
    if (t.dataset.action === "panchang") return go("panchang", t.dataset.id);
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
    if (t.dataset.focus) return go("tree", t.dataset.focus, { v: state.view, o: state.orientation });
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
      return go("tree", t.dataset.focus, { v: state.view, o: state.orientation });
    }
  });

  $("#me-chip").addEventListener("click", () => {
    if (state.meId) go("tree", state.meId, { v: state.view, o: state.orientation });
  });

  bindTopbar();

  const chartModal = $("#chart-modal");
  if (chartModal) {
    chartModal.addEventListener("click", (e) => {
      const action = e.target.closest("[data-chart]")?.dataset.chart;
      if (action === "close") return closeJatagam();
      if (action === "print") return window.print();
      if (e.target === chartModal) closeJatagam();  // backdrop click
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !chartModal.hidden) closeJatagam();
    });
  }

  $("#auth").addEventListener("click", (e) => {
    const toggle = e.target.closest('[data-auth="toggle"]');
    if (toggle) {
      const menu = $("#auth-menu");
      if (menu) {
        menu.hidden = !menu.hidden;
        toggle.setAttribute("aria-expanded", String(!menu.hidden));
      }
      return;
    }
    if (e.target.closest('[data-auth="signout"]')) signOutGoogle();
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest("#auth")) return;
    const menu = $("#auth-menu");
    if (menu && !menu.hidden) {
      menu.hidden = true;
      $('[data-auth="toggle"]')?.setAttribute("aria-expanded", "false");
    }
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
      go("tree", id, { v: state.view, o: state.orientation });
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

  $("#panchang-year").addEventListener("change", (e) => {
    PANCHANG.state.year = Number(e.target.value);
    PANCHANG.ensureYear(PANCHANG.state.year).then(renderPanchang);
  });
  $("#panchang-kind").addEventListener("change", (e) => {
    PANCHANG.state.kind = e.target.value;
    renderPanchang();
  });
  $("#panchang-filter").addEventListener("input", (e) => {
    PANCHANG.state.q = e.target.value;
    renderPanchang();
  });
  $("#view-panchang").addEventListener("click", (e) => {
    const action = e.target.closest("[data-panchang-action]");
    if (action?.dataset.panchangAction === "clear-person") go("panchang");
  });

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
