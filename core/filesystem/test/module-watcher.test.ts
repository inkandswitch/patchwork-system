import { afterEach, describe, expect, it, vi } from "vitest";
import type { Repo } from "@automerge/automerge-repo/slim";
import { Repo as AutomergeRepo, type PeerId } from "@automerge/automerge-repo";
import { ModuleWatcher } from "../src/module-watcher.js";
import { importPackageFromHttpUrl } from "../src/packages.js";
import {
  fetchLatestViaServiceWorker,
  trackPackagesInRepo,
  type PackageTracker,
} from "../src/package-tracker.js";

/**
 * These tests exercise the static-HTTP-manifest source support added to
 * ModuleWatcher. They avoid any Automerge repo interaction: manifest sources
 * are fetched over HTTP and their (non-automerge) module entries are loaded via
 * plain dynamic `import()`, which we satisfy here with `data:` URLs.
 */

const AUTOMERGE_URL = "automerge:2uZrhZ7G2NJxryZSMWSdDNFCke8C";

function stubFetchManifest(manifestByUrl: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = String(input);
      const body = manifestByUrl[url];
      if (body === undefined) {
        return { ok: false, status: 404 } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => body,
      } as Response;
    })
  );
}

function dataModule(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ModuleWatcher static manifest sources", () => {
  it("resolves relative module URLs against the manifest URL and leaves automerge/absolute URLs untouched", async () => {
    const manifestUrl = "http://example.test/sub/modules.json";
    stubFetchManifest({
      [manifestUrl]: {
        modules: [
          "./tools/file/dist/index.js",
          "https://cdn.example.test/tool/index.js",
          AUTOMERGE_URL,
        ],
      },
    });

    const onLoad = vi.fn();
    const watcher = new ModuleWatcher(
      {} as unknown as Repo,
      { system: manifestUrl },
      onLoad
    );
    await watcher.doneLoading;

    expect(watcher.staticManifests.system.modules).toEqual([
      "http://example.test/sub/tools/file/dist/index.js",
      "https://cdn.example.test/tool/index.js",
      AUTOMERGE_URL,
    ]);
  });

  it("imports modules listed in a static manifest and announces their plugins", async () => {
    const manifestUrl = "http://example.test/modules.json";
    const moduleUrl = dataModule(
      "export const plugins = [{ type: 'patchwork:tool', id: 'demo' }]"
    );
    stubFetchManifest({
      [manifestUrl]: { modules: [moduleUrl] },
    });

    const loaded: Array<{ name: string; mod: any }> = [];
    const watcher = new ModuleWatcher(
      {} as unknown as Repo,
      { system: manifestUrl },
      (name, mod) => loaded.push({ name, mod })
    );
    await watcher.doneLoading;

    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe(moduleUrl);
    expect(loaded[0].mod.plugins).toEqual([
      { type: "patchwork:tool", id: "demo" },
    ]);
  });

  it("unions module entries across multiple manifest sources", async () => {
    const systemUrl = "http://example.test/system.json";
    const userUrl = "http://example.test/user.json";
    const a = dataModule("export const plugins = [{ id: 'a' }]");
    const b = dataModule("export const plugins = [{ id: 'b' }]");
    stubFetchManifest({
      [systemUrl]: { modules: [a] },
      [userUrl]: { modules: [b] },
    });

    const ids = new Set<string>();
    const watcher = new ModuleWatcher(
      {} as unknown as Repo,
      { system: systemUrl, user: userUrl },
      (_name, mod) => {
        for (const p of mod.plugins) ids.add(p.id);
      }
    );
    await watcher.doneLoading;

    expect(ids).toEqual(new Set(["a", "b"]));
  });
});

