---
"@inkandswitch/patchwork-filesystem": patch
"@inkandswitch/patchwork-plugins": patch
---

A plugin in a `package.json` manifest no longer needs an `export`. One without it is listed as before, and its `load()` now does nothing instead of throwing, so a plugin that is all description, like a theme whose `style` is the whole of it, needs no module. A plugin's `export` is resolved through the package's `exports` when the manifest is read, using the same resolver and conditions `load()` imports with, so string `exports`, condition objects and subpath patterns all work. If it matches nothing, `pluginsFromManifest` throws, naming the plugin and the export.

A theme's relative `style` is resolved against the package that registered it, whether that's a folder doc or an http package root, so a manifest can say `"style": "./theme.css"`. `@inkandswitch/patchwork-plugins` exports `themeStylesheetUrl(theme)`, which takes a theme id or a `ThemeDescription` and returns its stylesheet as an absolute URL. It returns `undefined` for a theme that isn't registered or has no `style`.
