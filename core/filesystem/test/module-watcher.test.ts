import { afterEach, describe, expect, it, vi } from "vitest";
import type { Repo } from "@automerge/automerge-repo/slim";
import {
  Repo as AutomergeRepo,
  generateAutomergeUrl,
  type AutomergeUrl,
  type PeerId,
} from "@automerge/automerge-repo";
import { ModuleWatcher } from "../src/module-watcher.js";
import { importPackageFromHttpUrl } from "../src/packages.js";
import { PackageDatabase } from "../src/package-db/database.js";
import type { AddedBy } from "../src/package-db/types.js";
import {
  fetchLatestViaServiceWorker,
  trackPackagesInRepo,
  type PackageTracker,
} from "../src/package-tracker.js";

// Static manifest sources are fetched over HTTP, and their modules imported
// with a plain `import()`, which `data:` URLs satisfy here.

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
        text: async () => JSON.stringify(body),
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
    watcher.dispose();
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

  it("says which package lists have an entry in them", async () => {
    const systemUrl = "http://example.test/system.json";
    const userUrl = "http://example.test/user.json";
    const a = dataModule("export const plugins = [{ id: 'a' }]");
    const b = dataModule("export const plugins = [{ id: 'b' }]");
    stubFetchManifest({
      [systemUrl]: { modules: [a, b] },
      [userUrl]: { modules: [b] },
    });
    const watcher = new ModuleWatcher(
      {} as unknown as Repo,
      { system: systemUrl, user: userUrl },
      () => {}
    );
    await watcher.doneLoading;

    expect(watcher.listsWith(a)).toEqual([{ name: "system", url: systemUrl }]);
    expect(watcher.listsWith(b)).toEqual([
      { name: "system", url: systemUrl },
      { name: "user", url: userUrl },
    ]);
    expect(watcher.listsWith("https://elsewhere.test/")).toEqual([]);
    watcher.dispose();
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

      // Swapped between phases. Every url it's asked for is recorded, to tell
      // the versions apart.
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
      expect(unloaded).toEqual([folder.url]);

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
    // resolving to a non-ok response, and the same wall blocks the import.
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => "<html>",
      }))
    );

    const err = await importPackageFromHttpUrl(
      "https://cdn.example.test/mytool/"
    ).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/couldn't parse it as JSON/);
    expect(err.cause).toBeInstanceOf(SyntaxError);
  });
});

