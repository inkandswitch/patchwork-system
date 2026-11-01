---
"@inkandswitch/patchwork-undo": patch
---

A new undo history rebuilds steps from the realm's earlier changes to the document: its own actor's and those of every actor with the document's Automerge author, which Patchwork sets to the signer's key, so undo reaches what the user did before a reload. The newest 10 steps are rebuilt at once and older ones when undo reaches them (`restore` in `UndoOptions` sets how many; `0` turns it off). Rebuilt changes of one actor at most a second apart form a step, an earlier run's presses (marked with the change message `PRESS_MESSAGE`, `"patchwork-undo"`) form one, and the changes that created the document are left out.
