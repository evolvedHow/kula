# Kula family tree

A static, browser-only family tree. The public site is published with GitHub
Pages from the `docs/` folder.

The **Google Sheet is the source of truth** for people, unions and offsprings.
The older Gramps importer remains available as a fallback.

## Updating the tree

1. Make sure the sheet is shared as **Anyone with the link can view**.
2. Rebuild the public data (requires Python 3 and PyYAML):

   ```
   pip install -r requirements.txt
   python3 scripts/import_sheet.py
   ```

   The importer downloads the workbook, caches it in
   `private/relatives-sheet.xlsx`, and writes `docs/data/tree.json`. It reads
   the `Persons`, `Vedic`, `$Config`, `Unions` and `Offsprings` tabs directly.
   A local `.xlsx` can be used instead:

   ```
   python3 scripts/import_sheet.py private/relatives.xlsx
   ```

3. Run the front-end tests, then commit and push the changed data/config:

   ```
   node --test scripts/test_frontend.mjs
   git add docs scripts README.md
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
| `Persons` | `PID`, names, gender, dates, birth place, current location, status, notes |
| `Vedic` | Per-person gotra, veda, shakha, sutra, nakshatra, purvikam, kula devatha, parvata |
| `$Config` | Gotra defaults for veda, shakha, sutra and nakshatra |
| `Unions` | `UID`, `PID1`, `PID2`, `REF_NAME`, relationship dates and notes |
| `Offsprings` | `OID`, `UNION_OF`, `OFFSPRING`, notes |

`PID1`, `PID2`, `UNION_OF` and `OFFSPRING` contain `REF_NAME` values. The
importer resolves them back to PIDs, so editing a `REF_NAME` in the sheet does
not break the links.

The generated JSON keeps every original column as an attribute on the person
or union node and on the offspring edge. The site graph has:

* `person` nodes for every `Persons` row;
* `union` nodes for every `Unions` row;
* `partner` edges from a person to their union;
* `offspring` edges from a union to each child.

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

The tree toolbar has four views: **Both**, **Ancestors**, **Descendants** and
**Relatives**. Relatives is a two-kind graph layout: people are cards, unions
are small round nodes, and the connector lines are the partner and offspring
edges from the sheet. It opens on the connected branch around the current
focus, so unrelated branches do not make one enormous row. Click a union node
to see its partners, offsprings, relationship date and original sheet fields.

`layout.orientation` switches vertical (generations top-to-bottom) and
horizontal (left-to-right). `layout.default_view: graph` makes Relatives the
opening view.

## Vedic roots and pravara

When a person has Vedic data, their profile shows a **Vedic roots** button. It
opens gotra, pravara, pravara type, veda, shakha, sutra, nakshatra, purvikam,
kula devatha and parvata where present. Each field has an **i** help button
that explains the concept.

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

Create an OAuth 2.0 Web client in Google Cloud Console, configure the OAuth
consent screen, and add the site origin (for example
`https://evolvedhow.github.io`) to **Authorized JavaScript origins**. While the
consent screen is in Testing mode, only listed test users can sign in. Leave
`client_id` empty to hide the button.

The avatar, email and Google account ID are shown only in the signed-in
visitor's browser on their linked person's profile. They are never written
into the published JSON. This is client-side sign-in only: it personalizes the
experience but does not make the site private.

## Preview locally

```
cd docs && python3 -m http.server 8000
```

Then open http://localhost:8000.
