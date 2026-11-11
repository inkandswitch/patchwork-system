// The live registry data layer.
//
// Unlike the module-settings-manager (which re-imports each module URL from the
// doc to discover its plugins), this tool reads the ACTUAL in-memory registries
// that the host has populated: `@inkandswitch/patchwork-plugins` keeps a single
// module-level map of registries, and because the importmap resolves this bare
// specifier to that same singleton, getAllRegistries() here IS the host's live
// state. We flatten every registry into a plain list and keep it live by
// subscribing to each registry's "changed" event.

import { createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import { getAllRegistries } from "@inkandswitch/patchwork-plugins";
import type { PluginRegistry } from "@inkandswitch/patchwork-plugins";
import { moduleKey } from "./origin.ts";

// A flattened view of one registered plugin, tagged with the registry it lives
// in. Registry entries are `PluginDescription & { [k]: any }`, so type-specific
// fields (supportedDatatypes, unlisted, …) come through untyped — we pluck the
// ones we display.
export interface RegistryEntry {
  /** The registry (== plugin type) this entry is registered under. */
  registry: string;
  id: string;
  type: string;
  name: string;
  icon?: string;
  importUrl?: string;
  supportedDatatypes?: string | string[];
  unlisted?: boolean;
}

// Minimal structural aliases for the tool contract — kept here so the entry
// module and mount.tsx don't need to import automerge/patchwork types (whose
// dts pull in packages we don't depend on).
export interface ToolHandle {
  /** This doc's automerge URL (the module-settings doc you're viewing). */
  url: string;
  doc(): { modules?: string[] } | undefined;
  /** Mutate the doc — used to uninstall a module from `modules[]`. */
  change(fn: (doc: { modules?: string[] }) => void): void;
  on(event: "change", cb: () => void): void;
  off(event: "change", cb: () => void): void;
}
export type ToolElement = HTMLElement;

function safeGetRegistries(): Map<string, PluginRegistry<any>> {
  try {
    return getAllRegistries();
  } catch {
    return new Map();
  }
}

/** Flatten every registry into one list. */
export function readRegistrySnapshot(): RegistryEntry[] {
  const out: RegistryEntry[] = [];
  for (const [registry, reg] of safeGetRegistries()) {
    let entries: any[];
    try {
      entries = reg.all();
    } catch {
      continue;
    }
    for (const p of entries as any[]) {
      if (!p || typeof p.id !== "string") continue;
      out.push({
        registry,
        id: p.id,
        type: typeof p.type === "string" ? p.type : registry,
        name: typeof p.name === "string" ? p.name : p.id,
        icon: p.icon,
        importUrl: typeof p.importUrl === "string" ? p.importUrl : undefined,
        supportedDatatypes: p.supportedDatatypes,
        unlisted: p.unlisted === true ? true : undefined,
      });
    }
  }
  return out;
}

// --- deactivation (pull a module's plugins out of the live registries) -------
//
// Removing a module from the settings doc only stops it loading NEXT time; the
// plugins it already registered linger in memory until reload. To make removal
// take effect now, we also pull them from the registries here.
//
// `registry.remove(id)` is in the types we build against, but the host's live
// @inkandswitch/patchwork-plugins may be older than that. We feature-detect it,
// so on an older host this is a no-op: the doc edit still lands and the plugin
// lingers until reload.
interface RemovableRegistry {
  remove?: (id: string) => boolean;
  all: () => any[];
}

/**
 * Remove every plugin registered from `importUrl` from all live registries,
 * matched by module identity (so a heads-pinned registry importUrl still matches
 * the doc's bare module URL).
 */
export function deactivateModule(importUrl: string | undefined): void {
  const key = moduleKey(importUrl);
  if (!key) return;
  for (const [, reg] of safeGetRegistries()) {
    const registry = reg as unknown as RemovableRegistry;
    if (typeof registry.remove !== "function") continue; // older host: no-op
    let entries: any[];
    try {
      // all() returns a fresh array, so removing during this loop is safe.
      entries = registry.all();
    } catch {
      continue;
    }
    for (const p of entries) {
      if (!p || typeof p.id !== "string") continue;
      if (moduleKey(p.importUrl) !== key) continue;
      registry.remove(p.id);
    }
  }
}

/**
 * A reactive snapshot of the live registries, driven purely by their "changed"
 * events — no polling. `readRegistrySnapshot()` already reads *every* registry
 * (subscribed or not), so a single event re-reads them all; each event also
 * re-scans for registries created since the last one and subscribes to them, so
 * new registry types are picked up as the system settles.
 */
export function useLiveRegistries(): { snapshot: Accessor<RegistryEntry[]> } {
  const [tick, setTick] = createSignal(0);

  // registry object -> its unsubscribe fn, so we subscribe each registry once.
  const subs = new Map<object, () => void>();

  const ensureSubscribed = (): void => {
    for (const [, reg] of safeGetRegistries()) {
      if (subs.has(reg)) continue;
      try {
        subs.set(reg, reg.on("changed", bump));
      } catch {
        // ignore a registry that won't let us subscribe
      }
    }
  };

  function bump(): void {
    // A change may have minted new registries — pick them up, then re-read.
    ensureSubscribed();
    setTick((t) => t + 1);
  }

  ensureSubscribed();

  onCleanup(() => {
    for (const off of subs.values()) {
      try {
        off();
      } catch {
        // ignore
      }
    }
    subs.clear();
  });

  const snapshot = createMemo(() => {
    tick();
    return readRegistrySnapshot();
  });

  return { snapshot };
}
