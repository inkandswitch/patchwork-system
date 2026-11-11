// The registry stores a bare importUrl (no heads), so to show "the heads this
// module is at" we ask the live repo for each automerge doc's current heads and
// track them reactively — the same window-singleton reach as registry.ts.

import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import { bareModuleUrl, documentIdOf, isAutomergeUrl } from "./origin.ts";

interface DocHandleLike {
  heads(): string[];
  on(event: "change", cb: () => void): void;
  off(event: "change", cb: () => void): void;
}
interface RepoLike {
  find(url: string): Promise<DocHandleLike>;
}

function repo(): RepoLike | undefined {
  try {
    return (globalThis as { window?: { repo?: RepoLike } }).window?.repo;
  } catch {
    return undefined;
  }
}

/**
 * Reactively track the current heads of every automerge importUrl in `urls`,
 * keyed by documentId. Each doc is looked up once and then followed for changes;
 * a missing repo (isolated realm, tests) just yields an empty map.
 */
export function useDocHeadsMap(
  urls: Accessor<(string | undefined)[]>
): Accessor<Record<string, string[]>> {
  const [map, setMap] = createSignal<Record<string, string[]>>({});
  const subs = new Map<string, () => void>();

  createEffect(() => {
    const r = repo();
    if (!r) return;
    for (const url of urls()) {
      if (!isAutomergeUrl(url)) continue;
      const id = documentIdOf(url);
      if (!id || subs.has(id)) continue;
      subs.set(id, () => {}); // reserve, so each doc is looked up at most once
      void r
        .find(bareModuleUrl(url))
        .then((handle) => {
          const update = () =>
            setMap((prev) => ({ ...prev, [id]: [...handle.heads()] }));
          update();
          handle.on("change", update);
          subs.set(id, () => handle.off("change", update));
        })
        .catch(() => {
          subs.delete(id); // let a later pass retry a doc that wasn't found yet
        });
    }
  });

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

  return map;
}
