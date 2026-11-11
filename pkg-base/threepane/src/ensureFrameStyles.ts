// Imported as a string (not a side-effect import) so the stylesheet is only
// injected when the frame tool actually activates — not when index.js loads.
// esbuild's `.css` text loader (esbuild/options.ts) returns the CSS source.
import frameStyles from "./styles.css";

/**
 * Inject the threepane stylesheet into the current realm's document, once.
 *
 * Called from both realms: host-side by `PatchworkFrame`, and inside the isolated iframe by
 * `IsolationRoot`.
 */
export function ensureFrameStyles() {
  const id = "patchwork-frame-styles";
  const existing = document.getElementById(id);
  if (existing) {
    // Already injected in this realm. Refresh its contents if the bundled CSS
    // has changed (a remount after a rebuild) so a stale stylesheet from an
    // earlier mount can't shadow newer rules; otherwise leave it untouched.
    if (existing.textContent !== frameStyles) existing.textContent = frameStyles;
    return;
  }
  const el = document.createElement("style");
  el.id = id;
  el.textContent = frameStyles;
  document.head.append(el);
}
