---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
---

Move to `@automerge/automerge-repo-keyhive` 0.6.0-alpha.1 and `@keyhive/keyhive` 0.3.0-alpha.1. These are exact pins resolved from the workspace catalog at publish time, so both packages move together to keep a single copy of automerge-repo in the consumer's tree.

The new keyhive can't read state written by 0.5, so the bootloader now stores keyhive state in a versioned database (`<prefix>-keyhive-0.6`) and leaves the old `<prefix>-keyhive` database untouched. Existing installs start with fresh keyhive state on upgrade.

The bootloader also resolves the keyhive wasm asset via the package's `@keyhive/keyhive/wasm` export instead of the old `keyhive_wasm.wasm` file path.
