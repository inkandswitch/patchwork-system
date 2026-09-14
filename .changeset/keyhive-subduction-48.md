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

Move the automerge-repo subduction fork to 2.6.0-subduction.48, `@automerge/automerge-repo-keyhive` to 0.5.0-alpha.7, and `@keyhive/keyhive` to 0.1.0-alpha.8. These three are bumped together because the keyhive package pins its automerge-repo version exactly.

keyhive 0.5 renames the two hive flavours. The network-adapter hive is now `LegacyAutomergeRepoKeyhive`, built by `initializeLegacyAutomergeRepoKeyhive`; the subduction hive keeps the name `AutomergeRepoKeyhive` and is built by `initializeAutomergeRepoKeyhive`. Both extend `AutomergeRepoKeyhiveBase`, which is what Patchwork's `hive` fields are typed as, so a tool that only reads membership works against either.

`createKeyhiveNetworkAdapter` takes an options object instead of positional arguments, and `onlyShareWithHardcodedServerPeerId` is now `onlyShareWithSyncServer`.
