import { type JSX, splitProps } from "solid-js";

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "secondary" | "ghost" | "outline" | "destructive" | "link";
}

export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, [
    "class",
    "variant",
    "children",
  ]);

  const variant = () => local.variant ?? "default";

  return (
    <button
      class={`btn ${variant()}${local.class ? " " + local.class : ""}`}
      {...rest}
    >
      {local.children}
    </button>
  );
}
