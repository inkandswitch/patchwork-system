---
"@inkandswitch/patchwork-bootloader": patch
---

The public reader catches up from the fetcher's saved keyhive history on start, before serving clients. The fetcher's state can be ahead of the reader's debounced archive save after an abrupt exit, or the reader's archive can be missing or rejected; either way the reader now recovers the keys the fetcher already holds instead of only seeing new events.
