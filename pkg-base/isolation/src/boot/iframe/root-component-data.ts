/**
 * The root component's data, inside the iframe. Runs in the sandbox: defined at
 * module scope so tsc checks it, serialized into the srcdoc by ../host/srcdoc.ts,
 * and called from `boot()`.
 *
 * The host relays the root's inputs as an opaque JSON string it never parses
 * (see boot/host/config.ts). Here we materialize that string into an inert
 * `<script type="application/json" data-root-component-data>` child of the root
 * `<patchwork-view>` — data, never executable, so nothing tool-bearing is ever
 * constructed from host-supplied code. The root component reads (and reactively
 * re-reads) that script.
 *
 * Live updates: the host watches its own data `<script>` and sends
 * `root-component-data-update` messages; `handle()` rewrites this script's text
 * in place (no reboot), and the root observes the node and re-reads.
 */

import type { IframeLog } from "./types.js";

export interface RootComponentData {
  /**
   * Create the inert data `<script>` (seeded with `initialData`) and append it
   * to the root view. Call once, before the `<patchwork-view>` connects, so the
   * data is in place before the root's mount fn runs.
   */
  mount(rootView: HTMLElement, initialData: string): void;
  /**
   * Handle an inbound RPC message. Returns true if it was a
   * `root-component-data-update` (and rewrote the script), false otherwise —
   * letting the caller route the message to another consumer.
   */
  handle(event: MessageEvent): boolean;
}

/** Create the iframe-side root-component-data manager. */
export function createRootComponentData(log: IframeLog): RootComponentData {
  let script: HTMLScriptElement | null = null;

  function mount(rootView: HTMLElement, initialData: string) {
    script = document.createElement("script");
    script.type = "application/json";
    script.setAttribute("data-root-component-data", "");
    // Verbatim — the data is already a JSON string from the host; do not
    // re-serialize (the boundary treats it as an opaque blob).
    script.textContent = initialData ?? "{}";
    rootView.appendChild(script);
  }

  function handle(event: MessageEvent): boolean {
    if (event.data?.type !== "root-component-data-update") return false;
    // Inert data, never executed — same trust posture as the boot-time value.
    if (script) {
      script.textContent = event.data.rootComponentData;
      log("root component data updated");
    }
    return true;
  }

  return { mount, handle };
}
