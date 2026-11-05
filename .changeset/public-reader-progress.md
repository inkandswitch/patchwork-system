---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
---

The public reader's status, and so `setup()`'s `onProgress`, now says what the reader is doing on the way to a first-visit catch-up, which takes 10–20s and used to report nothing until it was over. `phase` is `waiting` until the first keyhive event arrives from the sync server, `fetching` while the fetcher takes them in (`received` counts them, reported every 250ms even while the fetcher's ingest holds the worker), `reading` while the reader ingests the batch, and `ready` once everything received has been read. `relayed` is as before. `BootProgress.publicReader` is now the bootloader's `PublicReaderStatus`.
