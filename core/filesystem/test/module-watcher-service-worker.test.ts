import { afterEach, describe, expect, it, vi } from "vitest";
import { Repo as AutomergeRepo } from "@automerge/automerge-repo";
import { ModuleWatcher } from "../src/module-watcher.js";
import type { PackageTracker } from "../src/package-tracker.js";

// The importer is stubbed: a service-worker url can't be imported in node.
const importedFromHttp: string[] = [];
vi.mock("../src/packages.js", async (original) => ({
  ...(await original<typeof import("../src/packages.js")>()),
  importPackageFromHttpUrl: async (url: string) => {
    importedFromHttp.push(url);
    return { plugins: [] };
  },
}));

afterEach(() => {
  importedFromHttp.length = 0;
});

describe("ModuleWatcher with a service worker module url", () => {
  it("reloads the same path the first load imported, at the new heads", async () => {
    const repo = new AutomergeRepo();
    try {
      const folder = await repo.create<any>({
        "@patchwork": { type: "folder" },
      });
      const encodedDoc = encodeURIComponent(folder.url);
      const entry = `http://localhost/${encodedDoc}/dist/entry.js`;
      const settings = await repo.create<any>({
        "@patchwork": { type: "patchwork:module-settings" },
        modules: [entry],
      });
      let latest = folder.view(folder.heads()).url;
      const watching = new Map<string, () => void>();
      const tracker: PackageTracker = {
        findLatest: async () => latest,
        watch(url, onChange) {
          watching.set(url, onChange);
          return () => watching.delete(url);
        },
      };
      const watcher = new ModuleWatcher(
        repo,
        { system: settings.url },
        () => {},
        undefined,
        undefined,
        tracker
      );
      await watcher.doneLoading;
      expect(importedFromHttp).toEqual([entry]);

      await folder.change((d: any) => {
        d.rev = 1;
      });
      latest = folder.view(folder.heads()).url;
      watching.get(folder.url)!();
      await new Promise((r) => setTimeout(r, 500));

      expect(importedFromHttp).toEqual([
        entry,
        `http://localhost/${encodeURIComponent(latest)}/dist/entry.js`,
      ]);
      watcher.dispose();
    } finally {
      await repo.shutdown().catch(() => {});
    }
  });
});
