/**
 * Placeholder shown while the history document is being created for the first
 * time (or is still loading). Lives in the same flex slot as the item list so
 * the surrounding layout doesn't jump when it swaps out.
 */
export function HistoryComputingIndicator() {
  return (
    <div
      class="history-computing"
      style={{ flex: "1", "min-height": "0", "flex-direction": "column", "align-items": "center", "justify-content": "center", padding: "2.5rem 1.5rem", "text-align": "center" }}
      role="status"
      aria-live="polite"
    >
      <div style={{ "font-size": "0.875rem" }}>Computing history...</div>
    </div>
  );
}
