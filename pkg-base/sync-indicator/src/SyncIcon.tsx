interface SyncIconProps {
  size?: number;
  class?: string;
  state?: "synced" | "syncing" | "error" | "unknown";
}

export function SyncIcon(props: SyncIconProps) {
  const s = () => props.size ?? 20;
  const state = () => props.state ?? "synced";

  return (
    <svg
      width={s()}
      height={s()}
      viewBox="0 0 24 24"
      fill="none"
      class={props.class ?? ""}
    >
      <circle
        cx="12"
        cy="12"
        r="8"
        stroke="currentColor"
        stroke-width="2"
        fill="currentColor"
        fill-opacity={state() === "synced" ? 1 : 0}
        style={{
          transition: state() === "synced"
            ? "fill-opacity 0s"
            : "fill-opacity 2s ease-out",
        }}
      />
      {state() === "error" && (
        <circle cx="12" cy="12" r="2.5" fill="currentColor" />
      )}
      {state() === "unknown" && (
        <text
          x="12"
          y="12"
          text-anchor="middle"
          dominant-baseline="central"
          fill="currentColor"
          font-size="11"
          font-weight="bold"
        >
          ?
        </text>
      )}
    </svg>
  );
}
