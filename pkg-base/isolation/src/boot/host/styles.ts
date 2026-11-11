/**
 * Reads the live host page's current visual state so the iframe can match it.
 * Two reads, both host-side and both tool-agnostic:
 *  - `readHostAppearance` — the resolved background + color-scheme, baked into
 *    the iframe's srcdoc so its first paint matches (no flash of white before
 *    the theming tool boots inside).
 *  - `collectHostStyles` — the host's stylesheets as one CSS string, injected
 *    into the iframe so tools render with the same CSS framework as the host.
 */

/**
 * The host's current appearance, read off the live page so the iframe can match
 * it from its very first paint (avoiding a flash of unstyled white before the
 * theming tool boots inside the iframe).
 *
 * Both values are read tool-agnostically — as *resolved* browser values, not
 * via any theming tool's CSS variables, attribute conventions, or palette. The
 * platform must not depend on which theming tool (if any) is installed:
 *  - `background` is the host's actual painted background, found by walking up
 *    from the isolation element to the first ancestor with a non-transparent
 *    computed `backgroundColor` (whatever produced it). Empty if none.
 *  - `colorScheme` is the resolved `color-scheme` (a CSS standard property) so
 *    the iframe's scrollbars/form controls match. Empty if unset.
 *
 * The real theme is applied to the iframe's content later, when the theming
 * tool boots inside it; this only paints the first frame so it doesn't flash.
 */
export interface HostAppearance {
  background: string;
  colorScheme: string;
}

export function readHostAppearance(el: Element): HostAppearance {
  // Walk ancestors for the first real (non-transparent) background. The visible
  // backdrop behind the iframe is painted by some ancestor (e.g. a frame
  // container); we mirror its resolved color without knowing which element or
  // how it was themed.
  let background = "";
  for (let node: Element | null = el; node; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== "transparent" && !bg.startsWith("rgba(0, 0, 0, 0)")) {
      background = bg;
      break;
    }
  }

  const colorScheme = getComputedStyle(document.documentElement).colorScheme;
  return {
    background,
    // "normal" is the unset default — don't emit it.
    colorScheme: colorScheme && colorScheme !== "normal" ? colorScheme : "",
  };
}

/** Collect all host page stylesheets as a single CSS string. */
export async function collectHostStyles(): Promise<string> {
  const sheets = await Promise.all(
    Array.from(document.styleSheets).map(async (sheet) => {
      try {
        return Array.from(sheet.cssRules)
          .map((r) => r.cssText)
          .join("\n");
      } catch {
        if (sheet.href) {
          try {
            return await fetch(sheet.href).then((r) => r.text());
          } catch {
            return "";
          }
        }
        return "";
      }
    })
  );
  return sheets.filter(Boolean).join("\n");
}
