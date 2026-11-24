---
"@inkandswitch/patchwork-elements": patch
---

The "no tool for this" card on `<patchwork-view>` has the same "open with…" picker as the "can't load {tool}" card when the view's `tool-id` names a tool that isn't registered. Both pickers offer tools of the same kind as the one asked for when there are any: a missing or broken frame tool offers the other `frame-tool`-tagged tools rather than every tool that opens an account. A tool that isn't registered has no tags to read, so it counts as a frame when the account doc's `frameToolId` names it.
