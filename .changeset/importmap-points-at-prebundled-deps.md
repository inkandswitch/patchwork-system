---
"@inkandswitch/patchwork": patch
---

The dev importmap now names each builtin's pre-bundled dep URL
(`/node_modules/.vite/deps/…?v=…`) instead of `/@id/<dep>`. Both URLs resolve to
the same file, but a module fetched under two URLs is evaluated twice — the site
imported solid through the pre-bundled URL and tool code imported it through the
importmap, so tools ran against a second solid with its own owner stack and
logged "computations created outside a `createRoot`" for every effect they
created. Builtins that aren't pre-bundled still fall back to `/@id/<dep>`.
