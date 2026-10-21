---
"@inkandswitch/patchwork-bootloader": patch
---

The automerge worker restarts itself once it has gone 15s without a handoff while its automerge holds more than 64MB of wasm memory. A wasm memory never shrinks, so resolving packages at boot left the worker's automerge at 90–130MB for as long as any tab was open, though it had already let every document go. The restart is the one a new build gets: tabs spawn the replacement and reconnect their sync, the service worker re-sends any handoff still unanswered, and what was resolved is already in its cache. A worker connected to classic sync doesn't recycle, since a replacement wouldn't reconnect it.

What resolves have loaded of each package, which `@patchwork/package-memory` reports, now outlives the instance: a restarting worker saves it in Cache Storage and the next one takes it back.
