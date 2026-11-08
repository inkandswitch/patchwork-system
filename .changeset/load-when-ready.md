---
"@inkandswitch/patchwork-plugins": patch
---

`loadWhenReady` no longer hangs. When the plugin was re-registered while it loaded (a package reload), `load` gave up on the old description and `loadWhenReady` waited for a registration that had already happened; a registration landing during its first load was missed the same way. It now loads again while the id is registered, and waits only when it isn't.
