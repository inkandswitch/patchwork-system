/**
 * Which packages boot loads first. Each visit writes down which tools and
 * components every package provided, and which ones the views on screen were
 * showing, outermost first. The next boot loads the packages behind the
 * hash's `tool` and `frame` first, then the root view's, then those inside
 * it, and so on, then everything else (see `ModuleWatcher.prioritize`).
 */
import type {
  LoadBatch,
  PluginRef,
} from "@inkandswitch/patchwork-filesystem";
import { getRegistry } from "@inkandswitch/patchwork-plugins";

const VERSION = 1;
const VIEW_TAG = "patchwork-view";
const VIEW_PLUGIN_TYPES = new Set(["patchwork:tool", "patchwork:component"]);
// Views mount one after another as a page comes up, so wait for a lull.
const WRITE_DELAY_MS = 1_000;

export type LoadOrderHints = {
  /** The tools and components each settings entry provided last it loaded. */
  modules: Record<string, PluginRef[]>;
  /** What the mounted views showed, by depth: `[0]` is the outermost's. */
  views: PluginRef[][];
};

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

const isRef = (value: unknown): value is PluginRef =>
  typeof (value as PluginRef)?.type === "string" &&
  typeof (value as PluginRef)?.id === "string";

const refs = (value: unknown): PluginRef[] =>
  Array.isArray(value)
    ? value.filter(isRef).map(({ type, id }) => ({ type, id }))
    : [];

const sameRef = (a: PluginRef, b: PluginRef) =>
  a.type === b.type && a.id === b.id;

const refKey = (ref: PluginRef) => `${ref.type}\u0000${ref.id}`;

export function readLoadOrder(
  storage: Storage | undefined,
  key: string
): LoadOrderHints {
  const hints: LoadOrderHints = { modules: {}, views: [] };
  try {
    const raw = storage?.getItem(key);
    if (!raw) return hints;
    const stored = JSON.parse(raw);
    if (stored?.version !== VERSION) return hints;
    if (stored.modules && typeof stored.modules === "object") {
      for (const [entry, provided] of Object.entries(stored.modules)) {
        hints.modules[entry] = refs(provided);
      }
    }
    if (Array.isArray(stored.views)) hints.views = stored.views.map(refs);
  } catch {
    // Unreadable, or storage is off: boot loads everything at once.
  }
  return hints;
}

/** The tools a hash names, as the router reads them: `frame` and `tool`. */
export function hashTools(hash: string): PluginRef[] {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  return ["frame", "tool"].flatMap((key) => {
    const id = params.get(key);
    return id ? [{ type: "patchwork:tool", id }] : [];
  });
}

/**
 * The batches to load first: the packages behind `first`, then those behind
 * each depth of last visit's views. Each package is expected to provide every
 * planned plugin it provided last time, in whichever batch it lands. A
 * package already in a batch isn't repeated. Nothing is planned if `first`
 * names a tool no package provided, since there's no telling where it is.
 */
export function planLoadOrder(
  hints: LoadOrderHints,
  first: PluginRef[]
): LoadBatch[] {
  const providers = new Map<string, string[]>();
  for (const [entry, provided] of Object.entries(hints.modules)) {
    for (const ref of provided) {
      const key = refKey(ref);
      providers.set(key, [...(providers.get(key) ?? []), entry]);
    }
  }

  const placed = new Map<string, PluginRef[]>();
  const batches: LoadBatch[] = [];
  for (const [depth, wanted] of [first, ...hints.views].entries()) {
    const batch: LoadBatch = {};
    for (const ref of wanted) {
      const entries = providers.get(refKey(ref));
      if (!entries) {
        if (depth === 0) return [];
        // From somewhere other than the settings (a doc's suggested import,
        // say), so there's nothing to load early.
        continue;
      }
      for (const entry of entries) {
        let expected = placed.get(entry);
        if (!expected) {
          expected = batch[entry] = [];
          placed.set(entry, expected);
        }
        if (!expected.some((known) => sameRef(known, ref))) expected.push(ref);
      }
    }
    if (Object.keys(batch).length) batches.push(batch);
  }
  return batches;
}

/**
 * Starts loading each planned plugin as soon as it registers, rather than
 * once a view asks, so a view nested three deep doesn't wait on the three
 * above it to mount first. Stops listening once `until` settles.
 */
export function preloadPlugins(
  batches: LoadBatch[],
  until: Promise<unknown>
): void {
  const started = new Set<string>();
  const stops = batches
    .flatMap((batch) => Object.values(batch).flat())
    .map((ref) => {
      const registry = getRegistry(ref.type);
      return registry.on("registered", (plugin) => {
        if (plugin.id !== ref.id || started.has(refKey(ref))) return;
        started.add(refKey(ref));
        // The registry reports a failure, and the view that wanted it shows
        // it.
        registry.load(ref.id).catch(() => {});
      });
    });
  void until.finally(() => {
    for (const stop of stops) stop();
  });
}

