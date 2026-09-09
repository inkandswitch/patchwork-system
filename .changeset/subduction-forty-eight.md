---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork-elements": patch
"@inkandswitch/patchwork-filesystem": patch
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-plugins": patch
"@inkandswitch/edge-handles": patch
"@inkandswitch/patchwork-providers": patch
"@inkandswitch/patchwork-providers-react": patch
"@inkandswitch/patchwork-providers-solid": patch
---

Move the automerge and keyhive dependencies forward together.

- The automerge-repo family goes to `2.6.0-subduction.48`: `@automerge/automerge-repo`, its
  messagechannel and websocket network adapters, its indexeddb and nodefs storage adapters,
  `@automerge/automerge-repo-react-hooks`, `@automerge/react` and `@automerge/vanillajs`.
  These are exact pins and move as one, so a consumer ends up with a single copy of
  automerge-repo and document handle identity holds.
- `@automerge/automerge` goes to `3.4.1`.
- `@automerge/automerge-repo-keyhive` goes to `0.4.0-alpha.sub.4` and `@keyhive/keyhive` to
  `0.1.0-alpha.8`. In keyhive 0.4 the subduction-backed hive took over the plain names: the
  type formerly reached as `Awaited<ReturnType<typeof initializeAutomergeRepoKeyhive>>` is now
  exported directly as `AutomergeRepoKeyhive`, and the pre-subduction hive is
  `LegacyAutomergeRepoKeyhive`. The `hive` on `PatchworkView` and on the tool render params is
  that type; its shape is unchanged, so nothing to do on the consumer side.
