---
"@inkandswitch/patchwork": minor
---

Collapse `siteName`, `title`, and `setup({name})` into a single `title`.

A site's name was three options across two files: `siteName` and `title` in the vite config, `name` at `setup`. They fed the same handful of strings and could disagree with each other.

`title` is now the only one. It names the html `<title>`, `apple-mobile-web-app-title`, and the manifest's `name`/`short_name` as before, and is also emitted as the `__SITE_TITLE__` define, which supplies the brand word the router appends to the document title as `"<doc> | <title>"`. It defaults to `"Patchwork"`.

- `siteName` and the `__SITE_NAME__` define are removed. If you used `siteName` only for display, rename it to `title`; if you relied on it to namespace storage, see `storagePrefix`.
- `setup({name})` is now `setup({title})`, and is only needed to override the build-time value.
