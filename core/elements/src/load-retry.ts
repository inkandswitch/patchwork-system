/**
 * The retry schedule and resync step shared by component mode
 * (`<patchwork-view>`) and legacy mode (`LegacyImpl`) for a doc that failed
 * to load.
 */
import {
  parseAutomergeUrl,
  type AutomergeUrl,
  type DocumentId,
  type Repo,
} from "@automerge/automerge-repo/slim";

// Delays between tries of a failed load. A grant can land seconds before its
// doc is fetchable, with no keyhive op after it to bring the view back, so a
// timer keeps asking, on the last delay for as long as the view is up: a
// sender's device can take minutes to push a doc it just shared.
const LOAD_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];

/** How long to wait before try number `attempt` (0 is the first retry). */
export function loadRetryDelay(attempt: number): number {
  return LOAD_RETRY_DELAYS_MS[
    Math.min(attempt, LOAD_RETRY_DELAYS_MS.length - 1)
  ];
}

// A query that settled on "unavailable" stays there until data is pushed, a
// connection changes or a key arrives, so a re-find alone finds nothing new.
// `resyncSubduction` re-arms it. It's called when a retry is scheduled, so
// the round is under way by the time the retry's find runs. It goes by the
// view's url, so under a remapper it doesn't reach a draft's clone.
export function resyncBeforeRetry(
  repo: Repo,
  url: AutomergeUrl,
  onError: (err: unknown) => void
): void {
  const resyncable = repo as Repo & {
    resyncSubduction?: (documentId: DocumentId) => void;
  };
  if (typeof resyncable.resyncSubduction !== "function") return;
  try {
    resyncable.resyncSubduction(parseAutomergeUrl(url).documentId);
  } catch (err) {
    onError(err);
  }
}
