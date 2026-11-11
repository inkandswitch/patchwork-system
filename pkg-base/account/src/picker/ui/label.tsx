import { type JSX, splitProps } from "solid-js";

export interface LabelProps extends JSX.LabelHTMLAttributes<HTMLLabelElement> {}

export function Label(props: LabelProps) {
  const [local, rest] = splitProps(props, ["class", "children"]);

  return (
    <label
      class={`label${local.class ? " " + local.class : ""}`}
      {...rest}
    >
      {local.children}
    </label>
  );
}
