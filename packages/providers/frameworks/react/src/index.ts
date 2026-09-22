import { useEffect, useState } from "react";
import { useDocument, useDocHandle } from "@automerge/automerge-repo-react-hooks";
import type {
  AutomergeUrl,
  Doc,
  DocHandle,
} from "@automerge/automerge-repo/slim";
import * as Providers from "@inkandswitch/patchwork-providers";
import type { JSONValue, Selector } from "@inkandswitch/patchwork-providers";

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
