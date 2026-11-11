import { type JSX, splitProps } from "solid-js";

export interface InputProps extends JSX.InputHTMLAttributes<HTMLInputElement> {}

export function Input(props: InputProps) {
  const [local, rest] = splitProps(props, ["class", "type"]);

  return (
    <input
      type={local.type}
      class={`input${local.class ? " " + local.class : ""}`}
      {...rest}
    />
  );
}
