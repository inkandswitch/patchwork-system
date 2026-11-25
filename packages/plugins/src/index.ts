/**
 * @deprecated Plugins are read from the package database now: use `packages`
 * from `@inkandswitch/patchwork-filesystem`, or the tools from
 * `@inkandswitch/patchwork-elements`.
 *
 * @module
 */
export * from "./tools.js";
export * from "./registry/index.js";
export * from "./datatypes.js";
export * from "./registry/guards.js";
/** @deprecated Import these from `@inkandswitch/patchwork-filesystem`. */
export {
  createDocOfDatatype2,
  isKeyhiveDoc,
  resolveAccountHandle,
  type AccountCreator,
  type AccountDoc,
} from "@inkandswitch/patchwork-filesystem";
/** @deprecated Import these from `@inkandswitch/patchwork-elements`. */
export {
  CURRENT_THEME_SELECTOR,
  THEME_PREFERENCES_TOOL_ID,
  currentThemeMode,
  followCurrentTheme,
  followThemePreferences,
  getActiveTheme,
  loadThemeStylesheets,
  onActiveThemeChange,
  resolveTheme,
  serveCurrentTheme,
  startThemes,
  themeDefaults,
  themeStylesheetUrl,
  type ActiveTheme,
  type Theme,
  type ThemeDescription,
  type ThemeMode,
  type ThemePreferences,
} from "@inkandswitch/patchwork-elements";
