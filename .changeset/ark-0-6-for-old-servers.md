---
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork-elements": patch
"@inkandswitch/patchwork-ark-0.6": patch
---

A keyhive build can be made against the previous keyhive stack, for sync servers that haven't moved to ARK 0.8. `keyhive: { ark: "0.6" | "0.8" }` picks it. When it's left out, a build whose `syncServers.subduction` is on subduction.sync.inkandswitch.com gets `"0.6"`, since that server still runs it, and any other server gets `"0.8"`. So `keyhive: true` works against prod again, and pointing `syncServers.subduction` at staging.subduction.sync.inkandswitch.com gets 0.8.

`"0.6"` swaps in the whole stack the old ARK was built with: `@automerge/automerge-repo-keyhive` 0.6.0-alpha.1, `@keyhive/keyhive` 0.3.0-alpha.1, `@automerge/automerge-repo` and its adapters and `@automerge/vanillajs` 2.6.0-subduction.48, and `@automerge/automerge-subduction` 0.16.1. These come from the new `@inkandswitch/patchwork-ark-0.6` package, which `@inkandswitch/patchwork` depends on, so a site doesn't install anything. The vite plugin aliases every import of those packages to that copy, in the build, the dev server's pre-bundling and the workers alike, and emits the matching keyhive and subduction wasm. Automerge itself stays at the current version. Builds without keyhive, and keyhive builds on `"0.8"`, are unchanged.

On 0.6 the build reaches the server by the name ARK 0.6 ships for it rather than fetching its contact card, and keeps keyhive state in the `<prefix>-keyhive-0.6` database it used before the move to 0.8. Existing installs on prod get their old keyhive state back.

`@inkandswitch/patchwork-bootloader`: new `keyhiveSyncServer(syncServer, storage)` and `ArkVersion` from `/keyhive-sync-server`, which pick the `syncServer` to hand `initializeAutomergeRepoKeyhive` for either ARK. `keyhiveStorageVersion` follows the build's ARK. `wasmAssets()` and `emitWasmAssets()` take an optional file to resolve keyhive's and subduction's binaries from.

`@inkandswitch/patchwork`: the vite plugin also exports `ark`, `arkAliases` and `arkStack`, and the `ArkVersion` type. The source patch for automerge-repo is now chosen by the version being bundled, and `dist/patches` carries one for 2.6.0-subduction.48 as well as 2.6.0-subduction.49.

`@inkandswitch/patchwork-elements`: the keyhive access gates use ARK 0.6's `bestAccessForDoc` when it's there, so public documents open again on 0.6. On 0.8 they use `accessForDoc` as before.
