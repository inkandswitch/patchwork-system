# @inkandswitch/edge-handles

## 0.1.3

### Patch Changes

- ebca53b: Move the automerge-repo subduction fork to 2.6.0-subduction.48, `@automerge/automerge-repo-keyhive` to 0.5.0-alpha.7, and `@keyhive/keyhive` to 0.1.0-alpha.8. These three are bumped together because the keyhive package pins its automerge-repo version exactly.

  keyhive 0.5 renames the two hive flavours. The network-adapter hive is now `LegacyAutomergeRepoKeyhive`, built by `initializeLegacyAutomergeRepoKeyhive`; the subduction hive keeps the name `AutomergeRepoKeyhive` and is built by `initializeAutomergeRepoKeyhive`. Both extend `AutomergeRepoKeyhiveBase`, which is what Patchwork's `hive` fields are typed as, so a tool that only reads membership works against either.

  `createKeyhiveNetworkAdapter` takes an options object instead of positional arguments, and `onlyShareWithHardcodedServerPeerId` is now `onlyShareWithSyncServer`.

## 0.1.2

### Patch Changes

- f00dcb8: Add `repository` metadata pointing at inkandswitch/patchwork-system, so npm links each package to its source directory and can attest provenance when published from CI.

## 0.1.1

### Patch Changes

- 5f70c14: Add `repository` metadata pointing at inkandswitch/patchwork-next, so npm links each package to its source directory and can attest provenance when published from CI.

## 0.1.0

### Minor Changes

- aaf788c: update edge handles to use subdoc handles
