---
"@inkandswitch/patchwork-elements": patch
---

`<patchwork-view doc-url>` now says what's wrong in words when it can't show a doc, with cards moved over from threepane, instead of a bare `:(`. They cover a doc it's still finding, one it couldn't get (with the sync server's connection status, and another try when the connection comes back), one not shared with you (with a "copy my card" button), a broken link, a tool whose code didn't load (with "try again"), and a type nothing opens. The no-tool card names the package the doc suggests, offers to load it, and has a details popover listing what its package.json claims and who has written to its folder.

A new card covers docs with no `@patchwork` type. It offers to open the doc with a tool that opens anything (raw, when that's registered) so you can look inside, and has a "set type" box that writes `@patchwork.type` on the doc. Once the type is set, the view reopens the doc with that type's tool.

A doc whose type has no tool of its own no longer opens in a `*` tool like raw without being asked. The card offers that tool instead. The view also sends a `patchwork:no-tool` event (`NoToolEvent`) whenever it shows a card in place of a tool, so anything waiting on `patchwork:mounted` can stop waiting. `@automerge/automerge` is now a peer dependency, used to read a suggested package's folder history.
