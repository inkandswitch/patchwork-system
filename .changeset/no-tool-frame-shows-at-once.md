---
"@inkandswitch/patchwork": patch
---

When the root view has no tool for its doc (an account whose frame tool isn't in any loaded package, say), boot shows its "no tool for this" card as soon as every package, the site's and the account's, has loaded or given up. Before, the card stayed hidden until the 12-second reveal timeout, and the corner box went on to say boot was stuck after 30 seconds, offering a reload that couldn't help.
