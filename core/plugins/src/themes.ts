/**
 * Themes. A theme is a `patchwork:theme` plugin whose `style` is a stylesheet
 * of rules under `[theme="<id>"]`; the active one is the `theme` attribute on
 * `<html>`. Underneath every theme sits `@inkandswitch/patchwork`'s fallback
 * `theme.css`, so a page with no theme at all still has every token.
 *
 * The host (`setup()`) runs this: it keeps every registered theme's stylesheet
 * on the page, picks the active theme, and tells isolated views which one that
 * is. Tools read it from here rather than working it out again.
 *
 * Which theme is active:
 *  1. the account's choice for the computer's current mode — the `light` and
 *     `dark` of its theme-preferences doc, `accountDoc.toolStorage["theme-preferences"]`;
 *  2. otherwise the site's, from `<html data-theme-light="…" data-theme-dark="…">`;
 *  3. otherwise `lychee` in light mode and `gloom` in dark.
 *
 * Nothing here writes the preferences doc. The tools that let you choose a
 * theme write `light` and `dark` into it; an unset one resolves at read time,
 * so a site changing its defaults moves everyone who never picked.
 */
import {
  isValidAutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo/slim";
import {
  accept,
  subscribe,
  type SubscribeEvent,
} from "@inkandswitch/patchwork-providers";
import type { AccountDoc } from "./account.js";
import { getRegistry } from "./registry/index.js";
import type { LoadablePlugin, PluginDescription } from "./registry/types.js";

export interface ThemeDescription extends PluginDescription {
  type: "patchwork:theme";
  /**
   * The theme's stylesheet. Its rules are all under `[theme="<id>"]`. A
   * relative URL is relative to the package that registered the theme, so a
   * `package.json` manifest can say `"style": "./theme.css"`.
   */
  style?: string;
}

export type Theme = LoadablePlugin<ThemeDescription, unknown>;

export type ThemeMode = "light" | "dark";

/** What the theme-preferences doc holds: a theme id for each mode. */
export type ThemePreferences = {
  light?: string;
  dark?: string;
};

export type ActiveTheme = {
  /** The computer's mode right now. */
  mode: ThemeMode;
  /** The theme on the page: `light` or `dark`, whichever `mode` is. */
  themeId: string;
  /** The theme for light mode, chosen or defaulted. */
  light: string;
  /** The theme for dark mode, chosen or defaulted. */
  dark: string;
};

/** The `toolStorage` key of the account's theme-preferences doc. */
export const THEME_PREFERENCES_TOOL_ID = "theme-preferences";

/**
 * The provider selector for the active theme. Answered with the theme id, a
 * plain string, so isolated views can follow the host's theme.
 */
export const CURRENT_THEME_SELECTOR = "patchwork:current-theme";

const FALLBACK_DEFAULTS: Record<ThemeMode, string> = {
  light: "lychee",
  dark: "gloom",
};

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The site's themes for each mode, for an account that hasn't picked. */
export function themeDefaults(
  root: Element = document.documentElement
): Record<ThemeMode, string> {
  return {
    light: root.getAttribute("data-theme-light") || FALLBACK_DEFAULTS.light,
    dark: root.getAttribute("data-theme-dark") || FALLBACK_DEFAULTS.dark,
  };
}

/** The computer's mode right now. */
export function currentThemeMode(): ThemeMode {
  return globalThis.matchMedia?.(DARK_QUERY).matches ? "dark" : "light";
}

/** Which theme is active, given the account's choice, the mode and the site. */
export function resolveTheme(
  preferences: ThemePreferences | undefined,
  mode: ThemeMode,
  defaults: Record<ThemeMode, string>
): ActiveTheme {
  const light = preferences?.light || defaults.light;
  const dark = preferences?.dark || defaults.dark;
  return { mode, light, dark, themeId: mode === "dark" ? dark : light };
}

let preferences: ThemePreferences | undefined;
let active: ActiveTheme | undefined;
const listeners = new Set<(theme: ActiveTheme) => void>();

function setActive(next: ActiveTheme) {
  const previous = active;
  active = next;
  document.documentElement.setAttribute("theme", next.themeId);
  if (
    previous?.themeId === next.themeId &&
    previous.mode === next.mode &&
    previous.light === next.light &&
    previous.dark === next.dark
  ) {
    return;
  }
  for (const listener of [...listeners]) {
    try {
      listener(next);
    } catch (error) {
      console.error("[patchwork-plugins] theme listener threw:", error);
    }
  }
}

function refresh() {
  setActive(resolveTheme(preferences, currentThemeMode(), themeDefaults()));
}

/** The active theme. Before the host has started theming, what it would pick. */
export function getActiveTheme(): ActiveTheme {
  return (
    active ?? resolveTheme(preferences, currentThemeMode(), themeDefaults())
  );
}

/**
 * Call `listener` with the active theme now, and again whenever it changes.
 * Returns a function that stops it.
 */
export function onActiveThemeChange(
  listener: (theme: ActiveTheme) => void
): () => void {
  listeners.add(listener);
  listener(getActiveTheme());
  return () => {
    listeners.delete(listener);
  };
}

// Module file extensions that mark an import URL as a module, not a package root.
const MODULE_FILE_EXTENSION = /\.(mjs|cjs|js|mts|cts|ts|jsx|tsx)$/;

/**
 * What a theme's relative `style` is relative to: the package it came from.
 * A folder doc is served at `/<encoded automerge url>/` (as in
 * `getImportableUrlFromAutomergeUrl`); an http package root gets a trailing
 * slash so its last segment isn't dropped; a module URL is used as it is.
 */
function styleBase(importUrl: string | undefined): string {
  const page = document.baseURI;
  if (!importUrl) return page;
  if (isValidAutomergeUrl(importUrl)) {
    return new URL(`/${encodeURIComponent(importUrl)}/`, page).href;
  }
  const url = new URL(importUrl, page);
  if (
    (url.protocol === "http:" || url.protocol === "https:") &&
    !MODULE_FILE_EXTENSION.test(url.pathname) &&
    !url.pathname.endsWith("/")
  ) {
    url.pathname += "/";
  }
  return url.href;
}

/**
 * A theme's stylesheet as an absolute URL, with a relative `style` resolved
 * against the package that registered it. Takes the theme's description, or
 * its id to look it up in the registry. Undefined for a theme that isn't
 * registered or has no `style`.
 */
export function themeStylesheetUrl(
  theme: ThemeDescription | string
): string | undefined {
  if (typeof theme === "string") {
    const registered = getRegistry<ThemeDescription>("patchwork:theme").get(
      theme
    );
    if (!registered) return undefined;
    theme = registered;
  }
  if (!theme.style) return undefined;
  try {
    return new URL(theme.style, styleBase(theme.importUrl)).href;
  } catch {
    return theme.style;
  }
}

/**
 * Keep a `<link rel="stylesheet">` on the page for every registered theme's
 * `style`, and take it away when no registered theme uses it any more. A
 * relative `style` resolves against the package that registered the theme.
 * Returns a function that stops watching and removes them.
 */
export function loadThemeStylesheets(): () => void {
  const registry = getRegistry<ThemeDescription>("patchwork:theme");
  const links = new Map<string, HTMLLinkElement>();

  const sync = () => {
    const styles = new Set(
      registry
        .all()
        .map((theme) => themeStylesheetUrl(theme))
        .filter((style): style is string => Boolean(style))
    );
    for (const style of styles) {
      if (links.has(style)) continue;
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = style;
      document.head.appendChild(link);
      links.set(style, link);
    }
    for (const [style, link] of links) {
      if (styles.has(style)) continue;
      link.remove();
      links.delete(style);
    }
  };

  sync();
  const stop = registry.on("changed", sync);
  return () => {
    stop();
    for (const link of links.values()) link.remove();
    links.clear();
  };
}

/**
 * Answer `patchwork:current-theme` subscriptions that reach `root` with the
 * active theme id, and again whenever it changes. Isolated views get it
 * through the providers bridge, which re-dispatches their subscriptions on the
 * host, so `root` should be `<html>`, where those bubble to.
 */
export function serveCurrentTheme(
  root: HTMLElement = document.documentElement
): () => void {
  const stops = new Set<() => void>();
  const onSubscribe = (event: SubscribeEvent) => {
    if (event.detail?.selector?.type !== CURRENT_THEME_SELECTOR) return;
    accept<string>(event, (respond) => {
      const stop = onActiveThemeChange((theme) => respond(theme.themeId));
      stops.add(stop);
      return () => {
        stop();
        stops.delete(stop);
      };
    });
  };
  root.addEventListener("patchwork:subscribe", onSubscribe);
  return () => {
    root.removeEventListener("patchwork:subscribe", onSubscribe);
    for (const stop of [...stops]) stop();
  };
}

let started = false;

/**
 * Theme the page: load every registered theme's stylesheet, put the active
 * theme on `<html>`, follow the computer's light and dark mode, and answer
 * `patchwork:current-theme`. Until {@link followThemePreferences} is given the
 * account, that's the site's default theme. `setup()` calls this; a page
 * calls it once.
 */
export function startThemes(): () => void {
  if (started) {
    throw new Error("startThemes: already started");
  }
  started = true;

  const stopStylesheets = loadThemeStylesheets();
  const stopServing = serveCurrentTheme();
  const media = globalThis.matchMedia?.(DARK_QUERY);
  media?.addEventListener("change", refresh);
  refresh();

  return () => {
    started = false;
    stopStylesheets();
    stopServing();
    media?.removeEventListener("change", refresh);
  };
}

/**
 * Use the account's choice of theme: the `light` and `dark` of the doc at
 * `accountDoc.toolStorage["theme-preferences"]`, followed as it changes, and
 * as that pointer does. If the account has no such doc yet, the defaults stand
 * until something makes one. This never makes it.
 */
export function followThemePreferences(
  repo: Repo,
  account: DocHandle<AccountDoc>
): () => void {
  let url: string | undefined;
  let stopHandle: (() => void) | undefined;
  let stopped = false;

  const use = (next: ThemePreferences | undefined) => {
    preferences = next && { light: next.light, dark: next.dark };
    refresh();
  };

  const follow = () => {
    const next = account.doc()?.toolStorage?.[THEME_PREFERENCES_TOOL_ID];
    if (next === url) return;
    url = next;
    stopHandle?.();
    stopHandle = undefined;
    if (!next) {
      use(undefined);
      return;
    }
    void repo.find<ThemePreferences>(next).then(
      (handle) => {
        if (stopped || url !== next) return;
        const read = () => use(handle.doc());
        read();
        handle.on("change", read);
        stopHandle = () => handle.off("change", read);
      },
      (error) => {
        // Best effort: the defaults stand.
        console.warn("[patchwork-plugins] theme preferences:", error);
      }
    );
  };

  follow();
  account.on("change", follow);
  return () => {
    stopped = true;
    account.off("change", follow);
    stopHandle?.();
  };
}

/**
 * For a view that can't see the host's `<html>`, like an isolated one: take
 * the active theme from the `patchwork:current-theme` provider instead, and
 * put it on this document's `<html>` as it changes. Loads the registered
 * themes' stylesheets here too.
 */
export function followCurrentTheme(element: HTMLElement): () => void {
  const stopStylesheets = loadThemeStylesheets();
  const stopSubscription = subscribe<string>(
    element,
    { type: CURRENT_THEME_SELECTOR },
    (themeId) => {
      if (typeof themeId !== "string" || !themeId) return;
      const mode = currentThemeMode();
      const current = getActiveTheme();
      setActive({
        ...current,
        mode,
        themeId,
        [mode]: themeId,
      });
    }
  );
  return () => {
    stopSubscription();
    stopStylesheets();
  };
}
