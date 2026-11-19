---
"@inkandswitch/patchwork-elements": patch
---

The "can't load" card for a tool whose code didn't load now reloads the page if "try again" fails as well. The browser keeps a failed module import for that URL, so importing it a second time usually fails the same way, and a reload is what actually fixes it. Long error messages on the card, such as a failed import's URL, now wrap inside the card instead of running past its edge.
