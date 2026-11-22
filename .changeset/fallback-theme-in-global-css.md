---
"@inkandswitch/patchwork": minor
---

The fallback theme lives here now. `@inkandswitch/patchwork/global.css` imports `theme.css` (also exported as `@inkandswitch/patchwork/theme.css`): every `--studio-*`, `--editor-*`, `--text-editor-*` and `--syntax-*` token, following the computer's light or dark mode, in `@layer patchwork` so any theme's `[theme="…"]` rules win over it. The generated `index.html` links `global.css` as a blocking stylesheet, so the tokens are there from the first frame, and the page no longer flashes white in dark mode between a theme setting the `theme` attribute and its stylesheet arriving. The `html:not([theme])` black backdrop in `global.css` is gone, since the theme's own background now covers it. It came from the theming package in pkg-base, which no longer ships it.
