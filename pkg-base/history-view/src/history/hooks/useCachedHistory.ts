import * as Automerge from "@automerge/automerge/slim";
import type { ChangeMetadata } from "@automerge/automerge/slim";
import type { DocHandle, Repo } from "@automerge/automerge-repo/slim";
import type { AutomergeUrl } from "@automerge/automerge-repo/slim";
import {
  makeDocumentProjection,
  useDocument,
} from "solid-automerge";
import {
  createMemo,
  createEffect,
  createSignal,
  Accessor,
  onCleanup,
} from "solid-js";
import type {
  HistoryItem,
  GroupingStrategyConfig,
  HistoryGroupingsDoc,
} from "../../types";
import type { HasPatchworkMetadata } from "@inkandswitch/patchwork-filesystem";
import { DEFAULT_TIME_WINDOW, getStrategyKey } from "../utils";
import * as tasklib from "@awarth/tasklib";

// Short cooldown between consecutive dispatches to suppress duplicate enqueues
// while a task is still in-flight / has yet to update `cachedHeads`. The
// primary dispatch gate is the precise group-boundary condition below; this is
// just a safety net.
const DISPATCH_COOLDOWN_MS = 5 * 1000;

export interface CachedHistory {
  items: Accessor<HistoryItem[]>;
  /**
   * True while no history document exists yet for this source doc — the
   * bootstrap task has been dispatched but hasn't finished creating and
   * linking the history doc. Consumers can use this to show a dedicated
   * "computing history…" UI instead of the (empty) item list.
   */
  isInitializing: Accessor<boolean>;
  /** True while a forced recompute is in progress */
  isRecalculating: Accessor<boolean>;
  /** Unix ms timestamp from historyDoc.updatedAt — when the task last ran */
  updatedAt: Accessor<number | undefined>;
  /** Reset the cache and re-dispatch the grouping task from scratch */
  forceRecompute: () => void;
  /** Persist a user-defined label for an item (keyed by latestHash) */
  setLabel: (hash: string, label: string) => void;
}

/**
 * Hook that manages history grouping with the history document as the source
 * of truth for stored groupings, plus a synthesized "virtual" trailing item
 * for any changes that have landed since the last task run.
 *
 * A single change-listener on the source handle:
 * - publishes the current source heads into a reactive signal so the virtual
 *   tail can re-render, and
 * - (re)dispatches the background grouping task precisely when doing so would
 *   actually change what the UI shows — namely, when the delta since
 *   `cachedHeads` would no longer fit inside one grouping window. Until that
 *   point the virtual trailing item is an exact stand-in for the single group
 *   the task would produce, so dispatching would be pure churn.
 *
 * @param sourceHandle - Handle to the source document
 * @param strategyConfig - Grouping strategy configuration (reactive)
 * @param repo - Automerge repository
 * @returns Reactive items accessor + an `isInitializing` flag for the
 *          pre-history-doc state.
 */
