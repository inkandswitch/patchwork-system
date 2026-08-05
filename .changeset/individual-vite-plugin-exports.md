---
"@inkandswitch/patchwork": patch
---

Expose the individual vite plugins that `patchwork()` composes. Each one now has its own subpath — `@inkandswitch/patchwork/vite/importmap`, `/vite/service-worker`, `/vite/config`, `/vite/dev`, `/vite/icons`, `/vite/html`, `/vite/manifest`, `/vite/netlify`, `/vite/static`, `/vite/build-info` — and they are also re-exported from `@inkandswitch/patchwork/vite` as `importmap`, `serviceworker`, `config`, `dev`, `icons`, `html`, `manifest`, `netlify`, `statics` and `buildInfo`, so a site that wants its own composition can pick the pieces it needs instead of the whole default plugin array.
