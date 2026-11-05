---
"@inkandswitch/patchwork-elements": patch
---

A timed retry of a failed doc load now asks the sync server for the doc again. Before, the retry called `find` on a query that had already settled on "unavailable", which answers from that verdict without asking anyone, so a doc that reached the server after the first look stayed unavailable until a keyhive op, a reconnect or a reload. The view now calls `repo.resyncSubduction` when it schedules each retry, where the repo has one.