describe("ModuleWatcher with a stub tracker", () => {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** A tracker that answers from `latest` and records who is watching. */
  function stubTracker(
    findLatest: PackageTracker["findLatest"] = async (url) => url
  ) {
    const watching = new Map<string, Parameters<PackageTracker["watch"]>[1]>();
    const tracker: PackageTracker = {
      findLatest: (url) => findLatest(url),
      watch(url, onChange) {
        watching.set(url, onChange);
        return () => watching.delete(url);
      },
    };
    return { tracker, watching };
  }

  function docUrls(repo: InstanceType<typeof AutomergeRepo>) {
    const doc = repo.create<any>({ "@patchwork": { type: "folder" } });
    return { url: doc.url, atHeads: doc.view(doc.heads()).url };
  }

  it("tells onUnload the url that was loaded, which a branch package does not share with its settings entry", async () => {
    const repo = new AutomergeRepo({ peerId: "unload-url" as PeerId });
    try {
      const entry = docUrls(repo);
      const branch = docUrls(repo);
      const settings = repo.create<any>({
        "@patchwork": { type: "patchwork:module-settings" },
        modules: [entry.url],
      });
      const { tracker } = stubTracker(async () => branch.atHeads);
      const unloaded: Array<[string, string]> = [];
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const watcher = new ModuleWatcher(
        repo,
        { system: settings.url },
        () => {},
        (name, importUrl) => unloaded.push([name, importUrl]),
        async () => ({ plugins: [] }),
        tracker
      );
      await watcher.doneLoading;

      settings.change((d: any) => {
        d.modules = [];
      });
      await pause(100);

      expect(unloaded).toEqual([[entry.url, branch.atHeads]]);
      warn.mockRestore();
      watcher.dispose();
    } finally {
      await repo.shutdown().catch(() => {});
    }
  });

  it("unloads the previous branch's plugins when the default branch moves to another document", async () => {
    const repo = new AutomergeRepo({ peerId: "branch-moves" as PeerId });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const entry = docUrls(repo);
      const first = docUrls(repo);
      const second = docUrls(repo);
      const settings = repo.create<any>({
        "@patchwork": { type: "patchwork:module-settings" },
        modules: [entry.url],
      });
      let latest = first.atHeads;
      const { tracker, watching } = stubTracker(async () => latest);
      const events: string[] = [];
      const watcher = new ModuleWatcher(
        repo,
        { system: settings.url },
        (url) => events.push(`load ${url}`),
        (name, url) => events.push(`unload ${name} ${url}`),
        async () => ({ plugins: [] }),
        tracker
      );
      await watcher.doneLoading;

      latest = second.atHeads;
      watching.get(first.url)!();
      await pause(400);

      expect(events).toEqual([
        `load ${first.atHeads}`,
        `unload ${entry.url} ${first.atHeads}`,
        `load ${second.atHeads}`,
      ]);
      watcher.dispose();
    } finally {
      warn.mockRestore();
      await repo.shutdown().catch(() => {});
    }
  });

  describe("when the first lookup fails", () => {
    async function setup() {
      const repo = new AutomergeRepo({ peerId: "lookup-fails" as PeerId });
      const entry = docUrls(repo);
      const settings = repo.create<any>({
        "@patchwork": { type: "patchwork:module-settings" },
        modules: [entry.url],
      });
      let failures = 1;
      const { tracker, watching } = stubTracker(async () => {
        if (failures-- > 0) throw new Error("worker not up yet");
        return entry.atHeads;
      });
      const imported: string[] = [];
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const watcher = new ModuleWatcher(
        repo,
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
      return { repo, entry, watcher, watching, imported };
    }

    it("tries the lookup again after a delay", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { repo, entry, watcher, imported } = await setup();
      try {
        expect(imported).toEqual([]);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(imported).toEqual([entry.atHeads]);
      } finally {
        watcher.dispose();
        vi.useRealTimers();
        vi.restoreAllMocks();
        await repo.shutdown().catch(() => {});
      }
    });

    it("doesn't look again for a module that went while its lookup was out", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const repo = new AutomergeRepo({ peerId: "lookup-out" as PeerId });
      const entry = docUrls(repo);
      const settings = repo.create<any>({
        "@patchwork": { type: "patchwork:module-settings" },
        modules: [entry.url],
      });
      let fail!: (error: Error) => void;
      const findLatest = vi.fn(
        () => new Promise<AutomergeUrl>((_, reject) => (fail = reject))
      );
      const { tracker } = stubTracker(findLatest);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const watcher = new ModuleWatcher(
        repo,
        { system: settings.url },
        () => {},
        undefined,
        async () => ({ plugins: [] }),
        tracker
      );
      try {
        await vi.waitFor(() => expect(findLatest).toHaveBeenCalledTimes(1));
        watcher.dispose();
        fail(new Error("worker not up yet"));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(findLatest).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
        vi.restoreAllMocks();
        await repo.shutdown().catch(() => {});
      }
    });

    it("does not swallow the first change the tracker reports", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { repo, entry, watcher, watching, imported } = await setup();
      try {
        watching.get(entry.url)!("seen-1");
        await vi.advanceTimersByTimeAsync(300);
        expect(imported).toEqual([entry.atHeads]);
      } finally {
        watcher.dispose();
        vi.useRealTimers();
        vi.restoreAllMocks();
        await repo.shutdown().catch(() => {});
      }
    });
  });
});

