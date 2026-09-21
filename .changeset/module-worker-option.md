---
"@inkandswitch/patchwork": patch
---

Add the `importModulesInWorker` setup option. It defaults to `true`, keeping plugin-descriptor discovery in the module-loader worker; `false` imports each Automerge package directly on the main thread instead.