describe("ModuleWatcher http package resolution", () => {
  it("resolves a trailing-slash directory module via its package.json exports", async () => {
    const manifestUrl = "http://example.test/modules.json";
    const packageUrl = "https://cdn.example.test/mytool/";
    const entryModule = dataModule(
      "export const plugins = [{ type: 'patchwork:tool', id: 'pkg' }]"
    );
    stubFetchManifest({
      [manifestUrl]: { modules: [packageUrl] },
      "https://cdn.example.test/mytool/package.json": {
        exports: { ".": entryModule },
      },
    });

    const loaded: Array<{ name: string; mod: any }> = [];
    const watcher = new ModuleWatcher(
      {} as unknown as Repo,
      { system: manifestUrl },
      (name, mod) => loaded.push({ name, mod })
    );
    await watcher.doneLoading;

    expect(loaded).toHaveLength(1);
    expect(loaded[0].mod.plugins).toEqual([
      { type: "patchwork:tool", id: "pkg" },
    ]);
  });

  it("treats a directory URL without a trailing slash as a package root and falls back to `main`", async () => {
    const manifestUrl = "http://example.test/modules.json";
    const packageUrl = "https://cdn.example.test/mytool";
    const entryModule = dataModule(
      "export const plugins = [{ type: 'patchwork:tool', id: 'main' }]"
    );
    stubFetchManifest({
      [manifestUrl]: { modules: [packageUrl] },
      "https://cdn.example.test/mytool/package.json": { main: entryModule },
    });

    const loaded: Array<{ name: string; mod: any }> = [];
    const watcher = new ModuleWatcher(
      {} as unknown as Repo,
      { system: manifestUrl },
      (name, mod) => loaded.push({ name, mod })
    );
    await watcher.doneLoading;

    expect(loaded).toHaveLength(1);
    expect(loaded[0].mod.plugins).toEqual([
      { type: "patchwork:tool", id: "main" },
    ]);
  });

  it("imports a direct module-file URL as-is, without probing for a package.json", async () => {
    const manifestUrl = "http://example.test/modules.json";
    const moduleUrl = "https://cdn.example.test/mytool/index.js";
    const fetch = vi.fn(async (input: string) => {
      const url = String(input);
      if (url === manifestUrl) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ modules: [moduleUrl] }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });
    vi.stubGlobal("fetch", fetch);

    // A `.js` URL never triggers a package.json lookup — importing the URL
    // directly is left to the loader (which rejects the http scheme in node).
    const watcher = new ModuleWatcher(
      {} as unknown as Repo,
      { system: manifestUrl },
      () => {}
    );
    await watcher.doneLoading;

    expect(
      fetch.mock.calls.some(([u]) => String(u).endsWith("package.json"))
    ).toBe(false);
  });
});

describe("ModuleWatcher stale announce retries", () => {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("a superseded retry never rolls the registry back to an older version", async () => {
    const repo = new AutomergeRepo({ peerId: "watcher-test" as PeerId });
    try {
      const folder = repo.create<any>();
      folder.change((d: any) => {
        d["@patchwork"] = { type: "folder" };
        d.rev = 0;
      });
      const settings = repo.create<any>();
      settings.change((d: any) => {
        d["@patchwork"] = { type: "patchwork:module-settings" };
        d.modules = [folder.url];
      });

      // The injected importer's behaviour is swapped between phases; every
      // versioned url it is asked for is recorded so the test can tell the
      // module versions apart.
      const importCalls: string[] = [];
      let importBehavior: (url: string) => any = () => ({ plugins: [] });
      const importAutomergePackage = async (urlAtHeads: string) => {
        importCalls.push(urlAtHeads);
        return importBehavior(urlAtHeads);
      };

      const announced: string[] = [];
      const watcher = new ModuleWatcher(
        repo,
        { system: settings.url },
        (name) => announced.push(name),
        undefined,
        importAutomergePackage
      );
      await watcher.doneLoading;
      expect(announced).toHaveLength(1);

      // v1: the import fails, leaving a retry chain backing off (first retry
      // fires 1s after the failed attempt).
      importBehavior = () => undefined;
      folder.change((d: any) => {
        d.rev = 1;
      });
      await pause(500); // > the 250ms reload debounce
      const v1Url = importCalls[importCalls.length - 1];
      expect(v1Url).not.toBe(folder.url); // pinned to heads

      // v2: imports succeed again; this reload supersedes v1's retry chain.
      importBehavior = () => ({ plugins: [] });
      folder.change((d: any) => {
        d.rev = 2;
      });
      await pause(500);
      const v2Url = importCalls[importCalls.length - 1];
      expect(v2Url).not.toBe(v1Url);
      expect(announced[announced.length - 1]).toBe(v2Url);

      // Let v1's retry window pass. A stale retry that survived would import
      // v1 again — now successfully — and announce it *after* v2, rolling the
      // registry back to the older version.
      await pause(1_500);
      expect(importCalls.filter((u) => u === v1Url)).toHaveLength(1);
      expect(announced).not.toContain(v1Url);
      expect(announced[announced.length - 1]).toBe(v2Url);
    } finally {
      await repo.shutdown().catch(() => {});
    }
  });
});