export interface LoadOrderRecorder {
  /** A settings entry loaded, providing `mod.plugins`. */
  loaded(entry: string, mod: any): void;
  /** A settings entry went. */
  unloaded(entry: string): void;
  /** Forget every entry but these: the whole list, once every source is in. */
  keepOnly(entries: Iterable<string>): void;
  stop(): void;
}

/**
 * Keeps `hints` up to date in `storage`: the packages as they load and go,
 * and the views as they mount and unmount. Written after a lull, and when the
 * page is hidden or goes.
 */
export function recordLoadOrder(
  storage: Storage | undefined,
  key: string,
  hints: LoadOrderHints
): LoadOrderRecorder {
  const modules = { ...hints.modules };
  let views = hints.views;
  // Every view that's mounted something, until it unmounts or disconnects.
  const mounted = new Map<Element, PluginRef>();
  let dirty = false;
  let viewsChanged = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const snapshot = (): PluginRef[][] => {
    const byDepth: PluginRef[][] = [];
    for (const [element, ref] of mounted) {
      if (!element.isConnected) {
        mounted.delete(element);
        continue;
      }
      const level = (byDepth[depthOf(element)] ??= []);
      if (!level.some((known) => sameRef(known, ref))) level.push(ref);
    }
    return Array.from(byDepth, (level) => level ?? []);
  };

  const write = () => {
    clearTimeout(timer);
    timer = undefined;
    if (viewsChanged) {
      viewsChanged = false;
      const current = snapshot();
      // Nothing on screen (the page went before anything mounted) says
      // nothing about what to load first.
      if (current.length) {
        views = current;
        dirty = true;
      }
    }
    if (!dirty) return;
    dirty = false;
    try {
      storage?.setItem(key, JSON.stringify({ version: VERSION, modules, views }));
    } catch {
      // Full, or storage is off: next boot loads everything at once.
    }
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(write, WRITE_DELAY_MS);
  };

  const onMounted = (event: Event) => {
    const element = event.composedPath()[0];
    const ref = mountedRef((event as CustomEvent).detail);
    if (!(element instanceof Element) || element.localName !== VIEW_TAG) {
      return;
    }
    if (!ref) return;
    mounted.set(element, ref);
    viewsChanged = true;
    schedule();
  };

  // A view that was taken out unmounts from its old parent, so it's dropped
  // when the next snapshot finds it disconnected.
  const onUnmounted = (event: Event) => {
    const element = event.composedPath()[0] as Element;
    const ref = mountedRef((event as CustomEvent).detail);
    const current = mounted.get(element);
    if (current && ref && sameRef(current, ref)) mounted.delete(element);
    viewsChanged = true;
    schedule();
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") write();
  };

  // Capturing, so a tool that stops these on their way up can't hide them.
  window.addEventListener("patchwork:mounted", onMounted, true);
  window.addEventListener("patchwork:unmounted", onUnmounted, true);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", write);

  return {
    loaded(entry, mod) {
      const plugins: unknown[] = Array.isArray(mod?.plugins) ? mod.plugins : [];
      const provided = refs(plugins).filter((ref) =>
        VIEW_PLUGIN_TYPES.has(ref.type)
      );
      if (provided.length) modules[entry] = provided;
      else delete modules[entry];
      dirty = true;
      schedule();
    },
    unloaded(entry) {
      if (!(entry in modules)) return;
      delete modules[entry];
      dirty = true;
      schedule();
    },
    keepOnly(entries) {
      const keep = new Set(entries);
      for (const entry of Object.keys(modules)) {
        if (keep.has(entry)) continue;
        delete modules[entry];
        dirty = true;
      }
      if (dirty) schedule();
    },
    stop() {
      clearTimeout(timer);
      window.removeEventListener("patchwork:mounted", onMounted, true);
      window.removeEventListener("patchwork:unmounted", onUnmounted, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", write);
    },
  };
}

function mountedRef(detail: unknown): PluginRef | undefined {
  const mounted = detail as { toolId?: unknown; componentId?: unknown };
  if (typeof mounted?.componentId === "string") {
    return { type: "patchwork:component", id: mounted.componentId };
  }
  if (typeof mounted?.toolId === "string") {
    return { type: "patchwork:tool", id: mounted.toolId };
  }
  return undefined;
}

/** How many views `element` is inside, through shadow roots. */
function depthOf(element: Element): number {
  let depth = 0;
  let node: Node | null = element;
  for (;;) {
    const parent: Node | null = node.parentNode;
    node =
      parent?.nodeType === Node.DOCUMENT_FRAGMENT_NODE
        ? ((parent as ShadowRoot).host ?? null)
        : parent;
    if (!node) return depth;
    if ((node as Element).localName === VIEW_TAG) depth++;
  }
}
