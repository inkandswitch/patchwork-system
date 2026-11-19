---
"@inkandswitch/patchwork-elements": patch
---

`<patchwork-view>`'s cards ("can't load this doc", "no tool for this", and the rest) fold down to a small `!` button when the view is too small to read them in: 240px wide or less, or 160px tall or less. Clicking the `!` opens the full card in a popover above the page. The card works this out with a container query, so a card sitting in a thin strip or a narrow sidebar no longer gets cut off. A view with no set height gives its card a 24em height, and a card taller than that scrolls.
