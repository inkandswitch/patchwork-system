---
"@inkandswitch/patchwork-elements": patch
---

The "can't load {tool}" card on `<patchwork-view>` has an "open with…" button next to "try again". It unfolds a searchable list of the other tools that open the doc (its datatype's own first, then ones that open anything), and typing an id that isn't listed offers it as a tool id, the same as the embed frame's tool picker. A tool picked there takes precedence over the view's `tool-id` until `tool-id`, the doc, or its type changes.
