---
"@inkandswitch/patchwork-plugins": patch
"@inkandswitch/patchwork-elements": patch
---

Datatypes can declare `conformsTo: string[]`, listing the datatype ids they are also a kind of, like a UTI's `UTTypeConformsTo`. A `sketchbox` datatype with `conformsTo: ["folder", "tldraw"]` opens in folder and tldraw tools.

`getSupportedToolsForType` and `getSupportedTools` now include tools that support any supertype. `getFallbackTool` ranks by how close the match is: a tool naming the doc's own type, then its nearest supertype, then a `*` wildcard, with ties going by id. The new `getSupertypes(type)` returns every registered datatype `type` conforms to, transitively and nearest first, not including `type` itself.

`<patchwork-view>` treats a supertype match as a real tool rather than a wildcard stopgap. When a datatype registers with a `conformsTo` that makes an existing tool a closer fit, it swaps that tool in.
