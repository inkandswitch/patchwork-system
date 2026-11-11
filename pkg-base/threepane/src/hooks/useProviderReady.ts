import {
  createEffect,
  createSignal,
  onCleanup,
  type Accessor,
} from "solid-js";

/**
 * Tracks whether a `<patchwork-view>` provider has dispatched its
 * `patchwork:mounted` event yet, so callers can gate consumers that fire
 * `patchwork:request` events on the host listener being attached.
 *
 * The caller owns the element binding (typically a signal). Pass an accessor
 * that returns the current element; the effect re-runs whenever that element
 * changes and rewires the listener.
 */
export const useProviderReady = (
  componentId: string,
  element: Accessor<HTMLElement | undefined>
): Accessor<boolean> => {
  const [isReady, setReady] = createSignal(false);

  createEffect(() => {
    const el = element();
    if (!el) return;
    setReady(false);
    const onMounted = (event: Event) => {
      const detail = (event as CustomEvent<{ componentId?: string }>).detail;
      if (detail?.componentId !== componentId) return;
      setReady(true);
    };
    el.addEventListener("patchwork:mounted", onMounted);
    onCleanup(() => el.removeEventListener("patchwork:mounted", onMounted));
  });

  return isReady;
};
