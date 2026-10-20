---
"@inkandswitch/patchwork-bootloader": patch
---

The automerge worker holds a Web Lock (`AUTOMERGE_WORKER_LOCK`, `@patchwork/automerge-worker`) for as long as it lives, and the browser releases it when the worker goes, however it goes. Before, a tab only noticed its worker had gone when it said it was closing or when its port fired `close`, which Chromium doesn't do for a worker that closes itself and other browsers may not do at all; until then every `automerge:` request waited out the service worker's 35s and failed. A worker that closed itself without a word was replaced in 0.3s, where before the tab kept talking to it and package files failed after 35s.

- A replacement waits for the lock before it starts its sync node or Repo, or answers handoffs, so two instances never sync or resolve against the same IndexedDB at once. Once it has the lock it announces itself, and the service worker re-sends whatever the last one left unanswered.
- The worker tells its tabs it holds the lock, and each tab waits on it. When it's released, the tab spawns a replacement and reconnects its sync port.
- Before waiting on a handoff, the service worker checks whether anything holds or is waiting for the lock. If nothing is, it asks the open tabs to start a worker (`automerge-worker-missing`).
- `startWorkerControl` takes a `lock` to hold, and `sharedWorkerHandle` takes `onGone` and has `revive()`, so any SharedWorker can do the same.
