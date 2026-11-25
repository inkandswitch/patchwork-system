// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import EventEmitter from "eventemitter3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Themes = typeof import("../src/themes.js");
type Packages = typeof import("@inkandswitch/patchwork-filesystem");

let themes: Themes;
let fs: Packages;
const added: string[] = [];
let n = 0;
// Put themes in the package database, as a package at `importUrl` would.
function addThemes(plugins: any[], importUrl: string, base?: string) {
  const key = `${importUrl}#${n++}`;
  fs.packages.add({
    key,
    version: "1",
    importUrl,
    base,
    plugins,
    addedBy: { by: "js", url: "test", stack: "" },
  });
  added.push(key);
  return key;
}
let stops: (() => void)[] = [];

// The computer's mode, switchable mid-test.
let dark = false;
const media = new EventTarget() as EventTarget & { matches: boolean };
Object.defineProperty(media, "matches", { get: () => dark });
function setDark(next: boolean) {
  dark = next;
  media.dispatchEvent(new Event("change"));
}

beforeEach(async () => {
  vi.resetModules();
  dark = false;
  vi.stubGlobal("matchMedia", () => media);
  document.documentElement.removeAttribute("theme");
  document.documentElement.removeAttribute("data-theme-light");
  document.documentElement.removeAttribute("data-theme-dark");
  document.head.innerHTML = "";
  themes = await import("../src/themes.js");
  fs = await import("@inkandswitch/patchwork-filesystem");
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const key of added.splice(0)) fs.packages.remove(key);
  vi.unstubAllGlobals();
});

const start = () => stops.push(themes.startThemes());
const theme = () => document.documentElement.getAttribute("theme");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// A stand-in DocHandle: a doc you can change, that says when it has.
function handle<D extends object>(doc: D) {
  const events = new EventEmitter();
  return {
    url: `automerge:${Math.random().toString(36).slice(2)}`,
    doc: () => doc,
    change(fn: (doc: D) => void) {
      fn(doc);
      events.emit("change");
    },
    on: (event: string, fn: () => void) => events.on(event, fn),
    off: (event: string, fn: () => void) => events.off(event, fn),
  };
}

function repoOf(...handles: ReturnType<typeof handle>[]) {
  return {
    find: async (url: string) => {
      const found = handles.find((h) => h.url === url);
      if (!found) throw new Error(`no doc at ${url}`);
      return found;
    },
  } as any;
}

describe("resolveTheme", () => {
  const defaults = { light: "day", dark: "night" };

  it("picks the account's choice for the mode", () => {
    expect(
      themes.resolveTheme({ light: "a", dark: "b" }, "dark", defaults)
    ).toEqual({ mode: "dark", themeId: "b", light: "a", dark: "b" });
  });

  it("falls back to the site's default for a mode with no choice", () => {
    expect(themes.resolveTheme({ dark: "b" }, "light", defaults)).toEqual({
      mode: "light",
      themeId: "day",
      light: "day",
      dark: "b",
    });
    expect(themes.resolveTheme(undefined, "dark", defaults).themeId).toBe(
      "night"
    );
  });
});

describe("themeDefaults", () => {
  it("reads the site's defaults off <html>", () => {
    document.documentElement.setAttribute("data-theme-light", "warm");
    document.documentElement.setAttribute("data-theme-dark", "dusk");
    expect(themes.themeDefaults()).toEqual({ light: "warm", dark: "dusk" });
  });

  it("is lychee and gloom when the site says nothing", () => {
    expect(themes.themeDefaults()).toEqual({ light: "lychee", dark: "gloom" });
  });
});

describe("themeStylesheetUrl", () => {
  it("resolves a theme's stylesheet from its id or its description", () => {
    addThemes(
      [
        {
          type: "patchwork:theme",
          id: "warm",
          name: "Warm",
          style: "./warm.css",
        },
        { type: "patchwork:theme", id: "plain", name: "Plain" },
      ],
      "https://example.com/pkg"
    );
    expect(themes.themeStylesheetUrl("warm")).toBe(
      "https://example.com/pkg/warm.css"
    );
    expect(
      themes.themeStylesheetUrl({
        type: "patchwork:theme",
        id: "absolute",
        name: "Absolute",
        style: "https://cdn.example.com/absolute.css",
      })
    ).toBe("https://cdn.example.com/absolute.css");
    expect(themes.themeStylesheetUrl("plain")).toBeUndefined();
    expect(themes.themeStylesheetUrl("nobody")).toBeUndefined();
  });

  it("a relative style resolves against the package base", () => {
    addThemes(
      [
        {
          type: "patchwork:theme",
          id: "warm",
          name: "Warm",
          style: "./themes/warm.css",
        },
      ],
      "automerge:4NMNnkMhL8jXrdJ9jamS58PAVdXu",
      "https://example.com/root/"
    );
    expect(themes.themeStylesheetUrl("warm")).toBe(
      "https://example.com/root/themes/warm.css"
    );
  });
});

