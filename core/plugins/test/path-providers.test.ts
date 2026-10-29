import { afterEach, describe, expect, it, vi } from "vitest";
import { folderProvider, type PathProvider } from "@inkandswitch/patchwork-filesystem";
import { getRegistry, registerPlugins, unregisterPlugins } from "../src/registry/index.js";
import {
  packagePathProviders,
  pathProviderFor,
  pathProviderTypes,
  type PathProviderDescription,
  type PathProviderPlugin,
} from "../src/path-providers.js";

const boardDoc = { "@patchwork": { type: "board" }, links: [] };
const folderDoc = { title: "f", docs: [] };

const provider = (kind: string, extra: Partial<PathProvider> = {}): PathProvider => ({
  kind,
  matches: () => true,
  lookup: () => undefined,
  list: () => [],
  ...extra,
});

const plugin = (
  id: string,
  supportedDatatypes: string[],
  load: () => Promise<unknown>
): PathProviderPlugin =>
  ({
    id,
    name: id,
    type: "patchwork:path-provider",
    supportedDatatypes,
    load,
  }) as PathProviderPlugin;

const URL_ = "https://example.test/pkg.js";

afterEach(() => {
  unregisterPlugins(URL_);
  vi.restoreAllMocks();
});

describe("pathProviderFor", () => {
  it("finds a plugin for the doc's type", async () => {
    const board = provider("board");
    registerPlugins([plugin("board", ["board"], async () => board)], URL_);
    expect(await pathProviderFor(boardDoc)).toBe(board);
    expect(await packagePathProviders(boardDoc)).toBe(board);
  });

  it("asks the built-ins first, whatever a plugin claims", async () => {
    registerPlugins([plugin("greedy", ["folder"], async () => provider("greedy"))], URL_);
    expect(await pathProviderFor(folderDoc)).toBe(folderProvider);
  });

  it("only gives plugins documents of a type they support", async () => {
    registerPlugins([plugin("board", ["board"], async () => provider("board"))], URL_);
    expect(await pathProviderFor({ "@patchwork": { type: "other" } })).toBeUndefined();
    expect(await packagePathProviders(folderDoc)).toBeUndefined();
  });

  it("takes the first registered, skipping one that fails to load or isn't a provider", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const second = provider("second");
    registerPlugins(
      [
        plugin("broken", ["board"], () => Promise.reject(new Error("nope"))),
        plugin("shapeless", ["board"], async () => ({ kind: "shapeless" })),
        plugin("not-matching", ["board"], async () => provider("x", { matches: () => false })),
        plugin("second", ["board"], async () => second),
        plugin("third", ["board"], async () => provider("third")),
      ],
      URL_
    );
    expect(await pathProviderFor(boardDoc)).toBe(second);
    expect(warn).toHaveBeenCalled();
  });

  it("doesn't honor \"*\"", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerPlugins([plugin("star", ["*"], async () => provider("star"))], URL_);
    expect(await pathProviderFor(boardDoc)).toBeUndefined();
    expect(pathProviderTypes().has("*")).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});

describe("pathProviderTypes", () => {
  it("is every type some plugin supports", () => {
    registerPlugins(
      [
        plugin("a", ["board", "canvas"], async () => provider("a")),
        plugin("b", ["board"], async () => provider("b")),
      ],
      URL_
    );
    expect(pathProviderTypes()).toEqual(new Set(["board", "canvas"]));
    expect(getRegistry<PathProviderDescription>("patchwork:path-provider").all()).toHaveLength(2);
  });
});

describe("pathProviderFor: a typed doc that's also folder-shaped", () => {
  it("prefers the plugin for its declared type over the folder built-in", async () => {
    const canvas = provider("canvas");
    registerPlugins([plugin("canvas", ["canvas"], async () => canvas)], URL_);
    expect(await pathProviderFor({ "@patchwork": { type: "canvas" }, docs: [] })).toBe(canvas);
    expect(await pathProviderFor({ "@patchwork": { type: "folder" }, docs: [] })).toBe(folderProvider);
    expect(await pathProviderFor({ "@patchwork": { type: "other" }, docs: [] })).toBe(folderProvider);
  });
});
