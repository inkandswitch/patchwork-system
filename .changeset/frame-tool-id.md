---
"@inkandswitch/patchwork": minor
---

Add a `frameToolId` option to `setup`, and stop seeding a frame tool into new accounts.

`createDefaultAccount` wrote `frameToolId: "threepane"` into every account it created — a tool id belonging to one particular tool bundle, hardcoded in core. A site whose `packageListURL` didn't ship `threepane` gave every new user an account pointing at a tool that never registers, so the root view never mounted.

New accounts now leave `frameToolId` unset, and the router resolves the frame each boot:

```
#frame=  →  the account's frameToolId  →  setup({frameToolId})  →  first tool tagged frame-tool
```

The field is still written to the account when a user picks a frame, so it stays a user preference; it is no longer decided for them at signup. Existing accounts already have it set and are unaffected.

Sites relying on the old seeded default should pass `frameToolId: "threepane"` to `setup`.
