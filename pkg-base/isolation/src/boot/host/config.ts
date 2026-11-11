/**
 * The isolated iframe's config, read directly off the mounted host element (the
 * `<patchwork-view component="patchwork-isolation">`). The element IS the config
 * surface — there is no separate spec object — so these are the reads
 * `bootIsolation` composes, alongside the boot assets, import map, and styles.
 *
 * Structural config lives in attributes; the root component's data rides as an
 * opaque `<script type="application/json" data-root-component-data>` child that
 * the boundary relays verbatim (never parsing).
 */

import type { AutomergeUrl } from "@automerge/automerge-repo/slim";

/** The root `patchwork:component` id to mount inside the iframe. */
export function readRootComponentId(host: HTMLElement): string {
  return host.getAttribute("root-component") ?? "";
}

/** The `automerge-allowlist` attribute, parsed into a URL list (sync seeds). */
export function readAllowlistUrls(host: HTMLElement): AutomergeUrl[] {
  return (host.getAttribute("automerge-allowlist") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as AutomergeUrl[];
}

/**
 * The inert data `<script>`, located by its explicit `data-root-component-data`
 * marker. `:scope >` restricts the match to a direct child, so it never reaches
 * into the iframe `bootIsolation` appends; the marker (rather than a structural
 * `type="application/json"` scan) makes the lookup deterministic even if other
 * inert scripts are present.
 */
export function findRootComponentDataScript(
  host: HTMLElement
): HTMLScriptElement | null {
  return host.querySelector<HTMLScriptElement>(
    ":scope > script[data-root-component-data]"
  );
}

/**
 * The opaque root-component data: the text of the data `<script>`. Never parsed
 * here — relayed verbatim to the iframe, which writes it into the root's own
 * `<script>` for the root to parse. Absent → "{}".
 */
export function readRootComponentData(host: HTMLElement): string {
  return findRootComponentDataScript(host)?.textContent ?? "{}";
}
