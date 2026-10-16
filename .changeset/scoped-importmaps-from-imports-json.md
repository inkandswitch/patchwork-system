---
"@inkandswitch/patchwork-filesystem": patch
---

Packages can now ship an `imports.json` — a plain specifier → URL map, either at the package root or pointed at by an `"./imports.json"` entry in `exports` (the export wins if both exist). When the ModuleWatcher loads an Automerge package that has one, it injects an import map into the document scoped to the package's heads-pinned service-worker path (`{"scopes": {"/automerge%3A<doc-id>%23<heads>/": …}}`), so bare specifiers inside the package resolve without leaking into anything else. Exposed as `injectImportMapForPackage`.