export function useCachedHistory(
  sourceHandle: Accessor<DocHandle<unknown> | undefined>,
  strategyConfig: Accessor<GroupingStrategyConfig>,
  repo: Repo
): CachedHistory {
  const sourceDoc = createMemo(() => {
    const handle = sourceHandle();
    if (!handle) return undefined;
    return makeDocumentProjection(handle as DocHandle<HasPatchworkMetadata>);
  });

  // PART 1: Get history document URL from source document
  const historyUrl = createMemo<AutomergeUrl | undefined>(() => {
    const handle = sourceHandle();
    const doc = sourceDoc();
    if (!handle || !doc) return undefined;

    const metadata = (doc as HasPatchworkMetadata)?.["@patchwork"];
    return metadata?.history as AutomergeUrl | undefined;
  });

  // PART 2: Subscribe to history document reactively (for UI updates)
  const [historyDoc, historyDocHandle] = useDocument<HistoryGroupingsDoc>(
    historyUrl,
    { repo }
  );

  let lastDispatchTime = 0;

  const dispatchTask = (sourceUrl: AutomergeUrl) => {
    if (localStorage.useTasks) {
      tasklib
        .queue("automerge:2xrHArq3QwSGHaeUdquP7ECTpnEL" as AutomergeUrl)
        .addTask<AutomergeUrl, void>({
          input: sourceUrl,
          importUrl: new URL(/* @vite-ignore */ "../task.js", import.meta.url),
        });
      lastDispatchTime = Date.now();
    } else {
      import("../task").then((m) => {
        m.default(sourceUrl);
        lastDispatchTime = Date.now();
      });
    }
  };

  // PART 3: Watch the source document. On every change we update
  // `sourceHeads` (so the items memo re-renders the virtual tail) and decide
  // whether to dispatch the grouping task.
  //
  // Dispatch condition:
  // - Bootstrap: no history doc exists yet → dispatch.
  // - Heads match the history doc's cached heads → nothing to do.
  // - Otherwise, dispatch iff the delta's time span exceeds the grouping
  //   window. This is the *exact* point at which the task would produce a
  //   materially different result than the virtual trailing item the UI is
  //   already showing. A small `DISPATCH_COOLDOWN_MS` suppresses duplicate
  //   enqueues while a task is still in-flight.
  const [sourceHeads, setSourceHeads] = createSignal<string[] | undefined>(
    undefined
  );

  const [isRecalculating, setIsRecalculating] = createSignal(false);

  createEffect(() => {
    const source = sourceHandle();
    if (!source) {
      setSourceHeads(undefined);
      return;
    }

    const onChange = () => {
      const sourceRawDoc = source.doc();
      if (!sourceRawDoc) return;

      const currentHeads = Automerge.getHeads(sourceRawDoc);
      setSourceHeads(currentHeads);

      const hHandle = historyDocHandle();
      const histDoc = hHandle?.doc();

      // Bootstrap: no history doc yet — dispatch to create one.
      if (!histDoc) {
        if (Date.now() - lastDispatchTime < DISPATCH_COOLDOWN_MS) return;
        dispatchTask(source.url);
        return;
      }

      const cachedHeads = histDoc.heads ?? [];
      if (headsEqual(currentHeads, cachedHeads)) return;

      if (Date.now() - lastDispatchTime < DISPATCH_COOLDOWN_MS) return;

      const deltaMeta = Automerge.getChangesMetaSince(
        sourceRawDoc,
        cachedHeads
      );
      if (deltaMeta.length === 0) return;

      const windowMs = strategyWindowMs(strategyConfig());
      if (windowMs !== undefined && deltaTimeSpan(deltaMeta) <= windowMs) {
        return;
      }

      dispatchTask(source.url);
    };

    source.on("change", onChange);
    onChange();

    onCleanup(() => {
      source.off("change", onChange);
    });
  });

  // Clear isRecalculating once the task writes non-empty heads back.
  createEffect(() => {
    const heads = historyDoc()?.heads;
    if (heads && heads.length > 0 && isRecalculating()) {
      setIsRecalculating(false);
    }
  });

  // PART 4: Return reactive items. If the source doc has advanced past the
  // cached heads, synthesize a single "virtual" item at the top of the list
  // covering the ungrouped tail. The virtual item is never stored; it
  // disappears once the background task runs and folds the tail into the
  // cached groupings.
  const items = createMemo<HistoryItem[]>(() => {
    const doc = historyDoc();
    const strategyKey = getStrategyKey(strategyConfig());
    const labels = doc?.labels ?? {};
    // Deduplicate by latestHash — concurrent task runs (e.g. two browser tabs)
    // can each splice the same group into the array before syncing, leaving
    // duplicate entries in the stored doc.
    const storedItems: HistoryItem[] = deduplicateItems(
      doc?.groupings?.[strategyKey]?.items ?? []
    ).map((item) =>
      labels[item.latestHash]
        ? { ...item, customLabel: labels[item.latestHash] }
        : item
    );

    // While recalculating, keep existing items visible to avoid collapsing the
    // list into a single virtual item covering all history.
    if (isRecalculating()) return storedItems;

    const cachedHeads = doc?.heads ?? [];
    const currentSourceHeads = sourceHeads();
    if (!currentSourceHeads || headsEqual(currentSourceHeads, cachedHeads)) {
      return storedItems;
    }

    const handle = sourceHandle();
    const sourceRawDoc = handle?.doc();
    if (!sourceRawDoc) return storedItems;

    const deltaMeta = Automerge.getChangesMetaSince(sourceRawDoc, cachedHeads);
    if (deltaMeta.length === 0) return storedItems;

    // Newest-first to match the cached items ordering.
    deltaMeta.reverse();

    const virtualItem = buildVirtualItem(deltaMeta, storedItems[0]?.latestHash);

    const virtualWithLabel = labels[virtualItem.latestHash]
      ? { ...virtualItem, customLabel: labels[virtualItem.latestHash] }
      : virtualItem;
    return [virtualWithLabel, ...storedItems];
  });

  // True until the source doc carries a link to a history doc AND that doc
  // has actually loaded. Covers both the bootstrap window (task hasn't yet
  // created and linked the history doc) and the brief load window for a doc
  // that already had one.
  const isInitializing = createMemo(() => {
    if (!historyUrl()) return true;
    return historyDoc() === undefined;
  });

  const updatedAt = createMemo<number | undefined>(
    () => historyDoc()?.updatedAt
  );

  const forceRecompute = () => {
    const hHandle = historyDocHandle();
    if (hHandle) {
      hHandle.change((doc: HistoryGroupingsDoc) => {
        doc.heads = [];
        doc.updatedAt = 0; // bypass throttle so the task runs immediately
      });
      setIsRecalculating(true);
    }
    const source = sourceHandle();
    if (source) dispatchTask(source.url);
  };

  const setLabel = (hash: string, label: string) => {
    const hHandle = historyDocHandle();
    if (!hHandle) return;
    hHandle.change((doc: HistoryGroupingsDoc) => {
      if (!doc.labels) doc.labels = {};
      if (label.trim() === "") {
        delete doc.labels[hash];
      } else {
        doc.labels[hash] = label.trim();
      }
    });
  };

  return {
    items,
    isInitializing,
    isRecalculating,
    updatedAt,
    forceRecompute,
    setLabel,
  };
}

