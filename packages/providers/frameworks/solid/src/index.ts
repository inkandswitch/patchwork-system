import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
} from "solid-js";
import { createStore, reconcile, type Store } from "solid-js/store";
import type { AutomergeUrl, Doc, DocHandle } from "@automerge/automerge-repo";
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
 * Generic reactive request. Resolves the first value a provider emits for
 * `selector` (via the one-shot `request` helper) and returns an accessor that
 * reads `undefined` until then. `T` is the response type.
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
 * Generic reactive subscription. Opens a `patchwork:subscribe` for `selector`
 * on mount and returns an accessor that updates as the provider pushes new
 * values. The subscription is torn down on cleanup.
 *
 * Pass `initialValue` to seed the accessor so it reads that value (rather than
 * `undefined`) until the first emission. If no provider answers, the accessor
 * simply stays at the initial value.
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
 * Store-backed subscription. Use this when a consumer wants Solid's
 * fine-grained nested reactivity for incoming JSON object or array snapshots.
 * Requires an initial object/array so the store has a stable root.
 *
 * `reconcile` preserves stable object/array identity where possible, so this
 * helper is not a good fit when the top-level value is used as an identity key
 * for resources or memos.
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
 * Handle-specialized subscription. Use when the answering provider emits an
 * `AutomergeUrl`. The handle is recovered locally from the global repo
 * (`window.repo`), so it stays fully live — reads project reactively and writes go
 * straight back to the same repo. Returns `[doc, handle]` matching the shape
 * of `solid-automerge`'s `useDocument`; both read `undefined` until the first
 * url arrives. `T` is the doc shape inside the handle.
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

  // Mirror the doc into a store by `reconcile`-ing against the *materialized*
  // snapshot (`handle.doc()`) on every change, rather than replaying the
  // change's incremental patches (as `solid-automerge`'s `createDocumentProjection`
  // / `autoproduce` does).
  //
  // A whole-value write such as `doc.list = [...]` is lowered by Automerge to
  // `putObjectFromHydrate`, whose patch stream is a `put` that materializes the
  // new container *plus* per-element `insert` patches. Replaying that delta with
  // `applyPatches` double-applies the contents — the `put` seeds `[a, b]`, then
  // the inserts splice `a, b` in again, yielding `[a, b, a, b]` — even though the
  // document itself is correct. The materialized snapshot is always
  // authoritative, so reconciling against it is robust to any valid change,
  // whole-array reassignment included.
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
