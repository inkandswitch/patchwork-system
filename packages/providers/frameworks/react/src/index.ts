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
 * The first value a provider sends for `selector`, asked again whenever
 * `element` or `selector` changes.
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
 * The latest value a provider sends for `selector`, re-rendering on each one.
 * Unsubscribes on unmount, or when `element` or `selector` changes.
 * `initialValue` seeds it before the first.
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
 * A subscription whose provider sends an `AutomergeUrl`, found in the repo
 * from React's `RepoContext`, so it's fully live. Returns `[doc, handle]`,
 * like `useDocument`; both are `undefined` until the first url.
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
