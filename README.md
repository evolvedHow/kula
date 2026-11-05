# Kula family tree

A static, browser-only family tree. The public site is published with GitHub
Pages from the `docs/` folder.

The **Google Sheet is the source of truth** for people, unions and offsprings.
The older Gramps importer remains available as a fallback.

## Updating the tree

1. Make sure the sheet is shared as **Anyone with the link can view**.
2. Set up the importer environment once (a virtualenv keeps the optional
   horoscope dependencies isolated):

   ```
   python3 -m venv .venv
   .venv/bin/pip install -r requirements.txt
   ```

3. Rebuild the public data (the sheet URL is now required on the command
   line):

   ```
   .venv/bin/python scripts/import_sheet.py --url "YOUR_GOOGLE_SHEET_URL"
   ```

   The importer downloads the workbook, caches it in
   `private/relatives-sheet.xlsx`, and writes `docs/data/tree.json`. It reads
   the `Persons`, `Vedic`, `$Config`, `Unions`, `Offsprings` and `Stories` tabs
   directly. A local `.xlsx` can be used instead:

   ```
   .venv/bin/python scripts/import_sheet.py --url "YOUR_GOOGLE_SHEET_URL" private/relatives.xlsx
   ```

   To ignore the older authority sheet and use only the relational sheet:

   ```
   .venv/bin/python scripts/import_sheet.py --url "YOUR_GOOGLE_SHEET_URL" --override
   ```

   If `source.authority` is configured, the older hierarchical family sheet is
   downloaded too and merged over the `Persons` tab (see below). Pass
   `--authority path/to/original.xlsx` to use a local copy instead.

4. Run the front-end and importer tests, then commit and push the changed
   data/config:

   ```
   node --test scripts/test_frontend.mjs
   .venv/bin/python -m unittest scripts.test_authority scripts.test_import_sheet scripts.test_horoscope
   git add docs scripts README.md requirements.txt
   git commit -m "Update family data"
   git push
   ```

`private/` is git-ignored. Only `docs/` is published.

## Reusing the app for another family

The application code contains no family names, IDs, emails or sheet URLs.
Everything specific to an instance lives in configuration or data:

* `docs/config.yml` — title, sheet URL, default person, theme, Google account
  mapping, repo, tab names.
* `docs/data/vedic.json` — gotra → pravara mappings, aliases and help text.
* `docs/data/tree.json` — generated from the sheet; do not edit by hand.

To start a new instance, copy the repo, point `source.sheet_url` at your
workbook, change `site.default_person` and `auth.google.people`, and run the
importer. The sheet tabs and column headers are documented below; the tab names
can be overridden in `source.tabs`.

### Sheet layout

| Tab | Purpose |
| --- | --- |
| `Persons` | `PID`, names, `EMAIL` (for Google sign-in), gender, `DOB`, `POB`, current location, `STATUS`, `DOD` (date of death), optional `POD` (place of death), notes, `GEN` (generation: A, B, C, …) |
| `Vedic` | Per-person gotra, veda, shakha, sutra, nakshatra, kula devatha, sampradaya (Iyengar), acharya thirumaligai (Iyengar), purvikam, parvata. Lineage fields are inherited down the paternal line; after marriage a woman takes her husband's lineage but keeps her own nakshatra |
| `$Config` | Gotra defaults for veda, shakha, sutra and nakshatra |
| `Unions` | `UID`, `PID1`, `PID2`, `REF_NAME`, relationship dates and notes |
| `Offsprings` | `OID`, `UNION_OF`, `OFFSPRING`, notes |

`PID1`, `PID2`, `UNION_OF` and `OFFSPRING` contain readable keys of the form
`<PID>-<KNOWN_NAME>`, for example `P049-Sriram`. The known name is only a
data-entry convenience: the PID prefix is the real key, and it keeps the
reference unambiguous when two people share a known name. The importer resolves
every relationship by that PID (falling back to an exact `REF_NAME` or a unique
known name for hand-edited sheets), and all internal relationships are stored
by PID. A name edit therefore does not break a union or offspring link.

The generated JSON keeps every original column as an attribute on the person
or union node and on the offspring edge. The site graph has:

