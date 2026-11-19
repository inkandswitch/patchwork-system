---
"@inkandswitch/patchwork-plugins": patch
"@inkandswitch/patchwork-elements": patch
---

Tools can claim some docs of a datatype, not just all of them. A tool description takes `supports`, a list of `{ datatype, where }`, where `where` maps top-level doc fields to globs: `{ datatype: "file", where: { mimeType: "image/*" } }` claims image files. Core matches strings and doesn't know what the fields mean. A `*` in a glob stands for any run of characters other than `/`, as in Go's `path.Match`, so `text/*` matches `text/plain` but not `text/x/y`. Everything else is literal and case-sensitive. `supportedDatatypes` is now optional and still works as before; `supportedDatatypes: ["file"]` means the same as `supports: [{ datatype: "file" }]`.

When `<patchwork-view>` picks a tool for a doc, a `where` that matched on literal values wins over one that matched through a glob, which wins over a bare datatype, which wins over `"*"`. A pattern made only of `*` and `/`, like `*/*`, ranks as if there were no `where`. Ties go by tool id, as before. A view with no chosen tool reopens when a field some tool's `where` reads changes and that changes which tool it falls back to. The package details list a plugin's `supports` next to its datatypes.

`@inkandswitch/patchwork-plugins` exports `ToolSupport`, `toolSupports(tool)` (a tool's claims, malformed entries left out), `toolMatch(tool, doc)` (`"exact"`, `"glob"`, `"datatype"`, `"wildcard"`, or `undefined`), `globMatch(pattern, value)`, `opensAnything(tool)` and `whereFields()`. `getSupportedTools` and `getFallbackTool` take `supports` into account. `getSupportedToolsForType` returns the tools that open every doc of a type, so it leaves out tools whose claim on that type has a `where`.