describe("ModuleWatcher module lifecycle", () => {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function makeFixture(repo: InstanceType<typeof AutomergeRepo>) {
    const folder = repo.create<any>();
    folder.change((d: any) => {
      d["@patchwork"] = { type: "folder" };
      d.rev = 0;
    });
    const settings = repo.create<any>();
    settings.change((d: any) => {
      d["@patchwork"] = { type: "patchwork:module-settings" };
      d.modules = [folder.url];
    });
    const importCalls: string[] = [];
    const importAutomergePackage = async (urlAtHeads: string) => {
      importCalls.push(urlAtHeads);
      return { plugins: [] };
    };
    return { folder, settings, importCalls, importAutomergePackage };
  }

  it("unloads a module removed from settings and ignores later folder-doc changes", async () => {
    const repo = new AutomergeRepo({ peerId: "watcher-unload" as PeerId });
    try {
      const { folder, settings, importCalls, importAutomergePackage } =
        makeFixture(repo);

      const unloaded: string[] = [];
      const watcher = new ModuleWatcher(
        repo,
        { system: settings.url },
        () => {},
        (name) => unloaded.push(name),
        importAutomergePackage
      );
      await watcher.doneLoading;
      expect(importCalls).toHaveLength(1);

      settings.change((d: any) => {
        d.modules = [];
      });
      await pause(100);
      // Under the url it was imported from, which its plugins are registered under.
      expect(unloaded).toEqual([importCalls[0]]);

      folder.change((d: any) => {
        d.rev = 1;
      });
      await pause(500);
      expect(importCalls).toHaveLength(1);
    } finally {
      await repo.shutdown().catch(() => {});
    }
  });

  it("does not re-import a module when the settings doc changes but its heads have not", async () => {
    const repo = new AutomergeRepo({ peerId: "watcher-memo" as PeerId });
    try {
      const { settings, importCalls, importAutomergePackage } =
        makeFixture(repo);

      const watcher = new ModuleWatcher(
        repo,
        { system: settings.url },
        () => {},
        undefined,
        importAutomergePackage
      );
      await watcher.doneLoading;
      expect(importCalls).toHaveLength(1);

      settings.change((d: any) => {
        d.touched = 1;
      });
      await pause(300);
      expect(importCalls).toHaveLength(1);
    } finally {
      await repo.shutdown().catch(() => {});
    }
  });

  it("dispose() detaches settings and folder-doc listeners", async () => {
    const repo = new AutomergeRepo({ peerId: "watcher-dispose" as PeerId });
    try {
      const { folder, settings, importCalls, importAutomergePackage } =
        makeFixture(repo);
      const other = repo.create<any>();
      other.change((d: any) => {
        d["@patchwork"] = { type: "folder" };
      });

      const watcher = new ModuleWatcher(
        repo,
        { system: settings.url },
        () => {},
        undefined,
        importAutomergePackage
      );
      await watcher.doneLoading;
      expect(importCalls).toHaveLength(1);

      watcher.dispose();

      folder.change((d: any) => {
        d.rev = 1;
      });
      settings.change((d: any) => {
        d.modules = [folder.url, other.url];
      });
      await pause(500);
      expect(importCalls).toHaveLength(1);
    } finally {
      await repo.shutdown().catch(() => {});
    }
  });
});