* `person` nodes for every `Persons` row;
* `union` nodes for every `Unions` row;
* `partner` edges from a person to their union;
* `offspring` edges from a union to each child.

### Original sheet authority

The older hierarchical family sheet is still the authority for birth, death
and living status. Configure it under `source.authority`; the current URL and
cache path live in `docs/config.yml`. The importer:

1. finds the header row by column name (so a title block, reordered columns or
   differently worded headers are fine);
2. fuzzy-matches each authority row to a `Persons` row by full name;
3. uses birth day/month, birth place and living status only to break ties
   between similar or duplicate names;
4. overrides **only** non-empty `DOB`, `POB`, `STATUS`, `DOD` and `POD` values.

A blank authority cell never erases data already in the `Persons` tab. Because
the merge happens before chart generation, an authoritative `DOB` and `POB`
also drive the jatagam. Every override is printed by the importer, along with
unmatched authority rows and impossible dates such as a death before birth.
Remove the `source.authority` block to import only the relational sheet.

Tab names and header aliases can be changed in the same block, so the importer
can be reused with another family's workbook. A data-less stub row (a name but
no dates or status) is ignored.

### Living people

Locations for anyone whose `STATUS` is not `Deceased` are reduced to the city
level before publishing (for example `Marietta, Georgia, USA` becomes
`Marietta`). Birth places are treated the same way. This is a build-time rule
in `scripts/import_sheet.py`.

### Gramps fallback

To rebuild from a Gramps export instead:

```
python3 scripts/build_site.py private/export.gramps
```

The Gramps path does not create graph data, so the Relatives view is hidden
until the sheet importer is used again.

## Relatives view

The tree toolbar has five views: **Both**, **Ancestors**, **Descendants**,
**Relatives** and **List**. Relatives is a two-kind graph layout: people are
cards, unions are small round nodes, and the connector lines are the partner
and offspring edges from the sheet. It opens on the connected branch around the
current focus, so unrelated branches do not make one enormous row. Click a
union node to see its partners, offsprings, relationship date and original
sheet fields.

`layout.orientation` switches vertical (generations top-to-bottom) and
horizontal (left-to-right). `layout.default_view: graph` makes Relatives the
opening view. Panning and zooming are yours: opening a card's details and
closing the panel again never moves or re-fits the chart — it stays exactly
where you left it.

### Relationship terms

Relationship labels are computed from the `parent_family`, `families` and
`children` links in `tree.json` — never from the `GEN` column, row order or
the readable half of a reference. The labels use the family's everyday terms:

* direct line: father/mother, grandfather/grandmother, son/daughter,
  grandson/granddaughter, with `great-` added per generation;
* spouse, brother/sister, aunt/uncle, nephew/niece;
* a **cousin's child** is a **niece/nephew**, not a "first cousin once
  removed"; a cousin's grandchild is a grand-niece/nephew, and so on;
* in the other direction, a **parent's cousin** is an **aunt/uncle**.

More distant collateral links (for example second cousins or a cousin three
generations away) fall back to the standard `Nth cousin M times removed`
wording. Only blood links and the direct spouse link are labelled; in-laws,
step and adoptive links are not inferred, so those profiles show no family
link unless the two people are also blood relatives.

## List view

**List** is a fully expanded, indented outline of the family. It always walks
up from the focused person to their oldest known ancestor and then runs
downward, so opening a grandchild still shows the whole family from its
founder. Couples who are both oldest ancestors are treated as one root, not
two duplicate trees.

Each person is a pill showing an ID, a ♂/♀ gender icon, the full name (never
truncated) and their years when known. A person's union appears as a separate
dashed ⚭ pill at the same indent level, and that union's offspring move one
indent level deeper. Multiple unions get one row each, and children are ordered
eldest-first. A person reached through two lines (for example cousins who
marry) is listed once.

The vertical indent guides and row markers use two colours: the theme accent
for direct descendants, and a warm amber (`--union-line`) for spouses and union
rows. Clicking any person pill opens their card in the details panel without
re-rooting the list. The outline is always fully expanded; the page scrolls
vertically and horizontally, so deep generations and long names stay readable.
On narrow screens List is the default view, while desktops continue to open
with the configured `layout.default_view`. The hierarchy views remain
available and are unchanged.

