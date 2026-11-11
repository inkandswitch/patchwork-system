// tldraw wants an explicit "light" | "dark". Take it from the CSS context
// rather than from the OS: Patchwork themes declare `color-scheme`, and that
// property inherits, so its computed value on our element is whatever the
// closest theme says. A theme that names both (`light dark`) or names nothing
// is deferring to the OS, so we do too.

import { useEffect, useState } from "react";

export type ColorScheme = "light" | "dark";

function prefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveColorScheme(element: HTMLElement): ColorScheme {
  const scheme = getComputedStyle(element).colorScheme;
  const dark = /\bdark\b/.test(scheme);
  const light = /\blight\b/.test(scheme);
  if (dark && !light) return "dark";
  if (light && !dark) return "light";
  return prefersDark() ? "dark" : "light";
}

export function useColorScheme(element: HTMLElement): ColorScheme {
  const [scheme, setScheme] = useState<ColorScheme>(() =>
    resolveColorScheme(element)
  );

  useEffect(() => {
    const update = () => setScheme(resolveColorScheme(element));
    update();

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);

    // Switching themes swaps stylesheets and sets an attribute on <html>;
    // neither fires an event, so watch for both.
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true });
    observer.observe(document.head, { childList: true, subtree: true });

    return () => {
      media.removeEventListener("change", update);
      observer.disconnect();
    };
  }, [element]);

  return scheme;
}
