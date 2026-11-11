import {
  type AutomergeUrl,
  type DocHandle,
  type DocHandleChangePayload,
  type DocHandleDeletePayload,
} from "@automerge/automerge-repo/slim";
import { accept, type SubscribeEvent } from "@inkandswitch/patchwork-providers";
import type {
  MountedEvent,
  UnmountedEvent,
  PatchworkViewElement,
} from "@inkandswitch/patchwork-elements";
import type { DocWithComments } from "@inkandswitch/patchwork-comments";

type CommentEntry = { targetUrl: AutomergeUrl; threadUrl: AutomergeUrl };

/**
 * Answers `patchwork:comments` subscriptions. Watches every mounted doc for
 * comment threads and pushes the resulting `CommentEntry[]` to subscribers.
 *
 * Subscriptions are scoped:
 *
 * - `{ url }` → only entries whose `targetUrl` lives in that doc. The
 *   subscriber is re-notified only when its own slice changes.
 * - no args → the flat list of every entry across all mounted docs.
 */
export const CommentsProvider = (element: PatchworkViewElement) => {
  // Mount bookkeeping survives the `await repo.find` below.
  const mountCounts = new Map<AutomergeUrl, number>();
  const handlesByUrl = new Map<AutomergeUrl, DocHandle<DocWithComments>>();

  // Two indices over the same entries: keyed by the doc that *stores* the
  // threads, and regrouped by the doc each entry's `targetUrl` points at.
  const entriesByStorageUrl = new Map<AutomergeUrl, CommentEntry[]>();
  let entriesByTargetUrl = new Map<AutomergeUrl, CommentEntry[]>();
  let flatEntries: CommentEntry[] = [];

  // Subscribers, split by the doc url they asked about (or the global set
  // for url-less subscriptions).
  const subscribersByUrl = new Map<
    AutomergeUrl,
    Set<(entries: CommentEntry[]) => void>
  >();
  const globalSubscribers = new Set<(entries: CommentEntry[]) => void>();

  element.addEventListener("patchwork:mounted", startWatch);
  element.addEventListener("patchwork:unmounted", stopWatch);
  element.addEventListener("patchwork:subscribe", onSubscribe);

  return () => {
    element.removeEventListener("patchwork:mounted", startWatch);
    element.removeEventListener("patchwork:unmounted", stopWatch);
    element.removeEventListener("patchwork:subscribe", onSubscribe);
    for (const url of [...handlesByUrl.keys()]) disposeDoc(url);
    subscribersByUrl.clear();
    globalSubscribers.clear();
  };

  function onSubscribe(event: SubscribeEvent) {
    if (event.detail.selector.type !== "patchwork:comments") return;
    const url = event.detail.selector.url as AutomergeUrl | undefined;

    accept<CommentEntry[]>(event, (respond) => {
      if (url) {
        respond(entriesByTargetUrl.get(url) ?? []);
        let set = subscribersByUrl.get(url);
        if (!set) subscribersByUrl.set(url, (set = new Set()));
        set.add(respond);
        return () => {
          set!.delete(respond);
          if (set!.size === 0) subscribersByUrl.delete(url);
        };
      }
      respond(flatEntries);
      globalSubscribers.add(respond);
      return () => globalSubscribers.delete(respond);
    });
  }

  async function startWatch(event: MountedEvent) {
    if (!("url" in event.detail)) return;
    const url = event.detail.url;
    const wasMounted = isMounted(url);
    mountDoc(url);
    if (wasMounted) return;

    let handle: DocHandle<DocWithComments>;
    try {
      handle = await element.repo.find<DocWithComments>(url);
    } catch (error) {
      console.error(`[providers] failed to watch comments on ${url}`, error);
      return;
    }
    if (!isMounted(url)) return;
    if (handlesByUrl.has(url)) return;

    handle.on("change", onChange);
    handle.on("delete", onDelete);
    handlesByUrl.set(url, handle);
    entriesByStorageUrl.set(url, buildEntriesForDoc(handle));
    rebuild();
  }

  function stopWatch(event: UnmountedEvent) {
    if (!("url" in event.detail)) return;
    const url = event.detail.url;
    unmountDoc(url);
    if (!isMounted(url)) disposeDoc(url);
  }

  function onChange({ handle }: DocHandleChangePayload<DocWithComments>) {
    const prev = entriesByStorageUrl.get(handle.url);
    if (!prev) return;
    const next = buildEntriesForDoc(handle);
    if (entryListsEqual(prev, next)) return;
    entriesByStorageUrl.set(handle.url, next);
    rebuild();
  }

  function onDelete({ handle }: DocHandleDeletePayload<DocWithComments>) {
    disposeDoc(handle.url);
  }

  function disposeDoc(url: AutomergeUrl) {
    const handle = handlesByUrl.get(url);
    mountCounts.delete(url);
    handlesByUrl.delete(url);
    entriesByStorageUrl.delete(url);
    if (!handle) return;
    handle.off("change", onChange);
    handle.off("delete", onDelete);
    rebuild();
  }

  // Recompute both indices from the per-storage-doc lists, then notify only
  // the subscribers whose visible slice actually changed.
  function rebuild() {
    const nextFlat: CommentEntry[] = [];
    for (const list of entriesByStorageUrl.values()) {
      for (const entry of list) nextFlat.push(entry);
    }

    const nextByTarget = new Map<AutomergeUrl, CommentEntry[]>();
    for (const entry of nextFlat) {
      const targetDocUrl = docUrlOfRef(entry.targetUrl);
      if (!targetDocUrl) continue;
      let bucket = nextByTarget.get(targetDocUrl);
      if (!bucket) nextByTarget.set(targetDocUrl, (bucket = []));
      bucket.push(entry);
    }

    const touched = new Set<AutomergeUrl>([
      ...nextByTarget.keys(),
      ...entriesByTargetUrl.keys(),
    ]);
    for (const url of touched) {
      const before = entriesByTargetUrl.get(url) ?? [];
      const after = nextByTarget.get(url) ?? [];
      if (entryListsEqual(before, after)) continue;
      const subs = subscribersByUrl.get(url);
      if (subs) for (const emit of subs) emit(after);
    }
    entriesByTargetUrl = nextByTarget;

    if (!entryListsEqual(flatEntries, nextFlat)) {
      flatEntries = nextFlat;
      for (const emit of globalSubscribers) emit(flatEntries);
    }
  }

  function buildEntriesForDoc(
    handle: DocHandle<DocWithComments>
  ): CommentEntry[] {
    const entries: CommentEntry[] = [];
    const threads = handle.doc()?.["@comments"]?.threads ?? [];
    for (const thread of threads) {
      if (thread.isResolved) continue;
      const threadUrl = handle.sub("@comments", "threads", {
        id: thread.id,
      }).url;
      // A ref may be a range/sub-doc target or, for a document-level comment,
      // the whole-document url itself. Either way it's emitted the same way.
      for (const targetUrl of thread.refs) {
        entries.push({ targetUrl, threadUrl });
      }
    }
    return entries;
  }

  function mountDoc(url: AutomergeUrl) {
    mountCounts.set(url, (mountCounts.get(url) ?? 0) + 1);
  }

  function unmountDoc(url: AutomergeUrl) {
    const cur = mountCounts.get(url) ?? 0;
    if (cur <= 1) mountCounts.delete(url);
    else mountCounts.set(url, cur - 1);
  }

  function isMounted(url: AutomergeUrl) {
    return mountCounts.has(url);
  }
};

// TODO: this probably doesnt need to exist
function docUrlOfRef(ref: AutomergeUrl): AutomergeUrl | undefined {
  const slash = ref.indexOf("/");
  const hash = ref.indexOf("#");
  const end =
    slash === -1
      ? hash === -1
        ? ref.length
        : hash
      : hash === -1
        ? slash
        : Math.min(slash, hash);
  const head = ref.slice(0, end);
  return head ? (head as AutomergeUrl) : undefined;
}

const entriesEqual = (a: CommentEntry, b: CommentEntry) =>
  a.targetUrl === b.targetUrl && a.threadUrl === b.threadUrl;

const entryListsEqual = (a: CommentEntry[], b: CommentEntry[]) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!entriesEqual(a[i], b[i])) return false;
  }
  return true;
};