## Mobile layout

On narrow screens the top bar collapses to a compact header: the brand and a
menu button stay visible, while the section tabs, search, "me" chip and Google
sign-in tuck into a dropdown tray. Tap the menu button to open the tray and
make a selection; tap outside or choose an item to close it again.

## Vedic roots and pravara

When a person has Vedic data, their profile shows a **Vedic roots** button. It
opens gotra, pravara, pravara type, veda, shakha, sutra, nakshatra, kula
devatha, sampradaya (for Iyengars), acharya thirumaligai (for Iyengars),
purvikam, and parvata where present. Each field has an **i** help button that
explains the concept.

Vedic **lineage fields** are inherited down the paternal line: if a child’s
Vedic tab is empty, the importer copies gotra, veda, shakha, sutra, kula
devatha, sampradaya, acharya thirumaligai, purvikam and parvata from the
father (and, if needed, from the grandfather) so the patrilineal lineage stays
consistent without re-entering every field for each generation.

Two rules keep the lineage and the birth data separate:

* **Marriage.** Once a woman is recorded in a `Unions` row with a husband,
  she inherits his lineage fields. Her own nakshatra is not replaced. If the
  husband has no recorded lineage, her existing values are left in place
  rather than being erased.
* **Nakshatra is personal.** It follows the place, date and time of birth and
  is computed from the jatagam. It is never inherited from a parent or a
  spouse, so family spellings are not copied down the line.

Pravara is **derived from gotra at runtime**. It is never stored in
`tree.json`, so a stale or contradictory pravara value cannot exist. The
canonical map is `docs/data/vedic.json`:

```json
{
  "gotras": {
    "bharadwaja": {
      "display": "Bharadwaja",
      "pravara": ["Angirasa", "Barhaspatya", "Bharadwaja"],
      "type": "Tryarsheya"
    }
  }
}
```

Built-in mappings:

| Gotra | Pravara | Type |
| --- | --- | --- |
| Bharadwaja | Angirasa, Barhaspatya, Bharadwaja | Tryarsheya |
| Kashyapa | Kashyapa, Avatsara, Naidhruva | Tryarsheya |
| Srivatsa | Bhargava, Chyavana, Apnavana, Aurva, Jamadagnya | Pancharsheya |
| Harita | Angirasa, Ambarisha, Yuvanasva | Tryarsheya |

Add aliases (for example `sreevatsa` or `kasyapa`) in the same file. Unknown
gotras show no invented pravara. The help text and source links also live in
`docs/data/vedic.json` under `concepts`.

## Birth charts (jatagam)

When a person's birth details are complete, their profile also shows a
**Jatagam** button. It opens a South Indian square chart plus a positions
report, with a **Print** button for a clean paper copy.

A chart is computed only when **all three** are present:

- a **DOB with a time**
- a **POB** (birth place)
- the `vedic.charts` setting enabled in `docs/config.yml` (on by default)

Otherwise there is no button — date-only births simply show their date.

### Entering birth details

The safest format is a **real Google Sheets date-time cell**:

1. Select the DOB column → **Format → Number → Date time**
2. Enter values like `15/08/1950 14:30` (dd/mm/yyyy, 24-hour, **local time at
   the birthplace**)

Text dates also work as a fallback: `15 Aug 1950 14:30`, `August 15, 1950
2:30 PM`, or ISO `1950-08-15T14:30`. A time of exactly `00:00` means "no time
given", so no chart is produced. Dates before 1927 must be entered as text
(Sheets serial numbers for those are only four digits and are ambiguous with
plain years).

Place names are geocoded automatically from the `POB` column. To pin a place
that resolves to the wrong town, or to force a timezone, add an override:

```yaml
places:
  Valliyur: { lat: 8.3833, lon: 77.6667, tz: "Asia/Kolkata" }
  Marietta: { lat: 33.9526, lon: -84.5499, tz: "America/New_York" }
```

Overrides always win over the `private/geocache.json` cache, which stores
earlier Nominatim lookups (one request per second). The timezone falls back to
offline lookup from the coordinates, then to `Asia/Kolkata`.

### How it is computed