describe("startThemes", () => {
  it("puts the default theme for the mode on <html>, and follows the mode", () => {
    start();
    expect(theme()).toBe("lychee");
    setDark(true);
    expect(theme()).toBe("gloom");
  });

  it("starts once per page", () => {
    start();
    expect(() => themes.startThemes()).toThrow(/already started/);
  });

  it("keeps a stylesheet on the page for each registered theme", () => {
    start();
    const key = addThemes(
      [
        {
          type: "patchwork:theme",
          id: "warm",
          name: "Warm",
          style: "https://example.com/warm.css",
        },
      ],
      "https://example.com/pkg/"
    );
    const hrefs = () =>
      [...document.head.querySelectorAll("link[rel=stylesheet]")].map(
        (link) => (link as HTMLLinkElement).href
      );
    expect(hrefs()).toEqual(["https://example.com/warm.css"]);

    fs.packages.remove(key);
    expect(hrefs()).toEqual([]);
  });

  it("resolves a relative stylesheet against the package that registered it", () => {
    start();
    const folder = "automerge:4NMNnkMhL8jXrdJ9jamS58PAVdXu";
    addThemes(
      [
        {
          type: "patchwork:theme",
          id: "warm",
          name: "Warm",
          style: "./warm.css",
        },
      ],
      "https://example.com/pkg"
    );
    addThemes(
      [
        {
          type: "patchwork:theme",
          id: "cool",
          name: "Cool",
          style: "./themes/cool.css",
        },
      ],
      folder
    );
    const hrefs = [...document.head.querySelectorAll("link[rel=stylesheet]")]
      .map((link) => (link as HTMLLinkElement).href);
    expect(hrefs).toEqual([
      "https://example.com/pkg/warm.css",
      new URL(`/${encodeURIComponent(folder)}/themes/cool.css`, document.baseURI)
        .href,
    ]);
  });

  it("tells listeners when the theme changes", () => {
    start();
    const seen: string[] = [];
    stops.push(themes.onActiveThemeChange((t) => seen.push(t.themeId)));
    setDark(true);
    setDark(true);
    expect(seen).toEqual(["lychee", "gloom"]);
  });
});

describe("followThemePreferences", () => {
  it("uses the account's choice, and follows it as it changes", async () => {
    const prefs = handle<{ light?: string; dark?: string }>({ light: "warm" });
    const account = handle<any>({
      toolStorage: { "theme-preferences": prefs.url },
    });
    start();
    stops.push(themes.followThemePreferences(repoOf(prefs), account as any));
    await tick();
    expect(theme()).toBe("warm");

    prefs.change((doc) => (doc.light = "paper"));
    expect(theme()).toBe("paper");

    setDark(true);
    expect(theme()).toBe("gloom");
    prefs.change((doc) => (doc.dark = "ink"));
    expect(theme()).toBe("ink");
  });

  it("keeps the defaults until the account has a preferences doc", async () => {
    const prefs = handle<{ light?: string }>({ light: "warm" });
    const account = handle<any>({});
    start();
    stops.push(themes.followThemePreferences(repoOf(prefs), account as any));
    await tick();
    expect(theme()).toBe("lychee");

    account.change((doc) => {
      doc.toolStorage = { "theme-preferences": prefs.url };
    });
    await tick();
    expect(theme()).toBe("warm");
  });

  it("never makes the preferences doc", async () => {
    const account = handle<any>({});
    start();
    stops.push(themes.followThemePreferences(repoOf(), account as any));
    await tick();
    expect(account.doc()).toEqual({});
  });
});

describe("patchwork:current-theme", () => {
  it("is answered with the active theme id, and again when it changes", async () => {
    start();
    const { subscribe } = await import("@inkandswitch/patchwork-providers");
    const child = document.createElement("div");
    document.body.appendChild(child);
    const seen: string[] = [];
    stops.push(
      subscribe<string>(child, { type: "patchwork:current-theme" }, (id) =>
        seen.push(id)
      )
    );
    await tick();
    setDark(true);
    await tick();
    expect(seen).toEqual(["lychee", "gloom"]);
    child.remove();
  });

  it("is what followCurrentTheme puts on the page", async () => {
    const { accept } = await import("@inkandswitch/patchwork-providers");
    // A host above the view, as the providers bridge is to an isolated one.
    const host = document.createElement("div");
    const view = document.createElement("div");
    host.appendChild(view);
    document.body.appendChild(host);
    let send: ((id: string) => void) | undefined;
    host.addEventListener("patchwork:subscribe", (event) => {
      accept<string>(event as any, (respond) => {
        send = respond;
        respond("warm");
      });
    });

    stops.push(themes.followCurrentTheme(view));
    await tick();
    expect(theme()).toBe("warm");
    send!("ink");
    await tick();
    expect(theme()).toBe("ink");
    host.remove();
  });
});
