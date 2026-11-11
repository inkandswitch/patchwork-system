/**
 * bootIsolation — the host-side boot sequence for one isolated iframe. Given the
 * mounted host element (a `<patchwork-view component="patchwork-isolation">`), it
 * reads all of its config directly off that element and:
 *
 *  1. Fetches boot assets (es-module-shims, WASM, host styles) — cached
 *  2. Gets the shared denylist (singleton, populated once from sensitive docs)
 *  3. Builds the allowlist seeded from the `automerge-allowlist` attribute
 *     (+ transitive content)
 *  4. Creates the intermediary repo gated by allowlist + denylist
 *  5. Starts host-side RPC for plugin loading, navigation, and bridged providers
 *  6. Creates the sandboxed iframe and posts the boot message
 *
 * The element IS the config surface — there is no separate spec object. Reads
 * off `host`:
 *   - `root-component` attribute      → the root `patchwork:component` to mount
 *   - `automerge-allowlist` attribute → sync allowlist seeds (comma-separated)
 *   - `shared-providers` attribute    → bridged providers (via the providers bridge)
 *   - the inert `<script data-root-component-data>` child → opaque root-component data
 *   - nearest `<repo-provider>` ancestor → the host repo
 *
 * It returns an {@link IsolationHandle} synchronously; the async work runs in
 * the background. `teardown()` cancels any in-flight boot and tears down
 * everything wired so far — idempotent, safe at any point. Live changes to the
 * data `<script>` are watched here and streamed to the running iframe (no
 * reboot) via `root-component-data-update` messages.
 *
 * No tool code ever runs in the host: everything read is data, and the iframe
 * resolves/mounts the root component against its own registry.
 */

import type { AutomergeUrl } from "@automerge/automerge-repo/slim";
import type { RepoProviderElement } from "@inkandswitch/patchwork-providers";
import {
  createIntermediaryRepo,
  type IntermediaryRepo,
  PackagesUrlMapper,
  getRegistries,
  startResourceBridge,
  watchRegistries,
  buildAllowlist,
  handleAccessRequest,
  requestBridgedUrlAccess,
  getDenylist,
  allowlistUrlUnlessSensitive,
  startHostNavigationBridge,
  startHostDragDropBridge,
  startHostProvidersBridge,
  resolveBridgedProviders,
  makeBridgedValueFilter,
  startHostOpenToolBridge,
  resolveSharedTools,
} from "../../bridges/index.js";
import { generateIframeSrcdoc } from "./srcdoc.js";
import { log } from "../../log.js";
import { fetchBootAssets } from "./assets.js";
import { readHostAppearance } from "./styles.js";
import { getResolvedImportMap } from "./import-map.js";
import {
  readRootComponentId,
  readAllowlistUrls,
  readRootComponentData,
  findRootComponentDataScript,
} from "./config.js";

export interface IsolationHandle {
  /**
   * Cancel any in-flight boot and tear down everything wired so far (bridges,
   * intermediary repo, iframe, the root-component-data observer). Idempotent.
   *
   * Live data updates are handled internally: `bootIsolation` watches the data
   * `<script>` and streams changes to the running iframe with no reboot, so the
   * caller drives everything by mutating the host element's DOM — attributes to
   * reboot, the data `<script>` text to update in place.
   */
  teardown(): void;
}

/** The host repo comes from the nearest `<repo-provider>` ancestor of `host`. */
function getRepo(host: HTMLElement) {
  const repoProvider = host.closest<RepoProviderElement>("repo-provider");
  const repo = repoProvider?.repo;
  if (!repo) log("no <repo-provider> ancestor found");
  return repo;
}

