import { useEffect, useState } from "react";
import {
  useDocument,
  useDocHandle,
} from "@automerge/automerge-repo-react-hooks";
import type {
  AutomergeUrl,
  Doc,
  DocHandle,
} from "@automerge/automerge-repo/slim";
import * as Providers from "@inkandswitch/patchwork-providers";
import type { JSONValue, Selector } from "@inkandswitch/patchwork-providers";
import {
  undoFor,
  watchUndo,
  type Undo,
  type UndoOptions,
  type UndoState,
  type UndoStatus,
  type UndoWatch,
} from "@inkandswitch/patchwork-undo";

/**
 * Generic reactive request hook. Resolves the first value a provider emits for
 * `selector` (via the one-shot `request` helper) and returns it once it
 * arrives (and whenever `element`/`selector` change). `T` is the response type.
 */
export function useRequest<T extends JSONValue>(
  element: HTMLElement,
  selector: Selector
): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  const key = JSON.stringify(selector);

  useEffect(() => {
    let canceled = false;
    Providers.request<T>(element, selector).then((v) => {
      if (canceled || v == null) return;
      setValue(() => v);
    });
    return () => {
      canceled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element, key]);

  return value;
}

/**
 * Generic reactive subscription hook. Opens a `patchwork:subscribe` for
 * `selector` and returns the latest value the provider pushes, re-rendering on
 * each emission. The subscription is torn down on unmount (or when
 * `element`/`selector` change). Pass `initialValue` to seed the state before
 * the first emission.
 */
export function useSubscribe<T extends JSONValue>(
  element: HTMLElement,
  selector: Selector,
  initialValue: T
): T;
export function useSubscribe<T extends JSONValue>(
  element: HTMLElement,
  selector: Selector,
  initialValue?: T
): T | undefined;
export function useSubscribe<T extends JSONValue>(
  element: HTMLElement,
  selector: Selector,
  initialValue?: T
): T | undefined {
  const [value, setValue] = useState<T | undefined>(initialValue);
  const key = JSON.stringify(selector);

  useEffect(() => {
    const unsubscribe = Providers.subscribe<T>(element, selector, (v) => {
      setValue(() => v);
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element, key]);

  return value;
}

/**
 * Handle-specialized subscription hook. Use when the answering provider emits
 * an `AutomergeUrl`. The handle is recovered locally from the global repo, so
 * it stays fully live. Returns `[doc, handle]` matching the shape of
 * `useDocument`; both read `undefined` until the first url arrives. `T` is the
 * doc shape inside the handle.
 */
export function useSubscribeDoc<T>(
  element: HTMLElement,
  selector: Selector
): [Doc<T> | undefined, DocHandle<T> | undefined] {
  const url = useSubscribe<AutomergeUrl>(element, selector);
  const [doc] = useDocument<T>(url);
  const handle = useDocHandle<T>(url);
  return [doc, handle];
}

/**
 * Undo and redo for a tool editing `handle`'s document, from the shared
 * history of the realm (see `undoFor` in `@inkandswitch/patchwork-undo`).
 * Binds the page-wide keys to `element` while it's mounted. Returns the
 * binding with its current `canUndo` / `canRedo`; `undefined` until both
 * `element` and `handle` are there.
 */
export function useUndo<T>(
  element: HTMLElement | null | undefined,
  handle: DocHandle<T> | undefined,
  options?: UndoOptions
): (UndoState & { binding: Undo }) | undefined {
  const [state, setState] = useState<
    (UndoState & { binding: Undo }) | undefined
  >(undefined);

  useEffect(() => {
    if (!element || !handle) return;
    const binding = undoFor(element, handle, options);
    const unsubscribe = binding.subscribe((s) => setState({ ...s, binding }));
    return () => {
      unsubscribe();
      binding.dispose();
      setState(undefined);
    };
    // Options are read once per binding, like the history they configure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element, handle]);

  return state;
}

/**
 * For host UI (an Edit menu, a toolbar button): the undo state of the
 * document at `url`, or of the one the user used last, and the commands to
 * send it, through the `patchwork:undo` provider.
 */
export function useUndoStatus(
  element: HTMLElement | null | undefined,
  url?: string
): UndoStatus & { undo(): void; redo(): void } {
  const [status, setStatus] = useState<UndoStatus>({
    url: url ?? null,
    canUndo: false,
    canRedo: false,
  });
  const [watch, setWatch] = useState<UndoWatch | undefined>(undefined);

  useEffect(() => {
    if (!element) return;
    const w = watchUndo(element, url, setStatus);
    setWatch(w);
    return () => {
      w.close();
      setWatch(undefined);
    };
  }, [element, url]);

  return {
    ...status,
    undo: () => watch?.undo(),
    redo: () => watch?.redo(),
  };
}
