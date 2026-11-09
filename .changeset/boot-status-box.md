---
"@inkandswitch/patchwork": minor
---

Boot says what it's doing. A site that doesn't pass `onProgress` gets a small box in the corner, shown once boot has taken a second, naming the step boot is on, how many packages have loaded, and what the public reader is doing; it goes away when the root view mounts (or, with `routing: false`, when `setup()` resolves). A site that passes `onProgress` draws its own and gets no box.

`timeout` no longer rejects `setup()`. A boot that passes it, counted from `setup()`, is reported as stuck instead — `BootProgress.stuck` is `true`, and the box says it's still not ready, under the step boot is on, with a reload button — and it carries on. If it gets there after all, the box goes away and `onProgress` hears `stuck: false`, rather than the site's error screen sitting over a working app. `setup()` still rejects for a boot that actually fails.
