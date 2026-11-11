import type { GroupingStrategyConfig, HistoryItem } from "../types";

const relativeTime = (timestamp: number): string => {
  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  if (seconds < 60) {
    return "just now";
  } else if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  } else if (hours < 24) {
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  } else if (days < 7) {
    return `${days} day${days === 1 ? "" : "s"} ago`;
  } else if (weeks < 4) {
    return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
  } else if (months < 12) {
    return `${months} month${months === 1 ? "" : "s"} ago`;
  } else {
    return `${years} year${years === 1 ? "" : "s"} ago`;
  }
};

/**
 * Format a Unix timestamp (in seconds) to a display string.
 * Returns e.g. "Jan 5, 2:30 PM (3 hours ago)" or "" if no timestamp.
 */
export function formatTime(timestampSeconds: number | undefined): string {
  if (!timestampSeconds) return "";

  const date = new Date(timestampSeconds * 1000);
  const datePart = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const timePart = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const relative = relativeTime(timestampSeconds * 1000);

  return `${relative} (${datePart}, ${timePart})`;
}

export function formatTimeOnly(timestampSeconds: number | undefined): string {
  if (!timestampSeconds) return "";
  const date = new Date(timestampSeconds * 1000);
  return date
    .toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
    .toLowerCase();
}

// ============================================================================
// Change labels
// ============================================================================

export type ChangeSizeThresholds = { large: number; medium: number };

export function computeChangeSizeThresholds(items: HistoryItem[]): ChangeSizeThresholds {
  const magnitudes = items
    .map((i) => (i.additions ?? 0) + (i.deletions ?? 0))
    .filter((m) => m > 0)
    .sort((a, b) => a - b);

  if (magnitudes.length === 0) return { large: 0, medium: 0 };

  const at = (p: number) => magnitudes[Math.floor((magnitudes.length - 1) * p)];
  return { large: at(0.66), medium: at(0.33) };
}

export function getChangeLabel(item: HistoryItem, thresholds: ChangeSizeThresholds): string {
  const add = item.additions ?? 0;
  const del = item.deletions ?? 0;
  const magnitude = add + del;

  if (magnitude === 0) return "No change";

  const size =
    magnitude >= thresholds.large ? "Large"
    : magnitude >= thresholds.medium ? "Medium"
    : "Minor";

  const direction =
    del < add * 0.2 ? "addition"
    : add < del * 0.2 ? "deletion"
    : "edits";

  return `${size} ${direction}`;
}

// ============================================================================
// Strategies
// ============================================================================

export const DEFAULT_TIME_WINDOW = 15 * 60 * 1000; // 15 minutes

/**
 * Generate a unique cache key for a grouping strategy configuration.
 *
 * NOTE: Keep in sync with the duplicate implementation in `./task.ts` — the
 * task module can't currently import from siblings when run under the shared
 * worker.
 */
export function getStrategyKey(config: GroupingStrategyConfig): string {
  switch (config.name) {
    case "author":
      return "author";
    case "timeWindow": {
      const windowMs = config.params?.timeWindow ?? DEFAULT_TIME_WINDOW;
      if (config.params?.perActor) return `timeWindowPerActor:${windowMs}`;
      return `timeWindow:${windowMs}`;
    }
    default:
      throw new Error(`Unknown strategy: ${(config as { name: string }).name}`);
  }
}
