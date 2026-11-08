---
"@inkandswitch/patchwork-filesystem": patch
"@inkandswitch/patchwork": patch
---

Boot loads first the packages for what's about to be on screen. Each visit stores in localStorage (`patchwork:load-order:<accountKey>`) which tools and components every settings entry provided, and which ones the mounted `<patchwork-view>`s showed, by depth from the outermost. The next boot loads the packages behind the hash's `frame` and `tool` first, then the root view's, then the views inside it, and so on, one batch at a time, then everything else. It starts loading each of those tools as soon as it registers, and opens the root view once they've all registered, without waiting for the rest of the site's packages. If a package fails, comes back without a tool it was expected to provide, or a batch takes more than 3s, everything still held back loads at once, and the root view waits for all of the site's packages as before. With nothing stored, or a hash naming a tool no package provided last time, boot works as it did.

`ModuleWatcher` gets `prioritize(batches)`, with the new `LoadBatch` and `PluginRef` types. Call it straight after constructing the watcher. While a plan is running, `addUrl` waits only for the constructor's sources to be read, not for their packages to load, since the plan may want the new source's packages first.

The tab's title now names a document whose datatype registers after the document opened. Before, it stayed on the site's name.
