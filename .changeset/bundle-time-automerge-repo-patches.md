---
"@inkandswitch/patchwork": patch
---

Apply Patchwork's automerge-repo source patches at bundle time, so a site that installs `@inkandswitch/patchwork` gets them. They were only a pnpm patch, which exists in this repo's node_modules and nowhere else, so every consumer bundled an automerge-repo without the `mesh` subduction role or the `awaiting-reconnect` fix to `isConnecting()`.

The new `patches` plugin is part of `patchwork()` and also exported on its own. It rewrites the two files as they pass through rollup, and registers the same rewrite as an esbuild plugin for dep pre-bundling, which runs outside the plugin pipeline. It is pinned to one automerge-repo version and every anchor has to match, so bumping the dependency fails the build rather than quietly dropping the patches. A copy that already carries the edits — this repo's, via the pnpm patch — is left alone.
