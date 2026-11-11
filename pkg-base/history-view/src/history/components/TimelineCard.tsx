import type { JSXElement } from "solid-js";

export interface TimelineCardProps {
  isSelected: boolean;
  onClick: (e: MouseEvent) => void;
  children: JSXElement;
}

/**
 * Card wrapper providing timeline dot, connecting line,
 * selected/unselected styling, and accessibility attributes.
 */
export function TimelineCard(props: TimelineCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-selected={props.isSelected}
      data-selected={props.isSelected ? "" : undefined}
      onClick={(e) => { e.stopPropagation(); props.onClick(e); }}
      class="timeline-card"
      style={{
        "font-size": "0.75rem",
        cursor: "var(--studio-cursor-pointer, pointer)",
        ...(props.isSelected
          ? { background: "var(--history-accent)", "border-color": "var(--history-accent)", color: "var(--history-accent-fg)" }
          : {})
      }}
    >
      {props.children}
    </div>
  );
}
