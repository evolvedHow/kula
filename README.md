# Kula family tree

A static, browser-only family tree built from a Gramps export. It's published with GitHub Pages from the `docs/` folder.

## Updating the tree

1. Export the tree from Gramps as Gramps XML, and save it to `private/`.
2. Rebuild the public data (requires Python 3 and PyYAML):

   ```
   pip install -r requirements.txt
   python3 scripts/build_site.py private/export.gramps
   ```

   Run the front-end tests with `node --test scripts/test_frontend.mjs`.

3. Commit and push `docs/data/tree.json` (and any config changes).

`private/` is git-ignored. Only `docs/` is published. Privacy is applied by the build script according to the `privacy:` section of `docs/config.yml`; the current config publishes everything, so review it before publishing a new export.

## Configuration

Everything is in `docs/config.yml`: site title, colours (`theme.preset`), fonts, layout, story rules, sign-in, and privacy. Reload the page to see most changes. Changes to privacy rules, story tags, and titles need a rebuild.

The default theme is `sage`, a Material 3 sage-green palette, with self-hosted Roboto. `layout.orientation` sets `vertical` (generations top-to-bottom) or `horizontal` (left-to-right); visitors can switch with the Vertical/Horizontal control on the tree. `layout.connector_style` is `angular` for right-angled connectors (set it to `curved` for bezier lines).

## Tagging stories to relatives

A story appears on a person's panel when the Gramps note is attached to that person. To attach a story to extra relatives without editing the note in Gramps, list their Gramps IDs under `narratives.story_tags`:

```yaml
narratives:
  story_tags:
    N0047: [I0000, I0002]
```

Rebuild and the story appears on every listed person's panel, and in the "Tagged relatives" section of the story. IDs that are private or hidden by the privacy rules are skipped. `narratives.story_titles` can override a note's display title by note ID.

## Google sign-in

`auth.google` adds an optional "Sign in with Google" button. It maps a Google email to a Gramps ID and sets "This is me" automatically:

```yaml
auth:
  google:
    client_id: "YOUR_WEB_CLIENT_ID.apps.googleusercontent.com"
    allowed_domains: ["gmail.com"]
    people:
      "you@gmail.com": I0023
    auto_me: true
```

Create an OAuth 2.0 Web client in Google Cloud Console, configure the OAuth consent screen, and add the site origin (for example `https://evolvedhow.github.io`) to **Authorized JavaScript origins**. While the consent screen is in Testing mode, only listed test users can sign in. Leave `client_id` empty to hide the button.

This is client-side sign-in only: it personalizes the experience, but it does not make the site private. The published JSON is still public, so use the build-time privacy rules for anything that must stay private.

## Corrections

Each visible person's panel has a "Suggest a correction" link that opens a pre-filled GitHub issue in the repo set by `site.repo`.

## Preview locally

```
cd docs && python3 -m http.server 8000
```

Then open http://localhost:8000.
