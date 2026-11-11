import type { AutomergeUrl } from "@automerge/automerge-repo/slim";

/**
 * Represents a run of one-or-more changes in the document history.
 *
 * A "singleton" change is simply a `HistoryItem` with `count === 1`; the
 * storage and render paths do not distinguish it from a multi-change group.
 *
 * Intermediate per-change metadata is not kept here — only the aggregate
 * information the UI reads. Per-change `actor` / `time` fields live on the
 * source document itself and are not duplicated into this cache.
 */
export interface HistoryItem {
  id: string;
  /** Number of changes covered by this item (1 for a lone change) */
  count: number;
  /** Hash of the newest change in the item (used for selection and copy) */
  latestHash: string;
  /** Deduplicated list of authors across all changes in the item */
  authors: string[];
  /** Start time in Unix seconds (from Automerge ChangeMetadata.time) */
  startTime?: number;
  /** End time in Unix seconds (from Automerge ChangeMetadata.time) */
  endTime?: number;
  /** Hash of the change immediately preceding this item in linear history */
  beforeHead?: string;
  /** Number of characters/elements added across all changes in the item */
  additions?: number;
  /** Number of characters/elements removed across all changes in the item */
  deletions?: number;
  /** User-defined label overriding the auto-generated one */
  customLabel?: string;
  /** True for the runtime-only virtual item representing in-progress changes */
  isVirtual?: boolean;
  /** Per-author breakdown, present when multiple authors contributed to this item */
  subItems?: HistoryItem[];
}

/**
 * ViewHeads structure for annotations
 */
export interface ViewHeadsType {
  beforeHeads: string[];
  afterHeads: string[];
}

/**
 * Configuration for a grouping strategy including parameters.
 *
 * Only `timeWindow` is implemented today; the discriminated shape is kept so
 * future strategies can be added without reshuffling consumers.
 */
export type StrategyName = "timeWindow" | "author";
export interface GroupingStrategyConfig {
  name: StrategyName;
  params?: {
    timeWindow?: number;  // ms, for timeWindow strategy
    perActor?: boolean;   // when true, split groups on actor change within the window
  };
}

/**
 * Cached grouping for a single strategy
 */
export interface CachedGrouping {
  items: HistoryItem[];
}

/**
 * Schema version for the cached history document.
 * Bump when the shape of `HistoryItem` changes so the task can discard a
 * stale cache instead of reading a now-incompatible structure.
 */
export const HISTORY_DOC_VERSION = 8;

/**
 * Document structure for storing persistent history groupings.
 * `heads` is stored at the top level because the background task
 * computes all strategies in a single pass.
 */
export interface HistoryGroupingsDoc {
  ["@patchwork"]: { type: "patchwork:history-change-groups" };
  version: number;
  sourceDocumentUrl: AutomergeUrl;
  /** Unix ms timestamp of when the task last ran (set at task start) */
  updatedAt: number;
  /** Throttle interval in ms — minimum wait before dispatching another task */
  throttleMs: number;
  heads: string[];
  groupings: {
    [strategyKey: string]: CachedGrouping;
  };
  /** User-defined labels keyed by item latestHash — survives task recomputation */
  labels?: { [hash: string]: string };
}

/**
 * Find an item matching a specific hash.
 *
 * Only the item's latest/representative hash is matched, since the selection
 * UI only ever produces that hash — intermediate change hashes inside a
 * multi-change item are never looked up here.
 */
export function findItemByHash(
  items: HistoryItem[],
  hash: string
): HistoryItem | null {
  for (const item of items) {
    if (item.latestHash === hash) return item;
  }
  return null;
}

/**
 * Check if an item is currently selected
 */
export function isItemSelected(
  item: HistoryItem,
  selectedItems: HistoryItem[]
): boolean {
  return selectedItems.some((s) => s.id === item.id);
}
