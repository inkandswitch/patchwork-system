---
"@inkandswitch/patchwork-elements": patch
---

A doc whose only match is a wildcard tool (the raw viewer) but which suggests a
package now shows just the offer, instead of dropping the reader into raw JSON
that gets swapped out from under them once the import lands. If the import
registers nothing, the view says so rather than sitting empty.

The offer's toast is also themed: it took its colours from hardcoded light
values while its button read `--studio-*`, so in a dark theme a light card held
a black-on-black button. Both now use the theme's ink (`--studio-line` — the
`--studio-text` they asked for doesn't exist), surface and accent.
