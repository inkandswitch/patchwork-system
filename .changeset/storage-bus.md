---
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-bootloader": minor
---

Every Repo on the origin — each tab's `createRepo()` and the automerge protocol handler worker's, in both the plain and the keyhive branch — passes `subductionStorageChannel`, named `<storagePrefix>-storage`, so siblings learn about each other's writes from the shared IndexedDB over a BroadcastChannel instead of a Subduction mesh. Every node keeps the same signer and peer id, its own socket to the sync server and the shared database; what changes is how a write in one tab reaches the others.

The siblings mesh is gone with it: `siblingAdapters()` and the `@inkandswitch/patchwork-bootloader/siblings` export are removed, and no Repo passes `subductionAdapters`. Under one peer id the Subduction core never pushes a commit back to the sending peer's other connections, so the mesh links only added sync rounds.

The option lives in this workspace's pnpm patch of `@automerge/automerge-repo@2.6.0-subduction.48`. That patch adds `subductionStorageChannel`, a BroadcastChannel on which the storage bridge announces each durable write and from which the other nodes load those records out of the shared adapter into their own Subduction node. A `find` resolves from local storage as soon as shared storage holds the document, before the first server round. A `heads-changed` that saved nothing new no longer opens a server round. An entry still initializing hydrates from local storage when a bus record for it arrives, and when a sync round fails while disconnected. Consumers installing from npm get the unpatched fork, where the option is ignored and tabs meet only through the server, until the fork is republished with these changes and the catalog pin is bumped.
