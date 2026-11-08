---
"@inkandswitch/patchwork-providers": patch
---

`OverlayRepo` and `OverlayHandle` now behave like automerge-repo's `Repo` and `DocHandle` wherever a tool can tell the difference. Conformance tests run the same operations against both and compare the results, and seeded fuzz tests check the same properties across random edits, backing swaps and descriptor races.

Handles:

- Handles from `sub` and `view` follow automerge-repo's identity rules. The same url gives the same wrapper however it was reached: `h.sub("a").sub("b") === h.sub("a", "b")`, `h.sub() === h`, and `find(url/with/path)` returns the root's own `sub` of that path. Derived wrappers are held weakly, as automerge-repo holds sub-handles, so the cursor sub-handle an editor makes on every selection change is no longer kept for the life of the view.
- `view(heads)` returns a wrapper under the presented url instead of the backing (clone or scratch) handle.
- A backing swap re-bases each derived handle from its url, so a cursor range keeps its cursors instead of being re-placed by index, and one handle that can't be re-made no longer stops the swap. A view at heads the new backing doesn't have keeps showing its snapshot and stops forwarding events. The swap emits `heads-changed` (when the heads move) before `change`, and `change.patchInfo.before`/`after` are whole documents, as automerge-repo's are.
- `equals` compares the presented url, so it agrees with a real handle on the same url in either direction. `diff` accepts an overlay handle. `off(event)` with no listener removes them all, and `listenerCount`, `listeners` and `eventNames` report the overlay handle's own listeners, not the backing's.
- A url under a root whose remapper pinned it to heads no longer carries those heads into its sub-handles' urls. The sub's url now matches the root's.

Repo:

- `find(id, { signal })` honours the signal, which cancels the wait but not the resolution, as in automerge-repo.
- `handles` lists only root handles, never a sub-handle or a pinned view.
- A descriptor answer that fails after a newer answer has arrived no longer fails the `find` waiting on the newer one. Before, it also left a wrapper behind that no later answer could re-point.
- After a resolution fails, `findWithProgress` subscribers see `ready` once the document turns up, without anyone calling `find` again. `whenReady()` reads the current state, so a progress that has recovered resolves.
- `RepoLike.find` takes the optional `options` argument.
