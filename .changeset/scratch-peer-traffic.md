---
"@inkandswitch/patchwork-providers": patch
---

A view backed by a scratch document now sends and hears peer traffic through the stored document it's computed from (`cloneUrl ?? url`), instead of through the scratch document, which has no peers. Before, a tool on a scratch-backed view couldn't see anyone's presence and nobody could see its own, and its sync info was always empty.

- `broadcast`, `getSyncInfo`, `getRemoteHeads` and `isCaughtUpWith` go to the realm repo's handle for the stored document, on the root and on every handle derived from it. So `isCaughtUpWith` says whether this tab holds what a peer last advertised for the stored document, which the scratch document's own history can't answer.
- `ephemeral-message` and `ephemeral-message-outbound` come from the stored document, re-stamped with the overlay handle as usual. `remote-heads` comes from it to the view's root alone, as automerge-repo emits it on a document's root handle and nowhere else.
- The stored document is almost always loaded already, so the routing happens with the swap. If it isn't, peer traffic stays on the scratch document until the stored one is found, and stays there if it never is.

Messages go out unchanged, so a peer on the stored document can't tell they came from a computed view, and any position in them (a cursor, an index) is one in the scratch document.

`OverlayHandle` gains `setSyncHandle(handle)` (internal, like `swapBackingDocHandle`, which now takes the sync handle as an optional second argument).
