---
"@inkandswitch/patchwork": patch
---

`createRepo()` now saves a tab's changes after 20ms instead of 100ms. A tab only tells the sync node about an edit once it has saved it, so the save throttle sat on the path from every edit to the other tabs and the sync server; with ten tabs open, edits now reach the other tabs in about 40ms instead of 100–400ms.

The shipped automerge-repo patch adds a `subductionSaveThrottle` option to `Repo` (milliseconds, default 100) for this.
