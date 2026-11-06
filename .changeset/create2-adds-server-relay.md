---
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-plugins": patch
---

Every keyhive doc `repo.create2` makes now has the sync server as a relay. The server only keeps and hands out docs it's a relay of, so a doc made with a plain `create2` (a chat message, a tldraw file, a seeded example) never left the device that made it, and sharing it gave access to nothing. `setup()` wraps the Repo's `create2` to add the relay, and touches a doc made with content so its first commit is sent too. `addSyncServerRelay(hive, url)` in patchwork-plugins does it once per doc, so `createDocOfDatatype2` and the account, which did it themselves, don't add it twice.