Charts are computed **at import time** — the site stays fully static with no
backend. The engine is Swiss Ephemeris (`pyswisseph`) using the **Lahiri
ayanamsa** (sidereal), with the nine grahas (Sun through Ketu, Rahu as the mean
node) and the lagna from the birth moment. It also supplies the Moon's rashi,
nakshatra and pada, so the sheet no longer needs `RASHI`, `PADA` or `NAKSHATRA`
columns (nakshatra is derived, and can also be inherited paternally for people
without a chart).
The computed payload is stored at `person.vedic.chart`; `counts.charts` in
`tree.json` reports how many were built.

### Privacy note

A birth chart needs a **birth time and place**, and for living people that
information becomes part of the published `docs/data/tree.json`. If that is a
concern, leave their DOB time blank and no chart is generated. Locations are
already reduced to city level for living people.

### Troubleshooting

- **Charts are 0 after import:** DOB cells likely have dates but no times.
- **A DOB shows the current year with no time:** Google Sheets assigns the
  current year when you type only a day and month into a date cell. If the
  year is unknown, enter it as text instead (for example `29 June`); the
  importer warns about these.
- **"pyswisseph is not installed" warning:** run the importer with the
  project virtualenv (`.venv/bin/python scripts/import_sheet.py`), not the
  system `python3`.
- **A place cannot be geocoded:** add it under `places:` in
  `docs/config.yml`. Use `--offline` to avoid network lookups entirely.

## Configuration

Everything is in `docs/config.yml`: site title, colours (`theme.preset`),
fonts, layout, sign-in and privacy. Reload the page to see most changes.

The default theme is `sage`, a Material 3 sage-green palette, with
self-hosted Roboto.

## Google sign-in

`auth.google` adds an optional "Sign in with Google" button. It maps a Google
email to a sheet PID, sets "This is me" automatically, and lets the linked
person inherit the signed-in account's Gmail avatar:

```yaml
auth:
  google:
    client_id: "YOUR_WEB_CLIENT_ID.apps.googleusercontent.com"
    allowed_domains: ["gmail.com"]
    people:
      "you@gmail.com": P001
    auto_me: true
```

**Email matching:** The sign-in checks two places (in order):

1. `auth.google.people` in `config.yml` — explicit email → PID mapping
2. The `EMAIL` column in the Persons tab — put each person's Gmail address
   there and sign-in links them automatically, no config edit needed

Create an OAuth 2.0 Web client in Google Cloud Console, configure the OAuth
consent screen, and add the site origin (for example
`https://evolvedhow.github.io`) to **Authorized JavaScript origins**. While the
consent screen is in Testing mode, only listed test users can sign in. Leave
`client_id` empty to hide the button.

The avatar, email and Google account ID are shown only in the signed-in
visitor's browser on their linked person's profile. They are never written
into the published JSON. This is client-side sign-in only: it personalizes the
experience but does not make the site private.

## Hierarchical ID renumbering (optional)

The default PIDs (P001, I000, etc.) are assigned sequentially as people are
added to the sheet. For a more meaningful structure, you can renumber them to
show the generation hierarchy:

```bash
python3 scripts/renumber_hierarchical.py --dry-run  # Preview changes
python3 scripts/renumber_hierarchical.py            # Generate renumbered tree
```

This creates:
- `docs/data/tree-renumbered.json` — the renumbered tree
- `private/id-mapping.csv` — old ID → new ID mapping

New IDs follow the pattern:
- `p.A001`, `p.A002` — Generation 1 (patriarch & matriarch)
- `p.B001`, `p.B002` — Generation 2 (their children)
- `p.C001`, `p.C002` — Generation 3 (grandchildren)
- `u.A001`, `u.B001` — Unions in each generation

To use the renumbered IDs:
1. Review `tree-renumbered.json` and `id-mapping.csv`
2. Update your Google Sheet PIDs using the CSV mapping (Find & Replace or
   VLOOKUP)
3. Copy `tree-renumbered.json` → `tree.json`
4. Commit and push

**Note:** This is purely cosmetic. The underlying relationships don't change,
only the IDs. You can keep using simple sequential IDs if you prefer.

## Preview locally

```
cd docs && python3 -m http.server 8000
```

Then open http://localhost:8000.
