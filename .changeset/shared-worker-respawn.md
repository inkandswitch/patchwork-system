---
"@inkandswitch/patchwork-bootloader": patch
---

A tab's handle on a shared worker (the automerge worker, the public reader) is one state now — `none`, `running`, `winding-down` or `waiting` — readable as `handle.state` with the reason and since when. Two bugs went with the old scattered fields: a worker that died while winding down for a restart left every later message held forever, never reaching its replacement; and a worker that failed on every start was respawned as fast as it could boot. The first three quick restarts in a row still respawn at once; after that the respawn waits, doubling from 500ms to 10s, and the count starts over once an instance stays up for 30s. Messages posted meanwhile are delivered to the replacement.
