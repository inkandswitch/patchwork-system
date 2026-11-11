// The host's ModuleWatcher (window.patchwork.packages) is the authority on every
// module-settings source that's live in this session — keyed by name (`system`,
// `system-1`, …, `user`). Each source is either an automerge module-settings doc
// (a live `handles[name]`) or a fetched static JSON manifest
// (`staticManifests[name]`); both expose the same `{ modules: string[] }` shape.
//
// This is the same host-singleton reach as registry.ts's getAllRegistries(): a
// dev/visualizer tool reading the running state, guarded so a missing global
// (isolated realm, tests) degrades to "no system sources" rather than throwing.

import { moduleKey, moduleKeySet } from "./origin.ts";

interface ModuleSettingsLike {
  modules?: string[];
}
interface HandleLike {
  doc?: () => ModuleSettingsLike | undefined;
}
interface ModuleWatcherLike {
  urls?: Record<string, string>;
  handles?: Record<string, HandleLike>;
  staticManifests?: Record<string, ModuleSettingsLike>;
}

function moduleWatcher(): ModuleWatcherLike | undefined {
  try {
    return (globalThis as { window?: { patchwork?: { packages?: ModuleWatcherLike } } })
      .window?.patchwork?.packages;
  } catch {
    return undefined;
  }
}

export interface SettingsSource {
  /** The ModuleWatcher key (`system`, `user`, …). */
  name: string;
  /** The settings-doc/manifest URL for this source. */
  url: string;
  /** moduleKey(url) — its documentId, so it can be matched against a handle url. */
  key: string;
  /** The keys of every module this source lists. */
  moduleKeys: Set<string>;
}

/** Snapshot every module-settings source the host is currently watching. */
export function readSettingsSources(): SettingsSource[] {
  const mw = moduleWatcher();
  if (!mw) return [];
  const urls = mw.urls ?? {};
  const out: SettingsSource[] = [];
  for (const name of Object.keys(urls)) {
    const url = urls[name];
    if (typeof url !== "string") continue;
    let modules: string[] | undefined;
    const handle = mw.handles?.[name];
    if (handle?.doc) {
      try {
        modules = handle.doc()?.modules;
      } catch {
        // a not-yet-ready handle; fall through to the manifest
      }
    }
    if (!modules) modules = mw.staticManifests?.[name]?.modules;
    out.push({
      name,
      url,
      key: moduleKey(url) ?? url,
      moduleKeys: moduleKeySet(modules),
    });
  }
  return out;
}

/**
 * The union of every module key from settings sources OTHER than the doc you're
 * viewing — i.e. the system/default bundle(s). Excluding the viewed doc by its
 * key keeps "installed" (your doc) and "core" (the system doc) disjoint.
 */
export function systemModuleKeys(
  sources: SettingsSource[],
  viewedKey: string | undefined
): Set<string> {
  const keys = new Set<string>();
  for (const source of sources) {
    if (viewedKey && source.key === viewedKey) continue;
    for (const key of source.moduleKeys) keys.add(key);
  }
  return keys;
}
