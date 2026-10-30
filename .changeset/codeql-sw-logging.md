---
"@inkandswitch/patchwork-bootloader": patch
---

The service worker and resolvers no longer put request URLs or paths into a console format string, where a `%c` or `%s` in a URL was interpreted. Error responses carry the error's message, not its stack; the stack goes to the console.
