// South Indian birth chart (jatagam) renderer. Pure functions so they can be
// tested in Node; the browser wires them to the Jatagam button in app.js.
//
// South Indian convention: the twelve rasis are FIXED to boxes (Mesha is
// always the second box of the top row, running clockwise), grahas are placed
// into their rasis, and the lagna's box carries the ascendant mark.

export const RASI_BOXES = [
  { sign: "Meena", row: 0, col: 0 },
  { sign: "Mesha", row: 0, col: 1 },
  { sign: "Vrishabha", row: 0, col: 2 },
  { sign: "Mithuna", row: 0, col: 3 },
  { sign: "Kumbha", row: 1, col: 0 },
  { sign: "Kataka", row: 1, col: 3 },
  { sign: "Makara", row: 2, col: 0 },
  { sign: "Simha", row: 2, col: 3 },
  { sign: "Dhanus", row: 3, col: 0 },
  { sign: "Vrischika", row: 3, col: 1 },
  { sign: "Tula", row: 3, col: 2 },
  { sign: "Kanya", row: 3, col: 3 },
];

export const GRAHA_ORDER = ["Su", "Mo", "Ma", "Me", "Ju", "Ve", "Sa", "Ra", "Ke"];

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export function degText(deg) {
  const d = Math.floor(deg);
  const m = Math.round((deg - d) * 60) % 60;
  return `${d}°${String(m).padStart(2, "0")}′`;
}

function grahaTitle(code, planet) {
  if (!planet) return code === "La" ? "Lagna (ascendant)" : code;
  const retro = planet.retro && code !== "Ke" ? " (retrograde)" : "";
  return `${planet.name} — ${degText(planet.deg)} ${planet.rasi}, ${planet.nakshatra} pada ${planet.pada}${retro}`;
}

/** Render the 4×4 South Indian square chart as an HTML string. */
export function renderSouthIndianChart(chart, opts = {}) {
  if (!chart || !chart.rasis) return "";
  const boxes = RASI_BOXES.map(({ sign, row, col }) => {
    const occupants = chart.rasis[sign] || [];
    const isLagna = chart.lagna === sign;
    const chips = occupants.map((code) => {
      const planet = chart.planets?.[code];
      const title = code === "La" ? "Lagna (ascendant)" : grahaTitle(code, planet);
      const retro = planet?.retro && code !== "Ke" && code !== "Ra"
        ? `<span class="retro" aria-label="retrograde">*</span>`
        : "";
      return `<span class="graha graha-${esc(code)}" title="${esc(title)}">${esc(code)}${retro}</span>`;
    }).join("");
    return `<div class="rasi-box${isLagna ? " lagna" : ""}" style="grid-row:${row + 1};grid-column:${col + 1}" data-sign="${esc(sign)}">
      <span class="rasi-name">${esc(sign)}</span>
      <span class="grahas">${chips}</span>
    </div>`;
  }).join("");

  const center = `
    <div class="chart-center" style="grid-row:2 / span 2;grid-column:2 / span 2">
      <strong>${esc(opts.name || "Jatagam")}</strong>
      ${opts.birthText ? `<span>${esc(opts.birthText)}</span>` : ""}
      <span>Lagna: ${esc(chart.lagna)}</span>
    </div>`;

  return `<div class="si-chart" role="img" aria-label="South Indian birth chart, lagna ${esc(chart.lagna)}">${boxes}${center}</div>`;
}

/** Render the positions report table (goes under the chart, and prints). */
export function renderChartReport(chart, opts = {}) {
  if (!chart || !chart.planets) return "";
  const rows = [];
  rows.push(`<tr><th scope="row">Lagna</th><td>${esc(chart.lagna)}</td><td>${esc(degText(chart.lagna_deg || 0))}</td><td>—</td><td>—</td><td></td></tr>`);
  for (const code of GRAHA_ORDER) {
    const p = chart.planets[code];
    if (!p) continue;
    rows.push(`<tr>
      <th scope="row">${esc(p.name)}</th>
      <td>${esc(p.rasi)}</td>
      <td>${esc(degText(p.deg))}</td>
      <td>${esc(p.nakshatra)}</td>
      <td>${esc(p.pada)}</td>
      <td>${p.retro ? "Retrograde" : ""}</td>
    </tr>`);
  }
  const moon = chart.moon || {};
  return `<div class="chart-report">
    <ul class="chart-summary">
      <li><span class="k">Lagna</span><span>${esc(chart.lagna)}</span></li>
      <li><span class="k">Moon rashi</span><span>${esc(moon.rashi || "—")}</span></li>
      <li><span class="k">Janma nakshatra</span><span>${esc(moon.nakshatra || "—")}${moon.pada ? `, pada ${esc(moon.pada)}` : ""}</span></li>
    </ul>
    <table class="chart-table">
      <thead><tr><th>Graha</th><th>Rasi</th><th>Degree</th><th>Nakshatra</th><th>Pada</th><th></th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>
    ${opts.disclaimer ? `<p class="chart-disclaimer">${esc(opts.disclaimer)}</p>` : ""}
    <p class="chart-engine">Computed with Swiss Ephemeris, Lahiri ayanamsa (sidereal). Birth time in the birthplace's local time zone.</p>
  </div>`;
}

/** Full modal body: chart + report together. */
export function renderJatagam(chart, opts = {}) {
  const grid = renderSouthIndianChart(chart, opts);
  const report = renderChartReport(chart, opts);
  if (!grid && !report) return "";
  return `<div class="jatagam">${grid}${report}</div>`;
}
