---
"@inkandswitch/patchwork": patch
---

The vite patches plugin no longer fails the build when it meets an `@automerge/automerge-repo` version it has no patch for. It patches the ARK 0.6 stack's exactly pinned copy and leaves every other copy alone, so a site that installs `@automerge/automerge-repo-keyhive@0.8`, which depends on its own `@automerge/automerge-repo@2.6.0-subduction.49`, builds without a local patch to the plugin.
