---
"@inkandswitch/patchwork": patch
---

The loading pulse no longer flashes white in dark mode. Under `prefers-color-scheme: dark` the page is black until a theme sets the `theme` attribute on `<html>`, so the pulse's low-opacity frames no longer let the browser's white canvas through. The rule ships in `@inkandswitch/patchwork/global.css`, which the generated `index.html` links in `<head>`, so it holds from the first frame; the loading screen's own styles carry it too, for hosts that write their own HTML.
