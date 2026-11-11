import { Show } from "solid-js";

export interface DocHistoryHeaderProps {
  title?: string;
  onRecompute: () => void;
  isRecalculating?: boolean;
}

export function DocHistoryHeader(props: DocHistoryHeaderProps) {
  return (
    <div class="history-header">
      <div style={{ display: "flex", "flex-direction": "column", "min-width": "0" }}>
        <div class="history-header-title">Version History</div>
        <Show when={props.title !== undefined}>
          <div style={{ "font-size": "10px", color: "var(--history-muted-fg)", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", "margin-top": "2px" }}>{props.title}</div>
        </Show>
      </div>

      <div class="history-header-actions">
        <button
          style={{ background: "none", border: "none", cursor: "var(--studio-cursor-pointer, pointer)", padding: "4px", "border-radius": "4px", display: "flex", "align-items": "center", "justify-content": "center" }}
          disabled={props.isRecalculating}
          title={props.isRecalculating ? "Recalculating history..." : "Recompute"}
          onClick={(e) => { e.stopPropagation(); props.onRecompute(); }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            style={props.isRecalculating ? { animation: "spin 1s linear infinite reverse" } : {}}
          >
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
          </svg>
        </button>
      </div>
    </div>
  );
}
