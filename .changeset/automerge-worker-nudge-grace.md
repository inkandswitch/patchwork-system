---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-e2e": patch
---

The service worker no longer mistakes a booting automerge worker for a missing one. The worker only asked for its lock once its whole import graph (most of a megabyte) had loaded, so asset requests made in that window found no lock and logged "no automerge worker; asking tabs to start one". Each tab then dropped its connection to the booting worker and reconnected sync. In a single tab that happened on every reload.

The worker's script, `automerge-protocol-handler-worker.js`, is now a small module that takes the lock and holds on to connecting tabs before it imports the worker itself, now `@inkandswitch/patchwork-bootloader/automerge-protocol-handler`. The vite plugin emits that as a second file, `automerge-protocol-handler.js`, beside the first. As a backstop, the service worker waits three seconds before nudging, and only nudges if the request is still unanswered and there's still no lock. The nudge is throttled to once every five seconds, however many requests are waiting. Before, every request that raced the same cold start got past the throttle and logged its own nudge.

The e2e suite gains `automerge-worker.spec.ts`, which checks that the worker holds its lock once a tab is up and that a request racing a cold worker boot isn't reported as a missing worker.
