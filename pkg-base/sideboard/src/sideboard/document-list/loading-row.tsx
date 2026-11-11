import { For } from "solid-js";

/**
 * A skeleton row shown by a Suspense boundary while a document or folder's
 * handle is still loading, so items can stream in instead of the whole list
 * appearing at once.
 */
export function LoadingRow(props: { depth?: number }) {
  return (
    <div
      class="document-list-item document-list-item--loading"
      style={{ "--depth": props.depth ?? 0 }}
      aria-hidden="true"
    >
      <span class="document-list-item__skeleton" />
    </div>
  );
}

// Pseudo-random-looking but deterministic widths so the skeleton reads as a
// list of real items rather than identical bars.
const SKELETON_WIDTHS = ["11rem", "7rem", "9.5rem", "6rem", "10rem", "8rem"];

/**
 * A stack of skeleton rows: the document-list's "I'm constructing myself" state.
 * Shown immediately under the toolbar while the root folder document loads, so
 * the panel gives instant feedback instead of appearing empty.
 */
export function LoadingRows(props: { count?: number; depth?: number }) {
  const rows = () => Array.from({ length: props.count ?? 5 }, (_, i) => i);
  return (
    <div class="document-list__loading" aria-busy="true" aria-label="Loading documents">
      <For each={rows()}>
        {(i) => (
          <div
            class="document-list-item document-list-item--loading"
            style={{ "--depth": props.depth ?? 0 }}
            aria-hidden="true"
          >
            <span
              class="document-list-item__skeleton"
              style={{ width: SKELETON_WIDTHS[i % SKELETON_WIDTHS.length] }}
            />
          </div>
        )}
      </For>
    </div>
  );
}
