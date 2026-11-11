// Everything the views read, gathered in one place: the settings doc you're
// viewing, the live registries, the host's other settings sources, each
// module's current heads, and package.json metadata per importUrl. The result
// is `enriched`: every registered plugin tagged with where it came from.

import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { useLiveRegistries, type ToolHandle } from "./registry.ts";
import {
  classifyOrigin,
  documentIdOf,
  headsOf,
  moduleKey,
  moduleKeySet,
} from "./origin.ts";
import { readSettingsSources, systemModuleKeys } from "./settings-sources.ts";
import { useDocHeadsMap } from "./doc-heads.ts";
import {
  packageDisplayName,
  resolvePackageMeta,
  type PkgMeta,
} from "./pkg-meta.ts";
import type { Enriched } from "./model.ts";

export function usePackageData(handle: ToolHandle) {
  // --- the settings doc you're viewing (drives installed / core / ephemeral) -
  const [doc, setDoc] = createSignal(handle.doc());
  const onChange = () => setDoc(handle.doc());
  handle.on("change", onChange);
  onCleanup(() => handle.off("change", onChange));
  // Modules listed in the doc you're looking at → "installed".
  const installedKeys = createMemo(() => moduleKeySet(doc()?.modules));

  // --- the live registries ---------------------------------------------------
  const { snapshot } = useLiveRegistries();

  // Modules from the system/default settings doc(s) → "core"; an automerge
  // module in neither doc → "ephemeral". Re-read as plugins/manifests load.
  const viewedKey = moduleKey(handle.url);
  const settingsSources = createMemo(() => {
    snapshot();
    return readSettingsSources();
  });
  const systemKeys = createMemo(() =>
    systemModuleKeys(settingsSources(), viewedKey)
  );
  const systemPackageListUrl = createMemo(
    () => settingsSources().find((source) => source.name === "system")?.url
  );
  const isCustomSystemPackageList = createMemo(
    () =>
      systemPackageListUrl() !== undefined &&
      systemPackageListUrl() !== "/modules.json"
  );
  const isWatchedPackageList = createMemo(
    () =>
      !!viewedKey && settingsSources().some((source) => source.key === viewedKey)
  );

  // Current heads per automerge module, looked up live from the repo — the
  // registry only stores a bare importUrl.
  const headsByDoc = useDocHeadsMap(() => snapshot().map((e) => e.importUrl));
  const headsFor = (importUrl: string | undefined): string[] => {
    if (!importUrl) return [];
    const embedded = headsOf(importUrl);
    if (embedded.length) return embedded;
    const id = documentIdOf(importUrl);
    return (id && headsByDoc()[id]) || [];
  };

  // --- package.json metadata, resolved lazily per importUrl ------------------
  const [pkgMetas, setPkgMetas] = createSignal<Record<string, PkgMeta>>({});
  const requested = new Set<string>();
  createEffect(() => {
    for (const entry of snapshot()) {
      const url = entry.importUrl;
      if (!url || requested.has(url)) continue;
      requested.add(url);
      void resolvePackageMeta(url).then((meta) =>
        setPkgMetas((prev) => ({ ...prev, [url]: meta }))
      );
    }
  });

  const enriched = createMemo<Enriched[]>(() => {
    const installed = installedKeys();
    const system = systemKeys();
    const metas = pkgMetas();
    return snapshot().map((entry) => {
      const meta = entry.importUrl ? metas[entry.importUrl] : undefined;
      return {
        ...entry,
        origin: classifyOrigin(entry.importUrl, installed, system),
        pkgMeta: meta,
        pkgName: packageDisplayName(entry.importUrl, meta),
      };
    });
  });

  return {
    doc,
    installedKeys,
    snapshot,
    enriched,
    headsFor,
    systemPackageListUrl,
    isCustomSystemPackageList,
    isWatchedPackageList,
  };
}
