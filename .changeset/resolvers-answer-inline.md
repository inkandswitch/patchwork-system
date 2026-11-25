---
"@inkandswitch/patchwork-bootloader": patch
---

Resolvers (tabs and the automerge worker) no longer write the service worker's cache. They hand every response back inline, and the service worker keeps the immutable ones itself, under the request it's holding: a 200, 203 or 204 that isn't `no-store`, as before. A `cached` reply from a resolver on an older build is still honoured. `HandoffCachedMessage` is deprecated.
