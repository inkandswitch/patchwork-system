---
"@inkandswitch/patchwork-undo": patch
"@inkandswitch/patchwork-providers": patch
"@inkandswitch/patchwork-providers-react": patch
"@inkandswitch/patchwork-providers-solid": patch
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-e2e": patch
---

Undo and redo become a service of Patchwork. The new `@inkandswitch/patchwork-undo` package gives every tool undo of its document edits through `undoFor(element, handle)`: one history per realm and document, shared by every tool editing it; only the realm's own changes are undone, as new changes that leave collaborators' work in place; consecutive undo and redo presses form a run that the next edit records as a step, so nothing undone becomes unreachable; Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z and (outside macOS) Ctrl+Y are bound once per page. Helpers for CodeMirror (`@inkandswitch/patchwork-undo/codemirror`: `undoBoundaries`, `followUndo`), ProseMirror (`@inkandswitch/patchwork-undo/prosemirror`: `undoBoundaries`) and tldraw (`@inkandswitch/patchwork-undo/tldraw`: `bindTldraw`, `tldrawOptions`, `tldrawOverrides`) replace those editors' own histories. The design is in `docs/proposals/document-undo.md`.

`@inkandswitch/patchwork-providers` adds `connect(element, selector, listener)`, a subscription the consumer can send commands back on (`send`), and `accept` producers receive a second argument with `onCommand`. `subscribe` is unchanged.

`@inkandswitch/patchwork-providers-react` adds `useUndo` and `useUndoStatus`; `@inkandswitch/patchwork-providers-solid` adds `createUndo` and `undoStatus`.

`@inkandswitch/patchwork` mounts an `<undo-provider>` with the `<repo-provider>` (and generated site HTML declares it), so host UI can reach any document's undo through the `patchwork:undo` provider (`watchUndo`). `@inkandswitch/patchwork-bootloader` shares `@inkandswitch/patchwork-undo` and its subpaths through the import map.

`@inkandswitch/patchwork-e2e` adds end-to-end tests of the undo service (two profiles, a canvas, a form field, a draft swap, and tldraw compared with its own history); `PATCHWORK_E2E_UNDO_PATH` picks the page they start from.