describe("ModuleWatcher package trackers", () => {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * A PackageTracker the way the browser's works: the watcher only ever sees
   * urls at heads and change calls, and the package docs live in a Repo of
   * their own, standing in for the automerge worker's.
   */
  function trackElsewhere(repo: InstanceType<typeof AutomergeRepo>) {
    const lookups: string[] = [];
    const watching = new Map<string, Parameters<PackageTracker["watch"]>[1]>();
    const real = trackPackagesInRepo(repo);
    const tracker: PackageTracker = {
      async findLatest(url) {
        lookups.push(url);
        return real.findLatest(url);
      },
      watch(url, onChange) {
        watching.set(url, onChange);
        return () => watching.delete(url);
      },
    };
    return { tracker, lookups, watching };
  }

  it("reloads a module when its tracker says the package moved", async () => {
    const folders = new AutomergeRepo({ peerId: "folders" as PeerId });
    const tab = new AutomergeRepo({ peerId: "tab" as PeerId });
    try {
      const folder = folders.create<any>({ "@patchwork": { type: "folder" } });
      const settings = tab.create<any>({
        "@patchwork": { type: "patchwork:module-settings" },
        modules: [folder.url],
      });
      const { tracker, watching } = trackElsewhere(folders);
      const imported: string[] = [];
      const watcher = new ModuleWatcher(
        tab,
        { system: settings.url },
        () => {},
        undefined,
        async (url) => {
          imported.push(url);
          return { plugins: [] };
        },
        tracker
      );
      await watcher.doneLoading;
      expect(imported).toEqual([folder.view(folder.heads()).url]);
      // Only the settings doc was ever loaded on the watcher's side.
      expect(Object.keys(tab.handles)).toEqual([settings.documentId]);

      folder.change((d: any) => {
        d.rev = 1;
      });
      watching.get(folder.url)!();
      await pause(400);
      expect(imported).toEqual([
        imported[0],
        folder.view(folder.heads()).url,
      ]);

      // A call with nothing new behind it costs a lookup, not an import.
      watching.get(folder.url)!();
      await pause(400);
      expect(imported).toHaveLength(2);

      watcher.dispose();
      expect(watching.size).toBe(0);
    } finally {
      await Promise.all([folders.shutdown(), tab.shutdown()]).catch(() => {});
    }
  });

  it("looks the package up only when what the tracker holds changes", async () => {
    const folders = new AutomergeRepo({ peerId: "folders" as PeerId });
    const tab = new AutomergeRepo({ peerId: "tab" as PeerId });
    try {
      const folder = folders.create<any>({ "@patchwork": { type: "folder" } });
      const settings = tab.create<any>({
        "@patchwork": { type: "patchwork:module-settings" },
        modules: [folder.url],
      });
      const { tracker, lookups, watching } = trackElsewhere(folders);
      const imported: string[] = [];
      const watcher = new ModuleWatcher(
        tab,
        { system: settings.url },
        () => {},
        undefined,
        async (url) => {
          imported.push(url);
          return { plugins: [] };
        },
        tracker
      );
      await watcher.doneLoading;
      const said = watching.get(folder.url)!;
      // What it holds, once it's watching.
      said("a");
      await pause(400);
      lookups.length = 0;
      // One with heads is answered without going anywhere.
      const headless = () => lookups.filter((url) => !url.includes("#"));

      // A restarted tracker saying the same: nothing arrived.
      said("a");
      await pause(400);
      expect(headless()).toEqual([]);
      expect(imported).toHaveLength(1);

      // Something arrived. What it says isn't the version to import: the
      // lookup finds that.
      folder.change((d: any) => {
        d.rev = 1;
      });
      said("b");
      await pause(400);
      expect(headless()).toEqual([folder.url]);
      expect(imported).toEqual([imported[0], folder.view(folder.heads()).url]);
      watcher.dispose();
    } finally {
      await Promise.all([folders.shutdown(), tab.shutdown()]).catch(() => {});
    }
  });

  it("reloads for a change that lands while the first lookup is in flight", async () => {
    const folders = new AutomergeRepo({ peerId: "folders" as PeerId });
    const tab = new AutomergeRepo({ peerId: "tab" as PeerId });
    try {
      const folder = folders.create<any>({ "@patchwork": { type: "folder" } });
      const settings = tab.create<any>({
        "@patchwork": { type: "patchwork:module-settings" },
        modules: [folder.url],
      });
      const { tracker, watching } = trackElsewhere(folders);
      const realFindLatest = tracker.findLatest;
      let first = true;
      tracker.findLatest = async (url) => {
        const latest = await realFindLatest(url);
        if (first) {
          // The lookup has its answer; the package moves before it's back.
          first = false;
          folder.change((d: any) => {
            d.rev = 1;
          });
          watching.get(folder.url)!();
        }
        return latest;
      };
      const imported: string[] = [];
      const watcher = new ModuleWatcher(
        tab,
        { system: settings.url },
        () => {},
        undefined,
        async (url) => {
          imported.push(url);
          return { plugins: [] };
        },
        tracker
      );
      await watcher.doneLoading;
      await pause(400);
      expect(imported.at(-1)).toBe(folder.view(folder.heads()).url);
      watcher.dispose();
    } finally {
      await Promise.all([folders.shutdown(), tab.shutdown()]).catch(() => {});
    }
  });

  it("looks up once more, not once per change, for changes during a slow lookup", async () => {
    const folders = new AutomergeRepo({ peerId: "folders" as PeerId });
    const tab = new AutomergeRepo({ peerId: "tab" as PeerId });
    try {
      const folder = folders.create<any>({ "@patchwork": { type: "folder" } });
      const settings = tab.create<any>({
        "@patchwork": { type: "patchwork:module-settings" },
        modules: [folder.url],
      });
      const { tracker, lookups, watching } = trackElsewhere(folders);
      const realFindLatest = tracker.findLatest;
      // Holds the next headless lookup until released.
      let hold: Promise<void> | undefined;
      tracker.findLatest = async (url) => {
        if (hold && !url.includes("#")) await hold;
        return realFindLatest(url);
      };
      const imported: string[] = [];
      const watcher = new ModuleWatcher(
        tab,
        { system: settings.url },
        () => {},
        undefined,
        async (url) => {
          imported.push(url);
          return { plugins: [] };
        },
        tracker
      );
      await watcher.doneLoading;
      lookups.length = 0;

      const { promise, resolve: release } = Promise.withResolvers<void>();
      hold = promise;
      folder.change((d: any) => {
        d.rev = 1;
      });
      watching.get(folder.url)!();
      // Past the debounce, so the first lookup is in flight.
      await pause(400);
      // Each past the debounce too, so each would start a lookup of its own.
      for (let rev = 2; rev <= 6; rev++) {
        folder.change((d: any) => {
          d.rev = rev;
        });
        watching.get(folder.url)!();
        await pause(300);
      }
      hold = undefined;
      release();
      await pause(400);

      // Imports look up their pinned url too; only headless lookups reach the
      // automerge worker.
      expect(lookups.filter((url) => !url.includes("#"))).toHaveLength(2);
      expect(imported.at(-1)).toBe(folder.view(folder.heads()).url);
      watcher.dispose();
    } finally {
      await Promise.all([folders.shutdown(), tab.shutdown()]).catch(() => {});
    }
  });

  it("watches a branches doc's default branch, and looks up through the branches doc", async () => {
    const folders = new AutomergeRepo({ peerId: "folders" as PeerId });
    const tab = new AutomergeRepo({ peerId: "tab" as PeerId });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const folder = folders.create<any>({ "@patchwork": { type: "folder" } });
      const branches = folders.create<any>({
        "@patchwork": { type: "branches" },
        branches: { default: folder.url },
      });
      const settings = tab.create<any>({
        "@patchwork": { type: "patchwork:module-settings" },
        modules: [branches.url],
      });
      const { tracker, lookups, watching } = trackElsewhere(folders);
      const imported: string[] = [];
      const watcher = new ModuleWatcher(
        tab,
        { system: settings.url },
        () => {},
        undefined,
        async (url) => {
          imported.push(url);
          return { plugins: [] };
        },
        tracker
      );
      await watcher.doneLoading;
      expect(imported).toEqual([folder.view(folder.heads()).url]);
      expect([...watching.keys()]).toEqual([folder.url]);
      expect(warn).toHaveBeenCalled();

      folder.change((d: any) => {
        d.rev = 1;
      });
      watching.get(folder.url)!();
      await pause(400);
      // The watch began from a lookup of the branches doc; the reload looks it
      // up again rather than the folder, in case the branch moved.
      expect(lookups.filter((url) => url === branches.url)).toHaveLength(2);
      expect(imported.at(-1)).toBe(folder.view(folder.heads()).url);
      watcher.dispose();
    } finally {
      warn.mockRestore();
      await Promise.all([folders.shutdown(), tab.shutdown()]).catch(() => {});
    }
  });

  it("finds the latest version through the service worker's redirect", async () => {
    const repo = new AutomergeRepo({ peerId: "latest" as PeerId });
    const doc = repo.create<any>({ rev: 0 });
    const withoutHeads = doc.url;
    const atHeads = doc.view(doc.heads()).url;
    await repo.shutdown();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL) => {
        expect(String(input)).toBe(
          `http://example.test/${encodeURIComponent(withoutHeads)}/package.json`
        );
        return {
          status: 200,
          url: `http://example.test/${encodeURIComponent(atHeads)}/package.json`,
        } as Response;
      })
    );
    vi.stubGlobal("location", { origin: "http://example.test" });
    expect(await fetchLatestViaServiceWorker(withoutHeads)).toBe(atHeads);
    // Already at heads: nothing to ask.
    expect(await fetchLatestViaServiceWorker(atHeads)).toBe(atHeads);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("passes on the automerge worker's reason when it couldn't resolve", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL) => ({
        status: 557,
        url: String(input),
        text: async () => "Document 2Jts is unavailable\n\nError: ...stack",
      }))
    );
    vi.stubGlobal("location", { origin: "http://example.test" });
    await expect(fetchLatestViaServiceWorker(AUTOMERGE_URL)).rejects.toThrow(
      /HTTP 557 .*: Document 2Jts is unavailable$/
    );
  });

  it("says so when the service worker didn't redirect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL) => ({ status: 404, url: String(input) }))
    );
    vi.stubGlobal("location", { origin: "http://example.test" });
    await expect(fetchLatestViaServiceWorker(AUTOMERGE_URL)).rejects.toThrow(
      /didn't redirect/
    );
  });
});

