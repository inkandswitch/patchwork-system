import { For, Show } from "solid-js";
import { USER_COLOR_PALETTE, parseHslColor } from "../../user-colors";

interface ColorPopupProps {
  value?: string;
  onChange: (color: string) => void;
  onClose: () => void;
  ref?: (el: HTMLDivElement) => void;
}

function hslToHex(hsl: string): string {
  const parsed = parseHslColor(hsl);
  if (!parsed) return "#3b82f6";
  const { h, s, l } = parsed;
  const hN = h / 360;
  const sN = s / 100;
  const lN = l / 100;

  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  let r: number, g: number, b: number;
  if (sN === 0) {
    r = g = b = lN;
  } else {
    const q =
      lN < 0.5 ? lN * (1 + sN) : lN + sN - lN * sN;
    const p = 2 * lN - q;
    r = hue2rgb(p, q, hN + 1 / 3);
    g = hue2rgb(p, q, hN);
    b = hue2rgb(p, q, hN - 1 / 3);
  }

  const hex = (c: number) =>
    Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export function ColorPopup(props: ColorPopupProps) {
  const currentColor = () => props.value || USER_COLOR_PALETTE[0].value;

  const inputValue = () => {
    const v = currentColor();
    return v.startsWith("#") ? v : hslToHex(v);
  };

  return (
    <div class="color-popup" ref={props.ref}>
      <div class="color-grid">
        <For each={[...USER_COLOR_PALETTE]}>
          {(color) => (
            <button
              type="button"
              class={`color-swatch${props.value === color.value ? " selected" : ""}`}
              style={{ "background-color": color.value }}
              onClick={() => {
                props.onChange(color.value);
                props.onClose();
              }}
              title={color.name}
            >
              <Show when={props.value === color.value}>
                <svg
                  class="icon-check"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="3"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </Show>
            </button>
          )}
        </For>
        <label class="color-swatch color-swatch-custom" title="Custom color">
          <input
            type="color"
            value={inputValue()}
            onInput={(e) => props.onChange(e.currentTarget.value)}
          />
        </label>
      </div>
    </div>
  );
}
