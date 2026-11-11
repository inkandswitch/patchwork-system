import { describe, expect, it } from "vitest";
import {
  bareModuleUrl,
  classifyOrigin,
  documentIdOf,
  headsOf,
  isAutomergeUrl,
  isHttpUrl,
  isInstallableUrl,
  moduleKey,
  moduleKeySet,
  originRank,
  pinnedModuleUrl,
  type Origin,
} from "./origin.ts";

describe("documentIdOf", () => {
  it("reads the id from bare, heads-pinned and queried urls", () => {
    expect(documentIdOf("automerge:abc123")).toBe("abc123");
    expect(documentIdOf("automerge:abc123@head1|head2")).toBe("abc123");
    expect(documentIdOf("automerge:abc123?x=1")).toBe("abc123");
  });
  it("is undefined for anything else", () => {
    expect(documentIdOf("https://tools/foo/index.js")).toBeUndefined();
    expect(documentIdOf(undefined)).toBeUndefined();
  });
});

describe("moduleKey / moduleKeySet", () => {
  it("collapses automerge urls to their id and leaves others alone", () => {
    expect(moduleKey("automerge:mine1")).toBe("mine1");
    expect(moduleKey("automerge:mine2#abc")).toBe("mine2");
    expect(moduleKey("https://x/y.js")).toBe("https://x/y.js");
    expect(moduleKey(undefined)).toBeUndefined();
  });
  it("builds a key set, heads-pinned entries included", () => {
    const keys = moduleKeySet(["automerge:mine1", "automerge:mine2@abc"]);
    expect([...keys].sort()).toEqual(["mine1", "mine2"]);
  });
});

describe("heads", () => {
  it("bareModuleUrl strips heads from automerge urls only", () => {
    expect(bareModuleUrl("automerge:abc#h1|h2")).toBe("automerge:abc");
    expect(bareModuleUrl("automerge:abc")).toBe("automerge:abc");
    expect(bareModuleUrl("https://x/y.js")).toBe("https://x/y.js");
  });
  it("headsOf splits pinned heads", () => {
    expect(headsOf("automerge:abc#h2|h1")).toEqual(["h2", "h1"]);
    expect(headsOf("automerge:abc")).toEqual([]);
    expect(headsOf("https://x/y.js")).toEqual([]);
  });
  it("pinnedModuleUrl sorts and joins, re-pinning a stale url", () => {
    expect(pinnedModuleUrl("automerge:abc", ["h2", "h1"])).toBe(
      "automerge:abc#h1|h2"
    );
    expect(pinnedModuleUrl("automerge:abc#stale", ["z9", "a1"])).toBe(
      "automerge:abc#a1|z9"
    );
    expect(pinnedModuleUrl("automerge:abc", [])).toBeUndefined();
  });
});

describe("classifyOrigin", () => {
  const installed = moduleKeySet(["automerge:mine1", "automerge:mine2@abc"]);
  const system = moduleKeySet([
    "automerge:sys1",
    "https://cdn.example/tool/index.js",
  ]);
  const cases: [string | undefined, Origin][] = [
    ["automerge:mine1", "installed"],
    ["automerge:mine2@deadbeef", "installed"],
    ["automerge:sys1@cafe", "core"],
    ["https://cdn.example/tool/index.js", "core"],
    ["automerge:someoneElse", "ephemeral"],
    ["https://tools.example/other/index.js", "core"],
    ["@patchwork/file", "core"],
    [undefined, "unknown"],
  ];
  it.each(cases)("%s → %s", (url, origin) => {
    expect(classifyOrigin(url, installed, system)).toBe(origin);
  });
});

describe("originRank", () => {
  it("puts installed, then ephemeral, then core, then unknown", () => {
    const origins: Origin[] = ["core", "installed", "unknown", "ephemeral"];
    expect(origins.sort((a, b) => originRank(a) - originRank(b))).toEqual([
      "installed",
      "ephemeral",
      "core",
      "unknown",
    ]);
  });
});

describe("url kinds", () => {
  it("isAutomergeUrl / isHttpUrl go by scheme", () => {
    expect(isAutomergeUrl("automerge:x")).toBe(true);
    expect(isAutomergeUrl("https://x")).toBe(false);
    expect(isAutomergeUrl(undefined)).toBe(false);
    expect(isHttpUrl("https://x")).toBe(true);
    expect(isHttpUrl("HTTP://x")).toBe(true);
    expect(isHttpUrl("automerge:x")).toBe(false);
  });
  it("isInstallableUrl wants a long enough id or a parseable http url", () => {
    expect(isInstallableUrl("automerge:3psiCwUeZNMFrmtiAkX75Jvy1tED")).toBe(true);
    expect(isInstallableUrl("automerge:short")).toBe(false);
    expect(isInstallableUrl("https://example.com/tool/")).toBe(true);
    expect(isInstallableUrl("https://")).toBe(false);
    expect(isInstallableUrl("comments")).toBe(false);
  });
});
