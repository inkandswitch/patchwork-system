import type { DocHandle } from "@automerge/automerge-repo/slim";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
} from "solid-js";

/**
 * The current doc of a handle, recomputed on every change. Reads through a
 * version counter instead of useDocument, because its store proxying conflicts
 * with Automerge array splices.
 */
export function useHandleDoc<T>(
  handle: Accessor<DocHandle<T> | undefined>
): Accessor<T | undefined> {
  const [version, setVersion] = createSignal(0);
  createEffect(() => {
    const h = handle();
    if (!h) return;
    const onChange = () => setVersion((v) => v + 1);
    h.on("change", onChange);
    onCleanup(() => h.off("change", onChange));
  });
  return createMemo(() => {
    version();
    return handle()?.doc();
  });
}
