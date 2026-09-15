---
"@inkandswitch/patchwork-plugins": patch
---

Only call `addSyncServerRelayToDoc` for documents whose URL is a keyhive document id. Legacy padded-zero documents are skipped instead of throwing when created with a hive present.

Adds `isKeyhiveDoc(url)`, exported from the package root.