/**
 * Build a single `HistoryItem` covering every change between the history
 * doc's cached heads and the source doc's current heads. This item exists
 * only at runtime — it is never written to the cache.
 */
function buildVirtualItem(
  deltaMeta: ChangeMetadata[],
  firstStoredLatestHash: string | undefined
): HistoryItem {
  const authors: string[] = [];
  let minTime = Infinity;
  let maxTime = -Infinity;
  for (const m of deltaMeta) {
    if (m.actor && !authors.includes(m.actor)) authors.push(m.actor);
    const t = m.time;
    if (t !== undefined) {
      if (t < minTime) minTime = t;
      if (t > maxTime) maxTime = t;
    }
  }

  const item: HistoryItem = {
    id: `virtual-${deltaMeta[0].hash}-${deltaMeta.length}`,
    count: deltaMeta.length,
    latestHash: deltaMeta[0].hash,
    authors,
    isVirtual: true,
  };

  if (minTime !== Infinity) {
    item.startTime = minTime;
    item.endTime = maxTime;
  }

  // The change immediately before the virtual tail is the newest stored item's
  // representative hash. Leave `beforeHead` unset on a fresh doc (no stored
  // items yet) so the selection yields a from-genesis diff.
  if (firstStoredLatestHash) {
    item.beforeHead = firstStoredLatestHash;
  }

  return item;
}

/**
 * Remove items with duplicate latestHash values, keeping the first occurrence.
 * Guards against concurrent task runs each splicing the same group into the
 * stored array before their changes sync and merge.
 */
function deduplicateItems(items: HistoryItem[]): HistoryItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.latestHash)) return false;
    seen.add(item.latestHash);
    return true;
  });
}

/**
 * Check if two heads arrays are equal (order-independent)
 */
function headsEqual(heads1: string[], heads2: string[]): boolean {
  if (heads1.length !== heads2.length) return false;
  const set = new Set(heads2);
  return heads1.every((h) => set.has(h));
}

/**
 * Wall-clock span covered by a set of change metadata entries, in
 * milliseconds. Returns 0 if no entries carry a timestamp. Change `time` is
 * stored by Automerge in seconds.
 */
function deltaTimeSpan(deltaMeta: ChangeMetadata[]): number {
  let min = Infinity;
  let max = -Infinity;
  for (const m of deltaMeta) {
    const t = m.time;
    if (t === undefined) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  if (min === Infinity || max === -Infinity) return 0;
  return (max - min) * 1000;
}

/**
 * Width (in ms) of a grouping strategy's natural boundary, or `undefined` if
 * the strategy doesn't have a time-based boundary. For such strategies we
 * don't yet have a precise group-boundary dispatch condition, so callers
 * should dispatch on any delta rather than waiting.
 */
function strategyWindowMs(config: GroupingStrategyConfig): number | undefined {
  if (config.name === "timeWindow") {
    return config.params?.timeWindow ?? DEFAULT_TIME_WINDOW;
  }
  return undefined;
}
