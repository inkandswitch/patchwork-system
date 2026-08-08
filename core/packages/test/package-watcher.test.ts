import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repo as AutomergeRepo, type PeerId } from "@automerge/automerge-repo";
import type { Repo } from "@automerge/automerge-repo/slim";
import { PackageWatcher } from "../src/package-watcher.js";
import type { PatchworkPackage } from "../src/types.js";

const ORIGIN = "http://patchwork.test";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const manifest = (id: string) => ({
  manifest: 1,
  name: id,
  plugins: [{ id, type: "patchwork:tool", import: "./dist/tool.js" }],
});

type Body = unknown | Error;

function stubFetch(handler: (url: string) => Body) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = String(input);
      calls.push(url);
      const body = handler(url);
      if (body instanceof Error) throw body;
      if (body === undefined) return { ok: false, status: 404 } as Response;
      return { ok: true, status: 200, json: async () => body } as Response;
    })
  );
  return calls;
}

function manifestFor(url: string): string | undefined {
  const match = url.match(/^.*\/([^/]+)\/patchwork\.json$/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

beforeEach(() => {
  vi.stubGlobal("location", { origin: ORIGIN, href: `${ORIGIN}/` });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PackageWatcher static sources", () => {
  it("announces the contents of every listed package's manifest", async () => {
    stubFetch((url) => {
      if (url === "http://example.test/packages.json") {
        return { modules: ["./chat", "https://cdn.test/notes"] };
      }
      if (url === "http://example.test/chat/patchwork.json") {
        return manifest("chat");
      }
      if (url === "https://cdn.test/notes/patchwork.json") {
        return manifest("notes");
      }
      return undefined;
    });

    const announced: PatchworkPackage[] = [];
    const watcher = new PackageWatcher({} as unknown as Repo, {
      sources: { system: "http://example.test/packages.json" },
      onPackage: (pkg) => announced.push(pkg),
    });
    await watcher.doneLoading;

    expect(announced.map((p) => p.url).sort()).toEqual([
      "http://example.test/chat",
      "https://cdn.test/notes",
    ]);
    const chat = announced.find((p) => p.name === "chat")!;
    expect(chat.plugins).toEqual([
      {
        id: "chat",
        type: "patchwork:tool",
        import: "http://example.test/chat/dist/tool.js",
      },
    ]);
    expect(chat.permissions).toEqual([]);
  });

  it("imports nothing", async () => {
    const calls = stubFetch((url) =>
      url === "http://example.test/packages.json"
        ? { modules: ["https://cdn.test/notes"] }
        : url === "https://cdn.test/notes/patchwork.json"
          ? manifest("notes")
          : undefined
    );

    const watcher = new PackageWatcher({} as unknown as Repo, {
      sources: { system: "http://example.test/packages.json" },
      onPackage: () => {},
    });
    await watcher.doneLoading;

    expect(calls).not.toContain("https://cdn.test/notes/dist/tool.js");
  });

  it("takes packages from a `packages` map as well as a `modules` array", async () => {
    stubFetch((url) => {
      if (url === "http://example.test/packages.json") {
        return {
          modules: ["https://cdn.test/notes"],
          packages: { chat: "./chat", notes: "https://cdn.test/notes" },
        };
      }
      if (url === "http://example.test/chat/patchwork.json") {
        return manifest("chat");
      }
      if (url === "https://cdn.test/notes/patchwork.json") {
        return manifest("notes");
      }
      return undefined;
    });

    const announced: PatchworkPackage[] = [];
    const watcher = new PackageWatcher({} as unknown as Repo, {
      sources: { system: "http://example.test/packages.json" },
      onPackage: (pkg) => announced.push(pkg),
    });
    await watcher.doneLoading;

    expect(announced.map((p) => p.url).sort()).toEqual([
      "http://example.test/chat",
      "https://cdn.test/notes",
    ]);
  });

  it("skips a package with no patchwork.json", async () => {
    stubFetch((url) =>
      url === "http://example.test/packages.json"
        ? { modules: ["https://cdn.test/legacy"] }
        : undefined
    );

    const announced: PatchworkPackage[] = [];
    const watcher = new PackageWatcher({} as unknown as Repo, {
      sources: { system: "http://example.test/packages.json" },
      onPackage: (pkg) => announced.push(pkg),
    });
    await watcher.doneLoading;

    expect(announced).toEqual([]);
  });
});

describe("PackageWatcher legacy packages", () => {
  it("hands a package with no patchwork.json to the adapter", async () => {
    stubFetch((url) =>
      url === "http://example.test/packages.json"
        ? { packages: { legacy: "https://cdn.test/legacy" } }
        : undefined
    );

    const seen: string[] = [];
    const announced: PatchworkPackage[] = [];
    const watcher = new PackageWatcher({} as unknown as Repo, {
      sources: { system: "http://example.test/packages.json" },
      onPackage: (pkg) => announced.push(pkg),
      readLegacyPackage: async (url) => {
        seen.push(url);
        return {
          url,
          base: `${url}/`,
          permissions: [],
          legacy: true,
          plugins: [
            { id: "old", type: "patchwork:tool", import: "blob:test/0" },
          ],
        };
      },
    });
    await watcher.doneLoading;

    expect(seen).toEqual(["https://cdn.test/legacy"]);
    expect(announced).toHaveLength(1);
    expect(announced[0].legacy).toBe(true);
    expect(announced[0].plugins[0].id).toBe("old");
  });

  it("does not consult the adapter when there is a manifest", async () => {
    stubFetch((url) =>
      url === "http://example.test/packages.json"
        ? { modules: ["https://cdn.test/chat"] }
        : url === "https://cdn.test/chat/patchwork.json"
          ? manifest("chat")
          : undefined
    );

    const readLegacyPackage = vi.fn(async () => undefined);
    const watcher = new PackageWatcher({} as unknown as Repo, {
      sources: { system: "http://example.test/packages.json" },
      onPackage: () => {},
      readLegacyPackage,
    });
    await watcher.doneLoading;

    expect(readLegacyPackage).not.toHaveBeenCalled();
  });
});

describe("PackageWatcher automerge sources", () => {
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
    return { folder, settings };
  }

  it("announces at pinned heads and re-announces when the folder doc changes", async () => {
    const repo = new AutomergeRepo({ peerId: "packages-reload" as PeerId });
    try {
      const { folder, settings } = makeFixture(repo);
      stubFetch((url) => (manifestFor(url) ? manifest("chat") : undefined));

      const announced: PatchworkPackage[] = [];
      const watcher = new PackageWatcher(repo as unknown as Repo, {
        sources: { system: settings.url },
        onPackage: (pkg) => announced.push(pkg),
      });
      await watcher.doneLoading;

      expect(announced).toHaveLength(1);
      expect(announced[0].url).toBe(folder.url);
      expect(announced[0].base).toContain("%23");

      folder.change((d: any) => {
        d.rev = 1;
      });
      await pause(500);

      expect(announced).toHaveLength(2);
      expect(announced[1].base).not.toBe(announced[0].base);
      expect(announced[1].url).toBe(folder.url);
    } finally {
      await repo.shutdown().catch(() => {});
    }
  });

  it("removes a package dropped from the settings doc and stops watching it", async () => {
    const repo = new AutomergeRepo({ peerId: "packages-unload" as PeerId });
    try {
      const { folder, settings } = makeFixture(repo);
      stubFetch((url) => (manifestFor(url) ? manifest("chat") : undefined));

      const announced: PatchworkPackage[] = [];
      const removed: string[] = [];
      const watcher = new PackageWatcher(repo as unknown as Repo, {
        sources: { system: settings.url },
        onPackage: (pkg) => announced.push(pkg),
        onRemove: (url) => removed.push(url),
      });
      await watcher.doneLoading;
      expect(announced).toHaveLength(1);

      settings.change((d: any) => {
        d.modules = [];
      });
      await pause(100);
      expect(removed).toEqual([folder.url]);

      folder.change((d: any) => {
        d.rev = 1;
      });
      await pause(500);
      expect(announced).toHaveLength(1);
    } finally {
      await repo.shutdown().catch(() => {});
    }
  });

  it("retries a failed manifest fetch", async () => {
    const repo = new AutomergeRepo({ peerId: "packages-retry" as PeerId });
    try {
      const { settings } = makeFixture(repo);
      let failing = true;
      stubFetch((url) => {
        if (!manifestFor(url)) return undefined;
        if (failing) return new TypeError("Failed to fetch");
        return manifest("chat");
      });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      const announced: PatchworkPackage[] = [];
      const watcher = new PackageWatcher(repo as unknown as Repo, {
        sources: { system: settings.url },
        onPackage: (pkg) => announced.push(pkg),
      });
      await watcher.doneLoading;
      expect(announced).toHaveLength(0);

      failing = false;
      await pause(1_500);
      expect(announced).toHaveLength(1);
      errors.mockRestore();
    } finally {
      await repo.shutdown().catch(() => {});
    }
  });

  it("dispose() detaches settings and folder-doc listeners", async () => {
    const repo = new AutomergeRepo({ peerId: "packages-dispose" as PeerId });
    try {
      const { folder, settings } = makeFixture(repo);
      const other = repo.create<any>();
      other.change((d: any) => {
        d["@patchwork"] = { type: "folder" };
      });
      stubFetch((url) => (manifestFor(url) ? manifest("chat") : undefined));

      const announced: PatchworkPackage[] = [];
      const watcher = new PackageWatcher(repo as unknown as Repo, {
        sources: { system: settings.url },
        onPackage: (pkg) => announced.push(pkg),
      });
      await watcher.doneLoading;
      expect(announced).toHaveLength(1);

      watcher.dispose();
      folder.change((d: any) => {
        d.rev = 1;
      });
      settings.change((d: any) => {
        d.modules = [folder.url, other.url];
      });
      await pause(500);
      expect(announced).toHaveLength(1);
    } finally {
      await repo.shutdown().catch(() => {});
    }
  });
});
