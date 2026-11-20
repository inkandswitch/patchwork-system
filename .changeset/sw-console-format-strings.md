---
"@inkandswitch/patchwork-bootloader": patch
---

The service worker and resolvers no longer put a request's URL into a console format string, where a `%c` or `%s` in the URL was interpreted. Their error responses (503, 556, 557, 558) carry the error's message, not its stack; the stack goes to the console.
