---
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-bootloader": patch
---

Move keyhive out of `syncServers` and into its own top-level site option: `keyhive?: boolean | { syncServer?, useIdFactory? }`. `keyhive: true` enables it against the `"subduction"` relay; the object form picks a different relay (or a custom `{url, contactCardJson, peerId}` identity) and turns individual behaviour off. `keyhive.useIdFactory: false` drops the `idFactory` ARK injects into the repo config, so document ids are generated the Repo's own way instead of derived from keyhive. It reaches both the tab repo and the automerge protocol handler worker through the `__SYNC_SERVER__` define.

`syncServers` is now just URLs — `subduction` and `classic`, no longer mutually exclusive with anything. Sites passing `syncServers: { keyhive: X }` should pass `keyhive: { syncServer: X }` instead; `syncServers.subduction` still overrides the URL a named relay implies.
