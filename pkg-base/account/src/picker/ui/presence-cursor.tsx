import { type JSX, splitProps } from "solid-js";

interface PresenceCursorProps
  extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  color: string;
  name: string;
}

export function PresenceCursor(props: PresenceCursorProps) {
  const [local, rest] = splitProps(props, ["color", "name"]);

  return (
    <button type="button" class="presence-cursor" {...rest}>
      <svg class="presence-cursor-arrow" viewBox="11 7 14 21">
        <g fill="#fff">
          <path d="m12 24.4219v-16.015l11.591 11.619h-6.781l-.411.124z" />
          <path d="m21.0845 25.0962-3.605 1.535-4.682-11.089 3.686-1.553z" />
        </g>
        <g fill={local.color}>
          <path d="m13 10.814v11.188l2.969-2.866.428-.139h4.768z" />
          <path d="m19.751 24.4155-1.844.774-3.1-7.374 1.841-.775z" />
        </g>
      </svg>
      <span class="presence-nametag" style={{ "background-color": local.color }}>
        {local.name}
      </span>
    </button>
  );
}
