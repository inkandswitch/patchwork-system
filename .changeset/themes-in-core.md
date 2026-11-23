---
"@inkandswitch/patchwork-plugins": patch
"@inkandswitch/patchwork": patch
---

Theming is part of the host now, not something a package has to provide. `setup()` loads the stylesheet of every registered `patchwork:theme` plugin. It sets the active theme as the `theme` attribute on `<html>` and keeps it in step with the computer's light and dark mode. It also answers `patchwork:current-theme` with the active theme id, so isolated views can follow it.

The active theme is the account's choice for the current mode: the `light` and `dark` of the doc at `accountDoc.toolStorage["theme-preferences"]`. Without one, it's the site's default from `<html data-theme-light="…" data-theme-dark="…">`, and failing that `lychee` or `gloom`. The host reads that doc and never writes or creates it. The tools that let you pick a theme still write `light` and `dark` into it, as before.

`@inkandswitch/patchwork-plugins` exports:

- `ThemeDescription` and `Theme`, the `patchwork:theme` plugin type, now in `RegistryTypeMap`
- `getActiveTheme()` and `onActiveThemeChange(listener)`, for the active theme and each mode's theme
- `themeDefaults()`, `currentThemeMode()` and `resolveTheme(preferences, mode, defaults)`, for how the choice is made
- `followCurrentTheme(element)`, for a view that can't see the host's `<html>`: it applies the theme from `patchwork:current-theme`
- `startThemes()`, `followThemePreferences(repo, account)`, `loadThemeStylesheets()` and `serveCurrentTheme(root)`, which `setup()` calls
- `CURRENT_THEME_SELECTOR` and `THEME_PREFERENCES_TOOL_ID`

`AccountDoc` gains `toolStorage?: Record<string, AutomergeUrl>`. `@inkandswitch/patchwork-plugins` now depends on `@inkandswitch/patchwork-providers`.
