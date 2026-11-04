---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
---

A keyhive build on ARK 0.8 now reads documents made public to Patchwork, such as pushwork repos made with `--public-access read`. Keyhive 0.6 has no public user, so a repo is made public by granting read to Patchwork's public reader and relay to its public fetcher, two principals whose secrets ship with Patchwork. The tab's Repo and the automerge worker's Repo each get a second Repo as a peer. That Repo connects to the sync server as the fetcher, hands the keyhive events it syncs to a keyhive opened as the reader, and decrypts with it. The user's Repo offers it only docs the user's own keyhive doesn't know, so the user's documents never reach it, and it never writes. The new `@inkandswitch/patchwork-bootloader/public-pair` export has `attachPublicReader` and `PATCHWORK_PUBLIC_PAIR`.