describe("importPackageFromHttpUrl error handling", () => {
  it("rethrows a rejected package.json fetch (network/CORS) with the original error as cause", async () => {
    // A CORS-blocked or offline fetch rejects with a TypeError rather than
    // resolving to a non-ok response. That must surface (not silently fall back
    // to importing the bare URL), since the same wall blocks the module import.
    const networkError = new TypeError("Failed to fetch");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw networkError;
      })
    );

    const err = await importPackageFromHttpUrl(
      "https://cdn.example.test/mytool/"
    ).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/Couldn't fetch .*package\.json/);
    expect(err.message).toMatch(/CORS/);
    expect(err.cause).toBe(networkError);
  });

  it("throws with cause when package.json is fetched but isn't valid JSON", async () => {
    const parseError = new SyntaxError("Unexpected token < in JSON");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw parseError;
        },
      }))
    );

    const err = await importPackageFromHttpUrl(
      "https://cdn.example.test/mytool/"
    ).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/couldn't parse it as JSON/);
    expect(err.cause).toBe(parseError);
  });
});

describe("ModuleWatcher /packages folder", () => {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Packages as a /packages folder lists them, and a tracker that looks them up as http modules. */
  function folderSource(repo: InstanceType<typeof AutomergeRepo>) {
    const docs = [0, 1].map(() => repo.create<any>({ "@patchwork": { type: "directory" } }));
    let entries = docs.map((doc, i) => ({
      url: doc.url,
      name: `pkg${i}`,
      memberStep: "m@h",
    }));
    let changed: () => void = () => {};
    const lookups: string[] = [];
    const tracker: PackageTracker = {
      async findLatest(url) {
        lookups.push(url);
        return dataModule(`export const plugins = []; // ${url}`) as any;
      },
      watch: () => () => {},
    };
    return {
      docs,
      tracker,
      lookups,
      entries: () => entries,
      subscribe: (onChange: () => void) => {
        changed = onChange;
        return () => {};
      },
      set(next: typeof entries) {
        entries = next;
        changed();
      },
    };
  }

  it("loads every package in the folder", async () => {
    const repo = new AutomergeRepo({ peerId: "tab" as PeerId });
    const source = folderSource(repo);
    const loaded: string[] = [];
    const watcher = new ModuleWatcher(repo, {}, (name) => loaded.push(name), undefined, undefined, source.tracker);
    await watcher.addPackagesFolder("packages", source.entries, source.subscribe);
    expect(loaded).toHaveLength(2);
    expect(source.lookups.sort()).toEqual(source.docs.map((d) => d.url).sort());
    watcher.dispose();
    await repo.shutdown().catch(() => {});
  });

  it("loads a package in both module settings and /packages once", async () => {
    const repo = new AutomergeRepo({ peerId: "tab" as PeerId });
    const source = folderSource(repo);
    const atHeads = source.docs[0].view(source.docs[0].heads()).url;
    const settings = repo.create<any>({
      "@patchwork": { type: "patchwork:module-settings" },
      modules: [atHeads],
    });
    const loaded: string[] = [];
    const watcher = new ModuleWatcher(
      repo,
      {},
      (name) => loaded.push(name),
      undefined,
      undefined,
      source.tracker
    );
    // As patchwork wires them: /packages first, then the user's module settings.
    await watcher.addPackagesFolder("packages", source.entries, source.subscribe);
    await watcher.addUrl("user", settings.url);
    await pause(50);
    expect(loaded).toHaveLength(2);
    expect(source.lookups).not.toContain(atHeads);
    watcher.dispose();
    await repo.shutdown().catch(() => {});
  });

  it("doesn't reload a renamed package, and unloads a removed one", async () => {
    const repo = new AutomergeRepo({ peerId: "tab" as PeerId });
    const source = folderSource(repo);
    const loaded: string[] = [];
    const unloaded: string[] = [];
    const watcher = new ModuleWatcher(
      repo,
      {},
      (name) => loaded.push(name),
      (name) => unloaded.push(name),
      undefined,
      source.tracker
    );
    await watcher.addPackagesFolder("packages", source.entries, source.subscribe);
    expect(loaded).toHaveLength(2);

    source.set(source.entries().map((e, i) => (i === 0 ? { ...e, name: "renamed" } : e)));
    await pause(50);
    expect(loaded).toHaveLength(2);

    source.set([source.entries()[0]]);
    await pause(50);
    expect(unloaded).toHaveLength(1);
    expect(loaded).toContain(unloaded[0]);
    watcher.dispose();
    await repo.shutdown().catch(() => {});
  });
});