describe("ModuleWatcher.prioritize", () => {
  const tool = (id: string) => ({ type: "patchwork:tool", id });
  const ticks = async (n = 10) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
  };

  // Each source is a static manifest of package docs, looked up as they are
  // and imported only when the test says.
  function setup(sources: Record<string, AutomergeUrl[]>) {
    const manifests: Record<string, unknown> = {};
    const urls: Record<string, string> = {};
    for (const [name, modules] of Object.entries(sources)) {
      urls[name] = `http://example.test/${name}.json`;
      manifests[urls[name]] = { modules };
    }
    stubFetchManifest(manifests);
    const started: string[] = [];
    const imports = new Map<string, (mod: any) => void>();
    const tracker: PackageTracker = {
      findLatest: async (url) => url,
      watch: () => () => {},
    };
    const loaded: string[] = [];
    const watcher = new ModuleWatcher(
      {} as unknown as Repo,
      urls,
      (_name, _mod, key) => loaded.push(key),
      undefined,
      (url) => {
        started.push(url);
        return new Promise((resolve) => imports.set(url, resolve));
      },
      tracker
    );
    return {
      watcher,
      started,
      loaded,
      provide: (url: string, ...plugins: { type: string; id: string }[]) =>
        imports.get(url)!({ plugins }),
      fail: (url: string) => imports.get(url)!(undefined),
      addManifest(name: string, modules: AutomergeUrl[]) {
        manifests[`http://example.test/${name}.json`] = { modules };
        return `http://example.test/${name}.json`;
      },
    };
  }

  const [a, b, c, d] = Array.from({ length: 4 }, () => generateAutomergeUrl());

  it("loads each batch once the one before has provided what it was expected to", async () => {
    const { watcher, started, provide } = setup({ system: [a, b, c, d] });
    const prioritized = watcher.prioritize([
      { [a]: [tool("frame")] },
      { [b]: [tool("sidebar")] },
    ]);
    try {
      await ticks();
      expect(started).toEqual([a]);

      provide(a, tool("frame"), tool("other"));
      await ticks();
      expect(started).toEqual([a, b]);

      provide(b, tool("sidebar"));
      await ticks();
      expect(started.sort()).toEqual([a, b, c, d].sort());
      expect(await prioritized).toBe(true);

      provide(c);
      provide(d);
      await watcher.doneLoading;
    } finally {
      watcher.dispose();
    }
  });

  it("lets everything go when an entry no longer provides a plugin it was expected to", async () => {
    const { watcher, started, provide } = setup({ system: [a, b, c] });
    const prioritized = watcher.prioritize([
      { [a]: [tool("frame")] },
      { [b]: [tool("sidebar")] },
    ]);
    try {
      await ticks();
      provide(a, tool("a-different-frame"));
      await ticks();
      expect(started.sort()).toEqual([a, b, c].sort());
      expect(await prioritized).toBe(false);
    } finally {
      watcher.dispose();
    }
  });

  it("lets everything go when an entry fails to load", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { watcher, started, fail } = setup({ system: [a, b, c] });
    const prioritized = watcher.prioritize([{ [a]: [tool("frame")] }]);
    try {
      await ticks();
      fail(a);
      await ticks();
      expect(started.sort()).toEqual([a, b, c].sort());
      expect(await prioritized).toBe(false);
    } finally {
      watcher.dispose();
      vi.restoreAllMocks();
    }
  });

  it("lets everything go when a batch takes too long", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { watcher, started } = setup({ system: [a, b, c] });
    const prioritized = watcher.prioritize([{ [a]: [tool("frame")] }]);
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(started).toEqual([a]);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(started.sort()).toEqual([a, b, c].sort());
      expect(await prioritized).toBe(false);
    } finally {
      watcher.dispose();
      vi.useRealTimers();
    }
  });

  it("lists a later source without waiting for the first's modules, which wait for its batch", async () => {
    const { watcher, started, provide, addManifest } = setup({
      system: [a, b],
    });
    const prioritized = watcher.prioritize([{ [c]: [tool("installed")] }]);
    try {
      await ticks();
      expect(started).toEqual([]);

      void watcher.addUrl("user", addManifest("user", [c]));
      await ticks();
      expect(started).toEqual([c]);

      provide(c, tool("installed"));
      await ticks();
      expect(started.sort()).toEqual([a, b, c].sort());
      expect(await prioritized).toBe(true);
    } finally {
      watcher.dispose();
    }
  });

  it("doesn't load a held module that left the settings while it waited", async () => {
    const { watcher, started, provide, addManifest } = setup({
      system: [a, b, c],
    });
    void watcher.prioritize([{ [a]: [tool("frame")] }]);
    try {
      await ticks();
      // Its load waits on the held modules, so it can't be awaited here.
      void watcher.addUrl("system", addManifest("system-2", [a, b]));
      await ticks();
      provide(a, tool("frame"));
      await ticks();
      // Both loads looked `a` up, so it's imported twice.
      expect(new Set(started)).toEqual(new Set([a, b]));
    } finally {
      watcher.dispose();
    }
  });

  it("has nothing to hold back without a batch", async () => {
    const { watcher, started } = setup({ system: [a, b] });
    expect(await watcher.prioritize([{}])).toBe(false);
    try {
      await ticks();
      expect(started.sort()).toEqual([a, b].sort());
    } finally {
      watcher.dispose();
    }
  });
});

