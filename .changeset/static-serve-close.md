---
"@inkandswitch/patchwork": patch
---

Don't copy `static` sources or write `build-info.json` when a dev server shuts
down. `closeBundle` runs then too, so stopping `vite` was filling `dist/` with
a copy of every static source.
