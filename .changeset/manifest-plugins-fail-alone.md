---
"@inkandswitch/patchwork-filesystem": patch
---

A plugin in a `package.json` manifest whose `export` matches nothing in the package's `exports` no longer takes the rest of the package down with it. `pluginsFromManifest` doesn't throw any more: it warns, naming the plugin and the export, still lists that plugin, and gives it a `load()` that rejects with the same error. The package's other plugins are listed and load as usual.

A plugin's relative `style` is resolved against the package when the manifest is read, so the description carries an absolute URL. Anything that reads `style` straight off a theme, like a settings page fetching its stylesheet, gets a URL that works from any page, not one relative to wherever it's running.
