---
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
---

The service worker asks a tab to resolve `automerge:` requests before falling back to the automerge worker. Every tab is its own node with its own Repo, so the tab that made a request can usually answer it from documents it already holds.

The service worker asks the tab that made the request first, then any other open tab (focused first, then visible). This covers requests from the module-loader worker and navigations, which have no window of their own. Only when no tab can answer does it broadcast to the automerge worker, which now handles just those requests.

The tab replies `accepted` straight away, or `unavailable` if it has no Repo yet. A tab that says nothing within 250ms is passed over. That number is provisional: the service worker logs each tab's accept latency under `patchwork:serviceworker`, to measure from. A tab that has accepted holds a Web Lock for that one request until it has replied. If the lock is released with no reply, the tab has gone (closed, crashed, navigated away) and the next candidate is asked.

New in `@inkandswitch/patchwork-bootloader`: `resolveHandoffsWith(repo)` makes this tab answer with `repo`. `@inkandswitch/patchwork` calls it with the Repo it creates; a site that passes its own Repo isn't asked and keeps resolving through the automerge worker. The resolving code the worker used is shared by both, in `resolver.ts`. The new messages are `ResolveRequestMessage`, `ResolveAcceptedMessage` and `ResolveUnavailableMessage`.
