---
"@inkandswitch/patchwork": minor
"@inkandswitch/patchwork-bootloader": minor
"@inkandswitch/patchwork-elements": patch
---

Move to `@automerge/automerge-repo-keyhive` 0.8.0-alpha.1 and `@keyhive/keyhive` 0.6.0. The other exact pins move with them so the consumer's tree keeps a single copy of automerge-repo: `@automerge/automerge-repo` and its adapters, `@automerge/react` and `@automerge/vanillajs` to 2.6.0-subduction.49, and `@automerge/automerge-subduction` to 0.20.1. The shipped automerge-repo patch makes the same changes as before, rebased onto 2.6.0-subduction.49. A site applying the patch from `@inkandswitch/patchwork/dist/patches` should take the new one.

ARK no longer ships named sync servers, so a keyhive build finds its server's identity at startup. The tab and the automerge protocol handler worker fetch the server's contact card from `/keyhive/contact-card` on the `syncServers.subduction` host, and keep the last card fetched so a start without a network can use it. The server has to serve that endpoint. `keyhive.syncServer` and the `PatchworkKeyhiveSyncServer` type are gone; point `syncServers.subduction` at the server instead. `keyhive: true` and `keyhive: { useIdFactory }` are unchanged.

New in `@inkandswitch/patchwork-bootloader`: `loadSyncServerIdentity(url, storage)` from `@inkandswitch/patchwork-bootloader/keyhive-sync-server`, for a site that builds its own keyhive Repo.

The new keyhive can't read state written by 0.3, so keyhive state moves to a new `<prefix>-keyhive-0.8` database and the old one is left untouched. Existing installs start with fresh keyhive state on upgrade.

The keyhive access gates in `patchwork-elements` use ARK's `accessForDoc`, which replaces `bestAccessForDoc`. ARK no longer has public access, so a document opens only for its members.
