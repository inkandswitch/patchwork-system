import type { JSX } from "solid-js";

interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "ghost";
  size?: "default" | "sm";
}

export function Button(props: ButtonProps) {
  return (
    <button
      {...props}
      class={`sync-copy-btn ${props.class ?? ""}`}
    >
      {props.children}
    </button>
  );
}