describe("ModuleWatcher package status", () => {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function setup(importPackage: () => Promise<any>) {
    const repo = new AutomergeRepo({ peerId: "status" as PeerId });
    const doc = repo.create<any>({ "@patchwork": { type: "folder" } });
    const settings = repo.create<any>({
      "@patchwork": { type: "patchwork:module-settings" },
      modules: [doc.url],
    });
    const tracker: PackageTracker = {
      findLatest: async (url) => url,
      watch: () => () => {},
    };
    const watcher = new ModuleWatcher(
      repo,
      { system: settings.url },
      () => {},
      undefined,
      importPackage,
      tracker
    );
    const events: string[] = [];
    watcher.addEventListener("status", () =>
      events.push(watcher.packageStatus(doc.url)?.state ?? "none")
    );
    await watcher.doneLoading;
    const done = async () => {
      watcher.dispose();
      await repo.shutdown().catch(() => {});
    };
    return { doc, settings, watcher, events, done };
  }

  it("says a package loaded, and which plugins it brought", async () => {
    const { doc, watcher, events, done } = await setup(async () => ({
      plugins: [{ type: "patchwork:tool", id: "demo" }],
    }));
    try {
      expect(watcher.packageStatus(doc.url)).toEqual({
        state: "loaded",
        plugins: ["demo"],
      });
      expect(watcher.packageStatus(doc.documentId)?.state).toBe("loaded");
      expect(events).toEqual(["loading", "loaded"]);
    } finally {
      await done();
    }
  });

  it("says a package failed, and why", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { doc, watcher, done } = await setup(async () => {
      throw new Error("kaboom");
    });
    try {
      expect(watcher.packageStatus(doc.url)).toEqual({
        state: "failed",
        error: "kaboom",
      });
    } finally {
      await done();
      errors.mockRestore();
    }
  });

  it("forgets a package that leaves the settings", async () => {
    const { doc, settings, watcher, events, done } = await setup(async () => ({
      plugins: [],
    }));
    try {
      settings.change((d: any) => {
        d.modules = [];
      });
      await pause(100);
      expect(watcher.packageStatus(doc.url)).toBeUndefined();
      expect(events.at(-1)).toBe("none");
    } finally {
      await done();
    }
  });

  it("knows nothing of a document that isn't a package", async () => {
    const { watcher, done } = await setup(async () => ({ plugins: [] }));
    try {
      expect(watcher.packageStatus(AUTOMERGE_URL)).toBeUndefined();
    } finally {
      await done();
    }
  });
});