export function bootIsolation(host: HTMLElement): IsolationHandle {
  // Cancellation: teardown (or a reconfigure that tears this down) flips this,
  // and every async step re-checks it after an await and bails before mutating
  // more state — a stale boot can't keep running.
  let cancelled = false;
  const stale = () => cancelled;

  // Snapshot the structural config at boot time. (The root-component data is
  // read lazily — on the initial boot message and on each push — so it is never
  // captured here.)
  const rootComponentId = readRootComponentId(host);
  const rootUrls = readAllowlistUrls(host);

  // State wired up during the boot, torn down together. All start empty, so
  // teardown() before/during boot is a safe no-op over them.
  const cleanups: Array<() => void> = [];
  let hostRpcPort: MessagePort | null = null;
  let intermediary: IntermediaryRepo | null = null;
  let iframe: HTMLIFrameElement | null = null;

  async function run() {
    log(`init root "${rootComponentId}" with ${rootUrls.length} root URLs`);

    const repo = getRepo(host);
    if (!repo) return;

    let assets;
    try {
      assets = await fetchBootAssets();
    } catch (err) {
      console.error("[patchwork-isolation] failed to load boot assets:", err);
      return;
    }
    if (stale()) return;

    const importMap = getResolvedImportMap();
    const mapper = new PackagesUrlMapper();

    // ── Access control ──────────────────────────────────────
    // Wait for the denylist to finish populating before seeding the allowlist
    // or creating the intermediary repo. Otherwise a protected doc that appears
    // in root content could be allowlisted/synced during the population window
    // (the denylist is built asynchronously).
    const denylist = getDenylist(repo);
    await denylist.whenReady();
    if (stale()) return;

    const allowlist = await buildAllowlist(repo, rootUrls, denylist, stale);
    if (stale()) return;

    intermediary = createIntermediaryRepo({
      allowlist,
      hostRepo: repo,
      denylist,
      onAccessRequest: (documentId) =>
        handleAccessRequest(repo, rootUrls, allowlist, denylist, documentId),
    });

    log("intermediary repo and allowlist ready");

    // ── Bridged providers ────────────────────────────────────
    // The effective set for this instance: shared-providers ∩ ALLOWED_PROVIDERS
    // (see providers-bridge).
    const bridgedProviders = resolveBridgedProviders(host);

    // shared-tools ∩ ALLOWED_OPEN_TOOLS (see open-tool-bridge).
    const sharedTools = resolveSharedTools(host);

    // The bridge filters URLs in bridged values against the allowlist; the
    // silent-vs-prompt policy per provider type lives in the bridge.
    const bridgedValueFilter = makeBridgedValueFilter({
      isAllowed: (url) => allowlist.hasUrl(url as AutomergeUrl),
      requestAccess: (url) =>
        requestBridgedUrlAccess(
          repo,
          rootUrls,
          allowlist,
          denylist,
          url as AutomergeUrl
        ),
    });

    // ── Host-side RPC ───────────────────────────────────────
    const rpcChannel = new MessageChannel();
    hostRpcPort = rpcChannel.port1;

    cleanups.push(
      startResourceBridge({ port: hostRpcPort, mapper }),
      startHostNavigationBridge(hostRpcPort, host, (url) =>
        allowlist.hasUrl(url)
      ),
      // Drag-and-drop INTO the iframe (host → iframe). Unlike navigation, this
      // discloses document URLs to untrusted tool code, so each dragged URL is
      // gated: denylist-checked, then allowlisted (silently — the drag is the
      // user's authorization). Denylisted URLs are withheld. The iframe element
      // is fetched lazily; it exists by the time any drop can occur.
      startHostDragDropBridge(
        hostRpcPort,
        () => iframe,
        (url) => allowlistUrlUnlessSensitive(repo, url, allowlist, denylist)
      ),
      startHostProvidersBridge(
        hostRpcPort,
        host,
        bridgedProviders,
        bridgedValueFilter
      ),
      // Lets an isolated tool open a host tool, like the LLM config tray.
      startHostOpenToolBridge(hostRpcPort, host, sharedTools),
      watchRegistries(hostRpcPort, mapper)
    );

    // ── Iframe ──────────────────────────────────────────────
    createIframe(rpcChannel.port2, intermediary.iframePort, mapper, assets, {
      rootComponentId,
      importMap,
      bridgedProviders,
    });
  }

  function createIframe(
    rpcPort: MessagePort,
    syncPort: MessagePort,
    mapper: PackagesUrlMapper,
    assets: Awaited<ReturnType<typeof fetchBootAssets>>,
    config: {
      rootComponentId: string;
      importMap: ReturnType<typeof getResolvedImportMap>;
      bridgedProviders: string[];
    }
  ) {
    const el = document.createElement("iframe");
    el.sandbox.add("allow-scripts");
    el.style.cssText =
      "border: none; width: 100%; height: 100%; display: block;";
    // Bake the host's current background + color-scheme into the srcdoc so the
    // iframe's first paint matches the host (no flash of white before the
    // theming tool boots inside). Read tool-agnostically off the live element —
    // `host` is still connected, so its ancestors carry the host background.
    el.srcdoc = generateIframeSrcdoc(readHostAppearance(host));
    iframe = el;

    el.addEventListener("load", async () => {
      if (stale() || !el.contentWindow) return;
      log("iframe ready");

      const registryEntries = await getRegistries(mapper);
      if (stale() || !el.contentWindow) return;

      const automergeWasm = assets.automergeWasm.slice(0);
      const subductionWasm = assets.subductionWasm.slice(0);

      log(
        `sending boot message with ${registryEntries.length} registry entries, root "${config.rootComponentId}"`
      );
      el.contentWindow.postMessage(
        {
          type: "boot",
          rootComponentId: config.rootComponentId,
          // Read the data fresh at send time (not a boot-start snapshot): a
          // change between boot start and this async send is reflected in the
          // initial boot rather than lost, since a pre-port push no-ops.
          rootComponentData: readRootComponentData(host),
          registryEntries,
          // The iframe only claims these, so other selectors can still reach a
          // provider inside the iframe.
          bridgedProviders: config.bridgedProviders,
          esmsSource: assets.esmsSource,
          hostStyles: assets.hostStyles,
          importMap: config.importMap,
          hostOrigin: window.location.origin,
          automergeWasm,
          subductionWasm,
        },
        "*",
        [rpcPort, syncPort, automergeWasm, subductionWasm]
      );
    });

    const onBootMessage = (event: MessageEvent) => {
      if (event.data?.type === "boot-error") {
        console.error(
          "[patchwork-isolation] iframe boot failed:",
          event.data.error
        );
      }
    };
    hostRpcPort!.addEventListener("message", onBootMessage);
    cleanups.push(() =>
      hostRpcPort?.removeEventListener("message", onBootMessage)
    );

    host.appendChild(el);
  }

  let toreDown = false;
  function teardown() {
    if (toreDown) return;
    toreDown = true;
    cancelled = true;
    log("teardown");

    for (const fn of cleanups) fn();
    cleanups.length = 0;

    hostRpcPort?.close();
    hostRpcPort = null;

    intermediary?.shutdown();
    intermediary = null;

    iframe?.remove();
    iframe = null;
  }

  // Push the current root-component data to the running iframe (no reboot).
  // No-op if torn down or the RPC port isn't wired yet — the boot is still in
  // flight and its boot message reads the data fresh at send time, so the latest
  // is delivered regardless. (We don't buffer here — a stale in-flight push would
  // race the boot message.)
  function pushRootComponentData() {
    if (toreDown || !hostRpcPort) return;
    hostRpcPort.postMessage({
      type: "root-component-data-update",
      rootComponentData: readRootComponentData(host),
    });
  }

  // Watch the data <script> for changes and stream them to the iframe. Scoped
  // to the script node itself (not `host`, whose children include the appended
  // iframe): `characterData` catches an in-place text edit, `childList` a
  // text-node swap, and `subtree` extends both to the script's text node —
  // together, "the JSON changed, however the consumer applied it." Debounced so
  // one render touching the text pushes once. Torn down with the rest.
  const dataScript = findRootComponentDataScript(host);
  if (dataScript) {
    let pushQueued = false;
    const dataObserver = new MutationObserver(() => {
      if (pushQueued) return;
      pushQueued = true;
      queueMicrotask(() => {
        pushQueued = false;
        log("root component data changed; pushing to iframe");
        pushRootComponentData();
      });
    });
    dataObserver.observe(dataScript, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    cleanups.push(() => dataObserver.disconnect());
  }

  void run();
  return { teardown };
}
