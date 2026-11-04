---
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-bootloader": patch
---

`@inkandswitch/patchwork` installs again. 0.9.1 depended on `@inkandswitch/patchwork-ark-0.6`, which was never published. The previous keyhive stack that package held is now in patchwork's own dependencies, as npm aliases under `@ark-0.6/` (`"@ark-0.6/automerge-repo": "npm:@automerge/automerge-repo@2.6.0-subduction.48"`, and so on), so it sits next to the current versions and nothing extra is published. `keyhive: { ark: "0.6" }` works as before.

On `"0.6"`, the vite plugin now also points `@automerge/automerge` at patchwork's own copy. automerge-repo 2.6.0-subduction.48 pins automerge 3.3.2, and outside this repo that meant a second automerge wasm module whose docs the rest of the build couldn't read.

`@inkandswitch/patchwork`: `arkAliases(mode)` no longer takes the stack's package.json; it reads patchwork's `@ark-0.6/*` dependencies. `arkStack(options)` now returns ARK 0.6's package.json, for resolving its wasm from.
