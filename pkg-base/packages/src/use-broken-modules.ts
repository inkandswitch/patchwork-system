// Broken modules: URLs in your package list that no registered plugin came
// from. We import each one (automerge through the worker, http directly) to
// find out why, and fetch its package.json so the failure box can say what the
// package is even though it didn't load.

import { createEffect, createMemo, createSignal, type Accessor } from "solid-js";
import { bareModuleUrl, moduleKey } from "./origin.ts";
import { discoverPackagePlugins } from "./discover-plugins.ts";
import { resolvePackageInfo, type PkgInfo } from "./pkg-meta.ts";
import type { RegistryEntry } from "./registry.ts";

interface Probe {
  status: "loading" | "error" | "ok";
  error?: string;
}

export interface BrokenModule {
  url: string;
  error: string;
}

export function useBrokenModules(
  modules: Accessor<string[] | undefined>,
  snapshot: Accessor<RegistryEntry[]>
) {
  const pluginImportKeys = createMemo(() => {
    const keys = new Set<string>();
    for (const e of snapshot()) {
      const k = moduleKey(e.importUrl);
      if (k) keys.add(k);
    }
    return keys;
  });
  const orphanModules = createMemo(() => {
    const registered = pluginImportKeys();
    return (modules() ?? []).filter((m) => {
      const k = moduleKey(m);
      return !!k && !registered.has(k);
    });
  });

  const [probes, setProbes] = createSignal<Record<string, Probe>>({});
  const probed = new Set<string>();
  createEffect(() => {
    for (const url of orphanModules()) {
      const key = moduleKey(url);
      if (!key || probed.has(key)) continue;
      probed.add(key);
      setProbes((p) => ({ ...p, [key]: { status: "loading" } }));
      // Automerge orphans probe via the worker; http(s) orphans via a direct
      // import (the worker only handles automerge, and would fail misleadingly).
      void discoverPackagePlugins(bareModuleUrl(url)).then(
        () => setProbes((p) => ({ ...p, [key]: { status: "ok" } })),
        (e) =>
          setProbes((p) => ({
            ...p,
            // discoverPlugins rejects with the worker's stack as the message.
            [key]: {
              status: "error",
              error: e instanceof Error ? e.message : String(e),
            },
          }))
      );
    }
  });

  // Only the ones that actually failed to import — still-loading and
  // import-fine-but-registered-nothing modules aren't shown as broken.
  const brokenModules = createMemo<BrokenModule[]>(() =>
    orphanModules()
      .map((url) => ({ url, probe: probes()[moduleKey(url)!] }))
      .filter((b) => b.probe?.status === "error")
      .map((b) => ({ url: b.url, error: b.probe!.error ?? "Unknown error" }))
  );

  // package.json info for broken modules — even though the module failed to
  // *import*, its package.json usually still fetches, so a failed box can show
  // the package name/version and its declared plugins alongside the stack.
  const [brokenInfo, setBrokenInfo] = createSignal<Record<string, PkgInfo>>({});
  const brokenRequested = new Set<string>();
  createEffect(() => {
    for (const { url } of brokenModules()) {
      const key = moduleKey(url);
      if (!key || brokenRequested.has(key)) continue;
      brokenRequested.add(key);
      void resolvePackageInfo(bareModuleUrl(url)).then((info) =>
        setBrokenInfo((prev) => ({ ...prev, [key]: info }))
      );
    }
  });

  const infoFor = (url: string): PkgInfo | undefined =>
    brokenInfo()[moduleKey(url)!];

  return { brokenModules, infoFor };
}