describe("ModuleWatcher /packages, through the real lookup chain", () => {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function packagesAccount() {
    const { idhash } = await import("../src/paths.js");
    const { pinnedPath } = await import("../src/walk.js");
    const { trackPackagesFolder, watchPackagesFolder } = await import("../src/packages-folder.js");
    const repo = new AutomergeRepo({ peerId: "tab" as PeerId });
    const pkg = () => {
      const json = repo.create({ "@patchwork": { type: "file" }, content: "{}", mimeType: "application/json" });
      return repo.create<any>({ "@patchwork": { type: "directory" }, "package.json": json.url });
    };
    const [p1, p2, p3] = [pkg(), pkg(), pkg()];
    const member = repo.create<any>({
      title: "packages",
      docs: [
        { name: "one", type: "directory", url: p1.url },
        { name: "two", type: "directory", url: p2.url },
      ],
    });
    const account = repo.create<any>({
      "@patchwork": { type: "account" },
      namespace: { "/packages": [{ url: member.url }] },
    });
    const a = await idhash(account.documentId);
    const accounts = new Map([[a, account.url]]);
    // The pinned path a lookup would redirect to, as a module that says which.
    const lookUp = async (path: string) => {
      const pinned = await pinnedPath(repo, path, { accounts, only: "end" });
      return `data:text/javascript,export const plugins = []//${pinned!.path}`;
    };
    let entries: any[] = [];
    const listeners = new Set<() => void>();
    const first = Promise.withResolvers<void>();
    watchPackagesFolder(repo, account, (next) => {
      entries = next;
      first.resolve();
      for (const listener of listeners) listener();
    });
    await first.promise;
    const fallback: PackageTracker = { findLatest: async (u) => u, watch: () => () => {} };
    const tracker = trackPackagesFolder(Promise.resolve(a), () => entries, fallback, lookUp);
    const loaded: string[] = [];
    const unloaded: string[] = [];
    const watcher = new ModuleWatcher(
      repo,
      {},
      (name) => loaded.push(name),
      (name) => unloaded.push(name),
      undefined,
      tracker
    );
    await watcher.addPackagesFolder("packages", () => entries, (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    });
    return { repo, member, p3, watcher, loaded, unloaded };
  }

  it("adding a package to the folder loads only that package", async () => {
    const { repo, member, p3, watcher, loaded } = await packagesAccount();
    expect(loaded).toHaveLength(2);
    member.change((d: any) => d.docs.push({ name: "three", type: "directory", url: p3.url }));
    await pause(300);
    expect(loaded).toHaveLength(3);
    watcher.dispose();
    await repo.shutdown().catch(() => {});
  });

  it("renaming a package reloads nothing", async () => {
    const { repo, member, watcher, loaded } = await packagesAccount();
    member.change((d: any) => (d.docs[0].name = "uno"));
    await pause(300);
    expect(loaded).toHaveLength(2);
    watcher.dispose();
    await repo.shutdown().catch(() => {});
  });

  it("removing a package unloads it under the name it was loaded with", async () => {
    const { repo, member, watcher, loaded, unloaded } = await packagesAccount();
    member.change((d: any) => d.docs.splice(1, 1));
    await pause(300);
    expect(unloaded).toHaveLength(1);
    expect(loaded).toContain(unloaded[0]);
    watcher.dispose();
    await repo.shutdown().catch(() => {});
  });
});

describe("ModuleWatcher lookup retries", () => {
  it("retries a lookup that failed", async () => {
    const repo = new AutomergeRepo({ peerId: "tab" as PeerId });
    const doc = repo.create<any>({ "@patchwork": { type: "directory" } });
    let calls = 0;
    const tracker: PackageTracker = {
      async findLatest() {
        if (calls++ === 0) throw new Error("not yet");
        return dataModule("export const plugins = []") as any;
      },
      watch: () => () => {},
    };
    const loaded: string[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const watcher = new ModuleWatcher(repo, {}, (name) => loaded.push(name), undefined, undefined, tracker);
    await watcher.addPackagesFolder(
      "packages",
      () => [{ url: doc.url, name: "p", memberStep: "m@h" }],
      () => () => {}
    );
    expect(loaded).toHaveLength(0);
    await vi.waitFor(() => expect(loaded).toHaveLength(1), { timeout: 3000 });
    watcher.dispose();
    errors.mockRestore();
    await repo.shutdown().catch(() => {});
  });
});
