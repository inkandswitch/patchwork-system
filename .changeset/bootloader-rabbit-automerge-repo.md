---
"@inkandswitch/patchwork-bootloader": patch
---

The bootloader depends on `@chee/automerge-repo@2.6.0-rabbit.1` (and its storage, network and vanillajs packages), aliased as `@automerge/automerge-repo`, as the rest of the core has since the catalog moved. 0.9.7 still asked for `2.6.0-subduction.49`, so a site installing `@inkandswitch/patchwork@0.10.2` got that one too, and the build failed in patchwork's patches plugin, which has no patch for it.
