import { Show, createSignal } from "solid-js";

export interface CopyHashButtonProps {
  hash: string;
}

/**
 * Button that displays a truncated hash and copies the full hash on click.
 * Shows a checkmark icon briefly after copying.
 */
export function CopyHashButton(props: CopyHashButtonProps) {
  const [copied, setCopied] = createSignal(false);

  const copyHash = (e: MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(props.hash);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      class="history-copy-btn"
      style={{ "margin-left": "0.5rem", "flex-shrink": "0" }}
      onClick={copyHash}
      title="Click to copy full hash"
    >
      <span>{props.hash.slice(0, 8)}</span>
      <Show
        when={copied()}
        fallback={
          <svg
            style={{ width: "12px", height: "12px" }}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
            />
          </svg>
        }
      >
        <svg
          style={{ width: "12px", height: "12px", color: "var(--history-addition)" }}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M5 13l4 4L19 7"
          />
        </svg>
      </Show>
    </div>
  );
}
