---
"@inkandswitch/patchwork-plugins": minor
"@inkandswitch/patchwork": minor
---

Boot no longer waits on datatypes it doesn't own. `resolveAccountHandle` writes
the account doc directly instead of blocking on `loadWhenReady("account")`, and
`createDefaultAccount` builds the root folder, module-settings and anonymous
contact subdocs itself rather than waiting for the `folder`,
`patchwork:module-settings` and `contact` datatypes. A package bundle that never
registers those no longer hangs setup until its timeout.

`AccountDoc.frameToolId` is now optional. `createDefaultAccount` still writes
`"threepane"`, and the router falls back to the first registered `frame-tool`
when an account has none.
