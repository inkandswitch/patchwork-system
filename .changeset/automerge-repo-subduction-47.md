---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
---

Update the pinned `@automerge/*` versions to `2.6.0-subduction.47`. These are exact pins in `dependencies` and `peerDependencies`, so both packages need to ship the new version together — installing a `.46` and a `.47` package side by side loads two copies of automerge-repo, and document handles from one are not recognised by the other.
