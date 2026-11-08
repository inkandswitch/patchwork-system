---
"@inkandswitch/patchwork-bootloader": patch
---

A batch of keyhive events the public reader fails to ingest is tried again rather than dropped. It used to be lost, with the reader's status stuck at `reading`, so public docs waiting on those keys never opened. It's retried up to five times over about 3s, in order ahead of newer events; past that `PublicReaderStatus.phase` is `failed` with the reason in `error`, and the events are tried again when more arrive.
