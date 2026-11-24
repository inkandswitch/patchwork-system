---
"@inkandswitch/patchwork-filesystem": patch
---

An account doc can be walked by path. `accountProvider` reads the account's `namespace`, a mount table after plan9: each mount point is `/` or a top-level `/<name>`, bound to an ordered list of documents. A first name that is a mount point goes to that mount; any other name goes to `/`. An account with no `namespace` has its `rootFolderUrl` at `/`, so `resolvePath(repo, account, ["Projects", "notes"])` works for existing accounts. A mount with several bindings is a union: `resolvePath` reads it through the first binding that has the next name. `Child` gains a `union` variant, and `accountProvider`, `accountBindings` and the `Namespace`, `NamespaceBinding` and `AccountNamespaceDoc` types are exported. Nothing writes a `namespace` yet.
