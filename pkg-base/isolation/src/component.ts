import type { ComponentRender } from "@inkandswitch/patchwork-elements";
import { bootIsolation, type IsolationHandle } from "./boot/index.js";
import { log } from "./log.js";

/**
 * The isolation `patchwork:component` mount function.
 *
 * Cross-package units are resolved through the registry by id, never imported,
 * so isolation ships as a `patchwork:component` (`patchwork-isolation`). The
 * consumer mounts it with `<patchwork-view component="patchwork-isolation">` and
 * puts all the config on that element's DOM surface:
 *
 *   <patchwork-view
 *     component="patchwork-isolation"
 *     root-component="threepane-isolation-root"     // which root to mount inside the iframe
 *     automerge-allowlist="automerge:abc,automerge:def" // sync allowlist seeds
 *     shared-providers="patchwork:contact,...">         // bridged providers
 *     <script type="application/json" data-root-component-data> // opaque root-component data
 *       {...}
 *     </script>
 *   </patchwork-view>
 *
 * `bootIsolation(element)` reads all of that off the element directly (plus the
 * `<repo-provider>` ancestor) and appends the iframe to it. It also watches the props `<script>`
 * internally and streams prop changes to the running iframe with no reboot.
 *
 * So this mount fn's only added responsibility is **structural** changes: it
 * observes `root-component` / `automerge-allowlist` / `shared-providers` and
 * **reboots** the iframe when one changes (`patchwork-view` doesn't observe
 * those attributes, so nothing else would).
 */
export const mountIsolation: ComponentRender = (element) => {
  let handle: IsolationHandle | null = bootIsolation(element);

  let rebootQueued = false;
  const attrObserver = new MutationObserver(() => {
    if (rebootQueued) return;
    rebootQueued = true;
    queueMicrotask(() => {
      rebootQueued = false;
      log("config attribute changed; rebooting iframe");
      handle?.teardown();
      handle = bootIsolation(element);
    });
  });
  attrObserver.observe(element, {
    attributes: true,
    attributeFilter: [
      "root-component",
      "automerge-allowlist",
      "shared-providers",
      "shared-tools",
    ],
  });

  return () => {
    attrObserver.disconnect();
    handle?.teardown();
    handle = null;
  };
};
