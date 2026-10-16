---
"@inkandswitch/patchwork-bootloader": patch
---

The sync node in the automerge SharedWorker now shares sync rounds between tabs instead of running one per request. Every tab holding a document asks the node for its own rounds, and the node used to run each one against the server, so ten tabs opening the same document meant ten identical rounds queued on the origin's one connection.

A tab that hasn't written to the document since the running round started now shares that round, so any number of tabs opening a document costs one round. A tab that has written waits for the next round, because the running one read its tree before that write was stored, and every tab that writes meanwhile shares that next round.