describe("ModuleWatcher package database", () => {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // A package doc, listed in the settings, whose lookup answers `latest`.
  async function setup(importPackage: (url: string) => Promise<any>) {
    const repo = new AutomergeRepo({ peerId: "package-db" as PeerId });
    const doc = repo.create<any>({ "@patchwork": { type: "folder" } });
    const settings = repo.create<any>({
      "@patchwork": { type: "patchwork:module-settings" },
      modules: [doc.url],
    });
    const state = { latest: doc.view(doc.heads()).url };
    const tracker: PackageTracker = {
      findLatest: async () => state.latest,
      watch: () => () => {},
    };
    const database = new PackageDatabase();
    const announced = vi.spyOn(database, "announce");
    const events: string[] = [];
    const watcher = new ModuleWatcher(
      repo,
      { system: settings.url },
      (url, _mod, key) => {
        const entry = database.get(doc.url);
        events.push(`load ${url} ${entry?.version} ${key}`);
      },
      undefined,
      importPackage,
      tracker
    );
    watcher.database = database;
    await watcher.doneLoading;
    const done = async () => {
      watcher.dispose();
      await repo.shutdown().catch(() => {});
    };
    return { repo, doc, settings, state, watcher, database, announced, events, done };
  }

  const at = (url: string, packageJson: Record<string, unknown> = {}) => ({
    importUrl: url,
    base: "http://example.test/pkg/",
    packageJson,
    version: url.split("#")[1],
  });

  it("a loaded package is in the database before onLoad runs", async () => {
    const packageJson = {
      exports: { "./tool": "./tool.js" },
      patchwork: {
        plugins: {
          "patchwork:tool": { demo: { name: "Demo", export: "./tool" } },
        },
      },
    };
    const { doc, state, database, events, done } = await setup(async (url) => ({
      plugins: [{ type: "patchwork:tool", id: "demo", name: "Demo", load: async () => {} }],
      package: at(url, packageJson),
    }));
    try {
      const version = state.latest.split("#")[1];
      expect(events).toEqual([`load ${state.latest} ${version} ${doc.url}`]);
      const entry = database.get(doc.url)!;
      expect(entry).toMatchObject({
        key: doc.url,
        version,
        importUrl: state.latest,
        base: "http://example.test/pkg/",
        packageJson,
        addedBy: [{ by: "package-list", entry: doc.url }],
      });
      expect(entry.plugins).toEqual([
        { type: "patchwork:tool", id: "demo", name: "Demo", export: "./tool" },
      ]);
    } finally {
      await done();
    }
  });

  it("a new version replaces the entry and is announced", async () => {
    const { doc, state, watcher, database, announced, done } = await setup(
      async (url) => ({
        plugins: [{ type: "patchwork:tool", id: "demo", load: async () => {}, import: "x", module: {} }],
        package: at(url),
      })
    );
    try {
      expect(announced.mock.calls).toEqual([[doc.url]]);
      // Asked again with nothing new: no new version, nothing announced.
      watcher.recheck(doc.url);
      await pause(50);
      expect(announced).toHaveBeenCalledTimes(1);

      doc.change((d: any) => {
        d.rev = 1;
      });
      state.latest = doc.view(doc.heads()).url;
      watcher.recheck(doc.url);
      await pause(50);

      const entry = database.get(doc.url)!;
      expect(entry.version).toBe(state.latest.split("#")[1]);
      expect(entry.importUrl).toBe(state.latest);
      expect(entry.plugins).toEqual([{ type: "patchwork:tool", id: "demo" }]);
      expect(announced.mock.calls).toEqual([[doc.url], [doc.url]]);
    } finally {
      await done();
    }
  });

  it("a package leaving the settings is removed", async () => {
    const { doc, settings, database, done } = await setup(async (url) => ({
      plugins: [],
      package: at(url),
    }));
    try {
      expect(database.get(doc.url)).toBeDefined();
      settings.change((d: any) => {
        d.modules = [];
      });
      await pause(100);
      expect(database.get(doc.url)).toBeUndefined();
    } finally {
      await done();
    }
  });

  it("a saved package that left the list is removed once the lists are read", async () => {
    const { doc, database, watcher, done } = await setup(async (url) => ({
      plugins: [],
      package: at(url),
    }));
    let hydrate!: () => void;
    database.ready = new Promise<void>((resolve) => (hydrate = resolve));
    const saved = (key: string, ...addedBy: AddedBy[]) => {
      for (const by of addedBy) {
        database.add({ ...at(`${key}#v`), key, plugins: [], addedBy: by });
      }
    };
    try {
      const forgotten = watcher.forgetUnlisted();
      // Last visit's entries come in as the database hydrates.
      saved("automerge:gone", { by: "package-list", entry: "automerge:gone" });
      saved(
        "automerge:also-js",
        { by: "package-list", entry: "automerge:also-js" },
        { by: "js", url: "x", stack: "" }
      );
      saved("automerge:suggested", { by: "suggested" });
      hydrate();
      await forgotten;
      expect(database.all().map((entry) => entry.key).sort()).toEqual(
        ["automerge:also-js", "automerge:suggested", doc.url].sort()
      );
    } finally {
      await done();
    }
  });

  it("a site list that fails to read doesn't prune its saved packages", async () => {
    stubFetchManifest({});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const watcher = new ModuleWatcher(
      {} as unknown as Repo,
      { system: "http://example.test/modules.json" },
      () => {}
    );
    const database = new PackageDatabase();
    watcher.database = database;
    database.add({
      ...at("automerge:saved#v"),
      key: "automerge:saved",
      plugins: [],
      addedBy: { by: "package-list", entry: "automerge:saved" },
    });
    try {
      await watcher.doneLoading;
      await watcher.forgetUnlisted();
      expect(database.get("automerge:saved")).toBeDefined();
    } finally {
      warn.mockRestore();
      watcher.dispose();
    }
  });

  it("a module url isn't added", async () => {
    const manifestUrl = "http://example.test/modules.json";
    const moduleUrl = dataModule(
      "export const plugins = [{ type: 'patchwork:tool', id: 'demo' }]"
    );
    stubFetchManifest({ [manifestUrl]: { modules: [moduleUrl] } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loaded: string[] = [];
    const watcher = new ModuleWatcher(
      {} as unknown as Repo,
      { system: manifestUrl },
      (name) => loaded.push(name)
    );
    const database = new PackageDatabase();
    watcher.database = database;
    try {
      await watcher.doneLoading;
      expect(loaded).toEqual([moduleUrl]);
      expect(database.all()).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(moduleUrl);
    } finally {
      warn.mockRestore();
      watcher.dispose();
    }
  });
});
