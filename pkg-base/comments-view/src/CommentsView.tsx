import "./styles.css";
// Pulls in <patchwork-view> JSX intrinsic type augmentations.
import type {} from "@inkandswitch/patchwork-elements";
import {
  createSignal,
  createMemo,
  createEffect,
  createComputed,
  on,
  onCleanup,
  Show,
  For,
} from "solid-js";

import { useRepo } from "solid-automerge";
import {
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo/slim";

import {
  subscribeDoc,
  subscribe,
} from "@inkandswitch/patchwork-providers-solid";
import { subscribe as subscribeProvider } from "@inkandswitch/patchwork-providers";
import {
  createDocumentThread,
  type DocWithComments,
} from "./comments";

type CommentEntry = { targetUrl: AutomergeUrl; threadUrl: AutomergeUrl };

export function CommentsView(props: { element: HTMLElement }) {
  const repo = useRepo();

  // The doc the panel is about: whatever is currently selected in the main
  // view. Both the comment list and document-level "Add comment" target it.
  const selectedDocUrls = subscribe<AutomergeUrl[]>(
    props.element,
    { type: "patchwork:selected-doc" },
    []
  );
  const targetDocUrl = () => selectedDocUrls()[0] as AutomergeUrl | undefined;

  // Scope the comments subscription to the selected doc and re-open it when
  // that changes. A single global (url-less) subscription would accumulate
  // every mounted doc's threads and never drop the previous document's
  // comments as you navigate.
  const commentEntries = useScopedCommentEntries(props.element, targetDocUrl);

  // Threads that turn up while you're already looking at a doc (one you just
  // added, or a collaborator's arriving live) lift in; the ones loaded with
  // the doc just appear, or every thread would animate on every doc switch.
  // "Loaded with the doc" is anything mounted within SETTLE_MS of selecting it.
  const SETTLE_MS = 1000;
  let settledAt = 0;
  createComputed(
    on(targetDocUrl, () => {
      settledAt = performance.now() + SETTLE_MS;
    })
  );

  // `selection` is read-only input (driven by the active editor), `highlight`
  // is our output. Splitting them avoids the feedback loop a single shared
  // map would have.
  const [focusDoc, focusHandle] = subscribeDoc<{
    selection: Record<AutomergeUrl, true>;
    highlight: Record<AutomergeUrl, true>;
  }>(props.element, { type: "patchwork:focus" });

  const [, contactHandle] = subscribeDoc<Record<string, never>>(props.element, {
    type: "patchwork:contact",
  });
  const currentContactUrl = () =>
    contactHandle()?.url as AutomergeUrl | undefined;

  const threadUrls = createMemo<AutomergeUrl[]>(() => {
    const entries = commentEntries();
    const threadUrls = new Set<AutomergeUrl>();
    for (const { threadUrl } of entries) {
      threadUrls.add(threadUrl);
    }
    return Array.from(threadUrls);
  });

  const threadTargetUrlMap = createMemo<Map<AutomergeUrl, AutomergeUrl[]>>(
    () => {
      const entries = commentEntries();
      const map = new Map<AutomergeUrl, AutomergeUrl[]>();
      for (const { targetUrl, threadUrl } of entries) {
        const existing = map.get(threadUrl);
        if (existing) {
          if (!existing.includes(targetUrl)) existing.push(targetUrl);
        } else {
          map.set(threadUrl, [targetUrl]);
        }
      }
      return map;
    }
  );

  const selectedHandles = useResolvedHandles(
    () => Object.keys(focusDoc()?.selection ?? {}) as AutomergeUrl[],
    repo
  );

  const threadTargetHandleMap = useResolvedHandleMap(threadTargetUrlMap, repo);

  // A thread is worth showing unless every one of its targets is a text range
  // that has collapsed to an empty string — see `targetIsVisible`.
  const threadsWithVisibleTarget = useThreadsWithVisibleTarget(
    threadTargetUrlMap,
    repo
  );

  // Document-level threads target the whole document (a bare url, no `/` path
  // or `#` heads).
  const docLevelThreadUrls = createMemo<Set<AutomergeUrl>>(() => {
    const map = threadTargetUrlMap();
    const set = new Set<AutomergeUrl>();
    for (const [threadUrl, targets] of map) {
      if (
        targets.length > 0 &&
        targets.every((t) => !t.includes("/") && !t.includes("#"))
      ) {
        set.add(threadUrl);
      }
    }
    return set;
  });

  // Threads that can overlap the editor's selection. Document-level threads
  // are left out: they cover the whole doc, so they'd match every selection.
  const renderableThreadUrls = createMemo<AutomergeUrl[]>(() =>
    threadUrls().filter(
      (url) =>
        threadsWithVisibleTarget().has(url) && !docLevelThreadUrls().has(url)
    )
  );

  const displayedThreadUrls = createMemo<AutomergeUrl[]>(() =>
    threadUrls().filter((url) => threadsWithVisibleTarget().has(url))
  );

  const overlappingThreads = createMemo<AutomergeUrl[]>(() =>
    renderableThreadUrls().filter((url) =>
      threadOverlapsSelection(
        threadTargetHandleMap().get(url) ?? [],
        selectedHandles()
      )
    )
  );

  // Tiebreaker for when several threads share the same range — without it
  // the second of two threads on the same target would be unselectable.
  const [pinnedThread, setPinnedThread] = createSignal<
    AutomergeUrl | undefined
  >();

  const primaryThreadUrl = createMemo<AutomergeUrl | undefined>(() => {
    const pinned = pinnedThread();
    // Document-level threads target the whole doc, so they have no range to
    // overlap the selection and never appear in `overlappingThreads`. The
    // only way for one to become primary is by being explicitly pinned
    // (clicked).
    if (pinned && docLevelThreadUrls().has(pinned)) return pinned;
    const overlaps = overlappingThreads();
    if (overlaps.length === 0) return undefined;
    if (pinned && overlaps.includes(pinned)) return pinned;
    return overlaps[0];
  });

  const secondaryThreadUrls = createMemo(() => {
    const p = primaryThreadUrl();
    return new Set(overlappingThreads().filter((u) => u !== p));
  });

  // The thread card under the pointer, which highlights its targets in place
  // of the primary thread's while hovered.
  const [hoveredThread, setHoveredThread] = createSignal<
    AutomergeUrl | undefined
  >();

  createEffect(() => {
    const handle = focusHandle();
    if (!handle) return;
    const p = hoveredThread() ?? primaryThreadUrl();
    const urls = p ? (threadTargetUrlMap().get(p) ?? []) : [];
    const desired: Record<AutomergeUrl, true> = {};
    for (const u of urls) desired[u] = true;
    handle.change((doc) => {
      doc.highlight = desired;
    });
  });

  // Clicking a thread card pins it and jumps `selection` to its targets;
  // the editor's next cursor move will overwrite `selection` again.
  const onSelectThread = (
    threadUrl: AutomergeUrl,
    targetUrls: AutomergeUrl[]
  ) => {
    const handle = focusHandle();
    if (!handle) return;
    const wasPrimary = primaryThreadUrl() === threadUrl;
    setPinnedThread(wasPrimary ? undefined : threadUrl);
    const next: Record<AutomergeUrl, true> = {};
    if (!wasPrimary) for (const u of targetUrls) next[u] = true;
    handle.change((doc) => {
      doc.selection = next;
    });
  };

  // Card clicks bubble up from the thread tool. Ignore clicks on interactive
  // controls (its buttons / draft textarea) so they don't also select.
  const onClickThreadCard = (e: MouseEvent, threadUrl: AutomergeUrl) => {
    const target = e.target as HTMLElement | null;
    if (
      target?.closest("textarea, button, input, a, select, .cm-editor")
    )
      return;
    onSelectThread(threadUrl, threadTargetUrlMap().get(threadUrl) ?? []);
  };

  // The selection state we hand each thread tool via `data-thread-state`.
  const threadState = (threadUrl: AutomergeUrl): string =>
    primaryThreadUrl() === threadUrl
      ? "primary"
      : secondaryThreadUrls().has(threadUrl)
        ? "secondary"
        : "inactive";

  onCleanup(() => {
    const handle = focusHandle();
    if (!handle) return;
    handle.change((doc) => {
      doc.highlight = {} as Record<AutomergeUrl, true>;
    });
  });

  const canAddComment = () =>
    Boolean(targetDocUrl()) && Boolean(currentContactUrl());

  const onAddComment = async () => {
    const url = targetDocUrl();
    const contactUrl = currentContactUrl();
    if (!url || !contactUrl) return;
    const handle = await repo.find<DocWithComments>(url);
    createDocumentThread({ docHandle: handle, contactUrl });
  };

  return (
    <div class="comments-panel">
      <div class="comments-panel-header">
        <span class="comments-panel-header-title">Comments</span>
        <Show when={canAddComment()}>
          <button
            class="comment-btn"
            onClick={onAddComment}
            title="Comment on this document"
          >
            Add comment
          </button>
        </Show>
      </div>
      <Show
        when={displayedThreadUrls().length > 0}
        fallback={<div class="comments-empty">No comments yet</div>}
      >
        <For each={displayedThreadUrls()}>
          {(threadUrl) => (
            <div
              class="comments-thread"
              data-new={performance.now() > settledAt ? "" : undefined}
              // Once in, it's an ordinary thread: its actions row remounts each
              // time the thread becomes primary (it follows the cursor), and
              // that mustn't lift in again.
              onTransitionEnd={(e) => {
                if (
                  e.propertyName === "opacity" &&
                  (e.target as Element).parentElement?.localName ===
                    "patchwork-view"
                ) {
                  e.currentTarget.removeAttribute("data-new");
                }
              }}
              onClick={(e) => onClickThreadCard(e, threadUrl)}
              onMouseEnter={() => setHoveredThread(threadUrl)}
              onMouseLeave={() =>
                setHoveredThread((u) => (u === threadUrl ? undefined : u))
              }
            >
              <patchwork-view
                doc-url={threadUrl}
                tool-id="comment-thread"
                attr:data-thread-state={threadState(threadUrl)}
              />
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

// Open a `patchwork:comments` subscription scoped to `docUrl()` and re-open
// it whenever the selected doc changes, clearing entries in between so the
// previous document's comments don't linger. Returns the current doc's
// entries (empty when nothing is selected).
function useScopedCommentEntries(
  element: HTMLElement,
  docUrl: () => AutomergeUrl | undefined
): () => CommentEntry[] {
  const [entries, setEntries] = createSignal<CommentEntry[]>([]);
  createEffect(() => {
    const url = docUrl();
    setEntries([]);
    if (!url) return;
    const unsubscribe = subscribeProvider<CommentEntry[]>(
      element,
      { type: "patchwork:comments", url },
      (value) => setEntries(value ?? [])
    );
    onCleanup(unsubscribe);
  });
  return entries;
}

// Reactively resolve a list of urls into live sub-handles. Re-resolves
// whenever the url list changes; resolution is async (`repo.find`) so the
// accessor lags one tick behind the urls.
function useResolvedHandles(
  urls: () => AutomergeUrl[],
  repo: Repo
): () => DocHandle<unknown>[] {
  const [handles, setHandles] = createSignal<DocHandle<unknown>[]>([]);
  createEffect(() => {
    const list = urls();
    let cancelled = false;
    Promise.all(list.map((u) => repo.find(u).catch(() => undefined))).then(
      (resolved) => {
        if (cancelled) return;
        setHandles(resolved.filter((h): h is DocHandle<unknown> => Boolean(h)));
      }
    );
    onCleanup(() => {
      cancelled = true;
    });
  });
  return handles;
}

// Same as `useResolvedHandles` but for a keyed map of url lists.
function useResolvedHandleMap(
  map: () => Map<AutomergeUrl, AutomergeUrl[]>,
  repo: Repo
): () => Map<AutomergeUrl, DocHandle<unknown>[]> {
  const [resolved, setResolved] = createSignal<
    Map<AutomergeUrl, DocHandle<unknown>[]>
  >(new Map());
  createEffect(() => {
    const m = map();
    let cancelled = false;
    void (async () => {
      const out = new Map<AutomergeUrl, DocHandle<unknown>[]>();
      for (const [key, urls] of m) {
        const handles = await Promise.all(
          urls.map((u) => repo.find(u).catch(() => undefined))
        );
        out.set(
          key,
          handles.filter((h): h is DocHandle<unknown> => Boolean(h))
        );
      }
      if (!cancelled) setResolved(out);
    })();
    onCleanup(() => {
      cancelled = true;
    });
  });
  return resolved;
}

// Resolves each thread's target urls into live span handles and reports which
// threads have at least one visible target. Re-runs when the url map changes,
// and recomputes live when any resolved target doc changes — so a thread whose
// commented text gets deleted disappears without waiting for a re-resolve.
function useThreadsWithVisibleTarget(
  map: () => Map<AutomergeUrl, AutomergeUrl[]>,
  repo: Repo
): () => Set<AutomergeUrl> {
  const [visible, setVisible] = createSignal<Set<AutomergeUrl>>(new Set());
  createEffect(() => {
    const m = map();
    let cancelled = false;
    let resolved = new Map<AutomergeUrl, DocHandle<unknown>[]>();

    const recompute = () => {
      if (cancelled) return;
      const next = new Set<AutomergeUrl>();
      for (const [threadUrl, handles] of resolved) {
        if (handles.some(targetIsVisible)) next.add(threadUrl);
      }
      setVisible(next);
    };

    void (async () => {
      const out = new Map<AutomergeUrl, DocHandle<unknown>[]>();
      for (const [threadUrl, urls] of m) {
        const handles = await Promise.all(
          urls.map((u) => repo.find(u).catch(() => undefined))
        );
        out.set(
          threadUrl,
          handles.filter((h): h is DocHandle<unknown> => Boolean(h))
        );
      }
      if (cancelled) return;
      resolved = out;
      for (const h of flatHandles(resolved)) h.on("change", recompute);
      recompute();
    })();

    onCleanup(() => {
      cancelled = true;
      for (const h of flatHandles(resolved)) h.off("change", recompute);
    });
  });
  return visible;
}

function flatHandles(
  map: Map<AutomergeUrl, DocHandle<unknown>[]>
): DocHandle<unknown>[] {
  const out: DocHandle<unknown>[] = [];
  for (const handles of map.values()) out.push(...handles);
  return out;
}

// A target is hidden only when it is a text range that has collapsed to an
// empty string (the commented text was deleted). Every other target — a whole
// document, a sub-doc path such as a notebook cell — stays listed.
function targetIsVisible(handle: DocHandle<unknown>): boolean {
  const positions = handle.rangePositions();
  if (!positions) return true;
  const [start, end] = positions;
  return start !== end;
}

// A selected text range overlaps a ranged target; a selected sub-doc (such as
// a notebook cell) matches a target at or inside it.
function threadOverlapsSelection(
  targets: DocHandle<unknown>[],
  selection: DocHandle<unknown>[]
): boolean {
  return targets.some((t) =>
    selection.some((s) => s.overlaps(t) || s.url === t.url || s.contains(t))
  );
}

