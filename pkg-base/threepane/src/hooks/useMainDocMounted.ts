import {
  createEffect,
  createSignal,
  onCleanup,
  type Accessor,
} from "solid-js";

// Safety net for the "failed to mount" case: a tool whose module throws sets
// the view's internal state to "error" without dispatching any settling event,
// so without this the sidebar would suspend forever. Long enough that a slow
// (but healthy) load still wins the race and settles via its real event.
const MOUNT_TIMEOUT_MS = 5000;

/**
 * Tracks whether the main document `<patchwork-view>` has settled *at least
 * once* — either it dispatched `patchwork:mounted` (a tool rendered) or
 * `patchwork:no-tool` (no tool could be resolved). Used to defer the sidebar
 * widgets until the main column has loaded, so the primary document wins the
 * initial render race.
 *
 * The result LATCHES: once true it stays true. We only want to win the *first*
 * render race — re-suspending on every later doc switch would tear down and
 * rebuild the widgets each time. So once settled we stop listening and never go
 * back to false.
 *
 * Both events bubble, so we listen on a stable container that wraps the view.
 * Events are filtered by url so a sidebar widget mounting inside the same
 * container can't settle us early.
 *
 * A timeout backs the explicit "failed to mount" case (see MOUNT_TIMEOUT_MS):
 * the view's error path emits no event, so without a fallback the widgets would
 * never appear.
 */
export const useMainDocMounted = (
  element: Accessor<HTMLElement | undefined>,
  docUrl: Accessor<string | undefined>
): Accessor<boolean> => {
  const [isMounted, setMounted] = createSignal(false);

  createEffect(() => {
    // Latched: stop watching (and stop re-arming the timeout) once settled.
    if (isMounted()) return;
    const el = element();
    const url = docUrl();
    if (!el || !url) return;

    const onSettled = (event: Event) => {
      const detail = (event as CustomEvent<{ url?: string }>).detail;
      // `patchwork:mounted` for a doc view carries the url; ignore events for
      // other documents that happen to bubble through this container.
      if (detail?.url && detail.url !== url) return;
      setMounted(true);
    };

    el.addEventListener("patchwork:mounted", onSettled);
    el.addEventListener("patchwork:no-tool", onSettled);
    const timer = setTimeout(() => setMounted(true), MOUNT_TIMEOUT_MS);

    onCleanup(() => {
      el.removeEventListener("patchwork:mounted", onSettled);
      el.removeEventListener("patchwork:no-tool", onSettled);
      clearTimeout(timer);
    });
  });

  return isMounted;
};
