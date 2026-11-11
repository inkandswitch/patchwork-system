/**
 * `@patchwork/isolation` — tool isolation as a patchwork-base package.
 *
 * The public surface is the `plugins` array (the shape every patchwork module
 * exports). Isolation is delivered as a single `patchwork:component` resolved by
 * id through the registry — the sanctioned cross-package mechanism — so no
 * consumer ever imports this package; they mount it with
 * `<patchwork-view component="patchwork-isolation" …>`. See ./component.ts for
 * the mount contract and the DOM config surface.
 */

import { Plugin } from "@inkandswitch/patchwork-plugins";

export const plugins: Plugin<any>[] = [
  {
    type: "patchwork:component",
    id: "patchwork-isolation",
    name: "Patchwork Isolation",
    // Import `./component.js` lazily inside load(), not at module top level.
    // `index.js` is `import()`ed by the module-settings-manager descriptor
    // worker just to read this `plugins` metadata; that worker has no import
    // map, so a top-level import of component.js (which transitively pulls in
    // @automerge/automerge-repo and the rest of the isolation runtime) fails
    // with "Failed to resolve module specifier @automerge/automerge-repo/slim".
    // Deferring it keeps discovery to metadata only — the runtime imports
    // happen later, when load() runs in a context that has the import map.
    load: async () => (await import("./component.js")).mountIsolation,
  },
];
