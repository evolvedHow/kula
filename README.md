# Kula family tree

A static, browser-only family tree built from a Gramps export. It's published with GitHub Pages from the `docs/` folder.

## Updating the tree

1. Export the tree from Gramps as Gramps XML (or use the snapshot tool), and save it to `private/`.
2. Rebuild the public data:

   ```
   python3 scripts/build_site.py private/export.gramps
   ```

3. Commit and push `docs/data/tree.json` (and any config changes).

`private/` is git-ignored. Only `docs/` is published, and the build step removes living people's details, private records, and any stories that name living people before writing the file.

## Configuration

Everything is in `docs/config.yml`: site title, colours (`theme.preset`), fonts, layout, story rules, and privacy. Reload the page to see changes. Changes to privacy rules need a rebuild.

## Corrections

Each visible person's panel has a "Suggest a correction" link that opens a pre-filled GitHub issue in the repo set by `site.repo`.

## Preview locally

```
cd docs && python3 -m http.server 8000
```

Then open http://localhost:8000.
