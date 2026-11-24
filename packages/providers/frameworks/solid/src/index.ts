import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
} from "solid-js";
import { createStore, reconcile, type Store } from "solid-js/store";
import type {
  AutomergeUrl,
  Doc,
  DocHandle,
} from "@automerge/automerge-repo/slim";
import * as Providers from "@inkandswitch/patchwork-providers";
import type {
  JSONArray,
  JSONObject,
  JSONValue,
  Selector,
} from "@inkandswitch/patchwork-providers";

export type ElementSource = HTMLElement | (() => HTMLElement | undefined);

function resolveElement(source: ElementSource): HTMLElement | undefined {
  return typeof source === "function" ? source() : source;
}

/**
 * The first value a provider sends for `selector`, as an accessor that reads
 * `undefined` until it arrives.
 */
export function request<T extends JSONValue>(
  element: ElementSource,
  selector: Selector
): Accessor<T | undefined> {
  const [value, setValue] = createSignal<T | undefined>(undefined);
  onMount(() => {
    const target = resolveElement(element);
    if (!target) return;
    Providers.request<T>(target, selector).then((v) => {
      if (v == null) return;
      setValue(() => v);
    });
  });
  return value;
}

/**
 * A `patchwork:subscribe` for `selector`, opened on mount and closed on
 * cleanup, as an accessor holding the latest value. It reads `initialValue`
 * (or `undefined`) until the first one, and for good if no provider answers.
 */
export function subscribe<T extends JSONValue>(
  element: ElementSource,
  selector: Selector,
  initialValue: T
): Accessor<T>;
export function subscribe<T extends JSONValue>(
  element: ElementSource,
  selector: Selector,
  initialValue?: T
): Accessor<T | undefined>;
export function subscribe<T extends JSONValue>(
  element: ElementSource,
  selector: Selector,
  initialValue?: T
): Accessor<T | undefined> {
  const [value, setValue] = createSignal<T | undefined>(initialValue);
  onMount(() => {
    const target = resolveElement(element);
    if (!target) return;
    const unsubscribe = Providers.subscribe<T>(target, selector, setValue);
    onCleanup(unsubscribe);
  });
  return value;
}

/**
 * A subscription into a store, for Solid's fine-grained reactivity over JSON
 * object or array snapshots. Needs an initial object or array as the store's
 * root. `reconcile` keeps object identity where it can, so don't use the
 * top-level value as an identity key for resources or memos.
 */
export function subscribeReconciled<T extends JSONArray | JSONObject>(
  element: ElementSource,
  selector: Selector,
  initialValue: T
): Store<T> {
  const [store, setStore] = createStore<T>(initialValue);
  onMount(() => {
    const target = resolveElement(element);
    if (!target) return;
    const unsubscribe = Providers.subscribe<T>(target, selector, (v) => {
      setStore(reconcile(v));
    });
    onCleanup(unsubscribe);
  });
  return store;
}

/**
 * A subscription whose provider sends an `AutomergeUrl`. The handle is found
 * in the global repo (`window.repo`), so it's fully live: reads are reactive
 * and writes go straight back. Returns `[doc, handle]`, like
 * `solid-automerge`'s `useDocument`; both read `undefined` until the first url.
 */
export function subscribeDoc<T extends object>(
  element: ElementSource,
  selector: Selector
): [Accessor<Doc<T> | undefined>, Accessor<DocHandle<T> | undefined>] {
  const [handle, setHandle] = createSignal<DocHandle<T> | undefined>(undefined);
  onMount(() => {
    const target = resolveElement(element);
    if (!target) return;
    let canceled = false;
    const unsubscribe = Providers.subscribe<AutomergeUrl>(
      target,
      selector,
      (url) => {
        if (!url) return;
        const repo = "repo" in window ? window.repo : undefined;
        if (!repo) return;
        void Promise.resolve(repo.find<T>(url)).then((h) => {
          if (canceled) return;
          setHandle(() => h);
        });
      }
    );
    onCleanup(() => {
      canceled = true;
      unsubscribe();
    });
  });

  // Reconciled against `handle.doc()` on every change, not by replaying
  // patches (as solid-automerge's `autoproduce` does): Automerge lowers a
  // whole-value write like `doc.list = [...]` to a `put` of the new list plus
  // an `insert` per element, and replaying both gives `[a, b, a, b]`.
  const [store, setStore] = createStore<T>({} as T);
  const [ready, setReady] = createSignal(false);
  createEffect(() => {
    const h = handle();
    if (!h) {
      setReady(false);
      return;
    }
    const sync = () => {
      setStore(reconcile((h.doc() ?? {}) as T));
      setReady(true);
    };
    sync();
    h.on("change", sync);
    onCleanup(() => h.off("change", sync));
  });

  const doc = () => (ready() ? (store as Doc<T>) : undefined);
  return [doc, handle];
}
