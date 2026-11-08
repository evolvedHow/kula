# AGENTS.md

Notes for agents working in this repo.

## Project

Static, browser-only family tree ("Kula") published with GitHub Pages from
`docs/`. **Public repo** — never commit private data (the untracked `rawdata/`
CSV dump predates the panchang work and stays untracked; `private/` is
gitignored).

- Source of truth: a Google Sheet → `scripts/import_sheet.py` →
  `docs/data/tree.json`. Never edit `tree.json` by hand; regenerate it.
- Relationships are entered in the sheet's `KG` tab as readable triples
  (`SUBJECT`, `PREDICATE`, `OBJECT`), e.g. `P-101-Himavan spouseOf P-102-Mena`.
  `import_sheet.py` extracts the PID prefix and builds the union/children model.
  If `KG` is empty, the importer falls back to the legacy `Unions`/`Offsprings` tabs.
- Config: `docs/config.yml` (site, theme, auth, `panchang:` block, plus
  `source.tabs` for sheet tab names).
- Python work always uses the venv: `.venv/bin/python`.
- Frontend is ES modules in `docs/assets/`, no build step. Modules are pure
  string/DOM-free where possible so they can be tested in Node via
  `data:` URL imports: `node --test scripts/test_frontend.mjs`.

## Panchangam / tithi calendar (added Nov 2026)

- Engine: `scripts/panchang/` (config, astronomy, engine, matcher, festivals,
  sources, ics, server, google_calendar, cli). Wrapper: `scripts/panchangam.py`.
  Tests: `scripts/test_panchang.py`.
- Astronomy: Swiss Ephemeris (`pyswisseph`), **Lahiri ayanamsha**, sidereal.
  Ritual rules: death tithi at **aparahna** (13:30–16:00) when no death time,
  birth nakshatra at sunrise, solar masa at sunrise (Tamil tradition;
  `masa_system: solar`), lunar amanta month kept as tie-breaker when a tithi
  occurs twice in one solar month.
- Build: `.venv/bin/python -m scripts.panchang build --years 2026,2027` →
  `docs/data/panchang/` (index.json + per-year `panchang-<year>.json/.ics` +
  combined `panchang.json/.ics`). `--daily`/`--members` write large optional
  dumps (not needed by the site). `.venv/bin/python -m scripts.panchang
  validate` runs sanity checks; `explain <PID> --year Y` shows a derivation.
- Site integration: Tithis tab (`#/panchang`, `#/panchang/<PID>`,
  `?y=YYYY&k=kind`) rendered by `docs/assets/panchang.js`; profile panels list
  the member's ritual dates. Tab hides itself when `data/panchang/index.json`
  is absent.
- CI: `.github/workflows/panchang.yml` rebuilds and commits the feed on pushes
  touching `tree.json`/config/engine and every December (current + next year).
  `docs/data/panchang/` is excluded from the push trigger to prevent loops.

## Gotchas learned the hard way

- **Festival rules must match the tithi at ONE reference instant**
  (`festivals.py`, `reference="sunrise"` default, `aparahna` for Amavasya
  observances). Matching "tithi present anytime in the day" put Vinayaka
  Chaturthi and Deepavali on two consecutive days.
- **Never evaluate `solar_sign` at the exact ingress instant** — the boundary
  longitude is numerically ambiguous (29.999… vs 30.0…) and flips between
  pyswisseph builds (local 20230604 vs CI latest). Evaluate ~1h past the
  boundary. This put Puthandu on both 14 Apr and 15 May 2026 in CI while
  locally fine; the fix made Pongal (14 Jan) appear too.
- `swe.calc_ut` here takes exactly 3 args and returns `(values, retflags)`;
  `swe.CALC_MTRANS` is absent (solar_noon falls back to sunrise/sunset
  midpoint).
- Sheet date strings are messy (`"Jan-1/1895 0:0"`, Excel serials, bare years);
  use `sources.parse_date_time`, not `horoscope.parse_birth`.
- Trust CI more than local green runs: CI installs latest `pyswisseph`, local
  `.venv` is pinned older — numeric boundary bugs show up only there. The bot
  therefore rebuilds the feed with slightly different numerics and commits
  them ("Rebuild panchang feed …"); `git pull --rebase` before pushing again
  after engine changes.
- Committer identity is the auto-configured `root <root@gunnytop.localdomain>`
  (matches all existing history); user has authorized commit+push on `main`.

## Verified reference dates (regression anchors)

- C008 Lakshmi Ganapathy: died 11 Aug 1994 → sunrise Chaturthi but aparahna
  **Sukla Panchami**, Karka/Shravana → 2026 shraddha **2026-08-17** = Garuda
  Panchami (not 07-18, which is Ashadha); 2027 shraddha 2027-08-06.
- 2026: 12 Amavasya days, aparahna rule; 2026-11-08 is the Aippasi one.
  Festivals: Pongal 01-14, Puthandu 04-14, Vinayaka Chaturthi 09-15,
  Mahalaya 10-10, Deepavali 12-08.
- Feed sizes: ~160 events/year (30 shraddha, ~98 janma nakshatra, 12–13
  Amavasya, 12–13 Purnima, ~8 festivals).

## Test / check suite

```bash
.venv/bin/python -m scripts.panchang validate
.venv/bin/python -m unittest scripts.test_panchang scripts.test_horoscope
node --test scripts/test_frontend.mjs
```

Headless UI smoke test works: `python3 -m http.server` in `docs/`, then
`google-chrome --headless=new --dump-dom "http://127.0.0.1:PORT/#/panchang"`.
