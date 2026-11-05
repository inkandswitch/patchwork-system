---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
---

The public reader now runs in its own SharedWorker (`/public-reader-worker.js`), one per origin, instead of on each tab's main thread and again in the automerge worker. Catching up on the server's keyhive took two 5–9s blocks of wasm on the page, long enough that the service worker stopped asking the tab for its own `automerge:` requests and handed them to the automerge worker, which then had to catch up all over again; boot regularly ran past setup's 30s deadline. Tabs now connect their Repo to the reader with `connectPublicReader`, and pass the automerge worker a port to it.

The reader's keyhive state is kept in IndexedDB (`<prefix>-public-reader-<ark>-<pair>`), so only the first visit replays it: a return visit boots in about a second.
