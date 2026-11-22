---
"@inkandswitch/patchwork": patch
---

The generated `index.html` declares `<meta name="color-scheme" content="light dark">`, so the browser's own canvas is dark in dark mode from the first frame. This covers the gap the dark loading backdrop leaves: once a theme sets the `theme` attribute on `<html>`, the backdrop rule stops matching, but the theme's stylesheet may not have loaded yet.
