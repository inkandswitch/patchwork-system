import type { JSXElement } from "solid-js";

export interface LabeledFieldProps {
  label: string;
  children: JSXElement;
}

/**
 * Renders a labeled field with a small uppercase label and content below.
 */
export function LabeledField(props: LabeledFieldProps) {
  return (
    <div class="history-labeled-field">
      <div class="history-labeled-field-label">
        {props.label}
      </div>
      <div style={{ "font-size": "0.875rem", color: "var(--history-fg)" }}>{props.children}</div>
    </div>
  );
}
