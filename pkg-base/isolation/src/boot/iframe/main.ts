/**
 * The isolated iframe's runtime — the code that runs *inside* the sandbox.
 *
 * `boot` and its injected helpers (`installLocalStorageStub`, `installFetchProxy`,
 * `installLinkInterception`) are written as typed functions so tsc checks them,
 * but they never execute in the host: `../host/srcdoc.ts` serializes each with
 * `.toString()` into the iframe's srcdoc `<script>`. Because the iframe has no
 * module system until es-module-shims loads (step 5), everything the iframe needs
 * at boot must live in these functions; the helpers are passed into `boot()`
 * rather than closed over, since `.toString()` can't capture surrounding scope.
 */

// RegistryEntry is a host↔iframe wire type — see ../../types.ts.
import type { RegistryEntry } from "../../types.js";
export type { RegistryEntry };

// The injected iframe code (each concern in its own ./*.ts, serialized into the
// srcdoc by ../host/srcdoc.ts). Imported as types only: boot() receives these
// via `deps` at runtime and never references the module bindings directly.
import type { installLocalStorageStub } from "./local-storage.js";
import type { installFetchProxy } from "./fetch-proxy.js";
import type { installLinkInterception } from "./link-interception.js";
import type { createRpcClient, RpcClient } from "./rpc.js";
import type {
  createProvidersBridge,
  ProvidersBridge,
} from "./providers-bridge.js";
import type { setupEsModuleShims } from "./es-module-shims.js";
import type { createRegistry, Registry } from "./registry.js";
import type {
  createRootComponentData,
  RootComponentData,
} from "./root-component-data.js";
import type { createDragDrop, DragDrop } from "./drag-drop.js";

// ---------------------------------------------------------------------------
// Type declarations for runtime globals available inside the iframe.
// ---------------------------------------------------------------------------

interface InitMessage {
  rpcPort: MessagePort;
  syncPort: MessagePort;
  data: {
    rootComponentId: string;
    /**
     * Opaque JSON data for the root component, relayed verbatim from the host
     * (the boundary never parses it). Materialized as-is into the root's inert
     * `<script type="application/json" data-root-component-data>`; the root
     * parses + re-reads it. Live changes arrive later as
     * `root-component-data-update` RPC messages.
     */
    rootComponentData: string;
    registryEntries: RegistryEntry[];
    esmsSource: string;
    hostStyles: string;
    importMap: { imports?: Record<string, string>; scopes?: any };
    hostOrigin: string;
    automergeWasm: ArrayBuffer;
    subductionWasm: ArrayBuffer;
  };
}

/**
 * The iframe code injected into `boot()`. Each lives at module scope (./helpers.ts,
 * ./rpc.ts) so tsc checks it, and is serialized into the srcdoc by
 * ../host/srcdoc.ts; `boot()` receives them here since `.toString()` can't
 * capture surrounding scope.
 */
interface BootDeps {
  installLocalStorageStub: typeof installLocalStorageStub;
  installFetchProxy: typeof installFetchProxy;
  installLinkInterception: typeof installLinkInterception;
  createRpcClient: typeof createRpcClient;
  createProvidersBridge: typeof createProvidersBridge;
  setupEsModuleShims: typeof setupEsModuleShims;
  createRegistry: typeof createRegistry;
  createRootComponentData: typeof createRootComponentData;
  createDragDrop: typeof createDragDrop;
}

// ---------------------------------------------------------------------------
// Boot function — runs inside the iframe via boot.toString() + IIFE.
// ---------------------------------------------------------------------------

export async function boot(deps: BootDeps) {
  const {
    installLocalStorageStub,
    installFetchProxy,
    installLinkInterception,
    createRpcClient,
    createProvidersBridge,
    setupEsModuleShims,
    createRegistry,
    createRootComponentData,
    createDragDrop,
  } = deps;
  // Minimal debug-compatible logger. The real `debug` package isn't available
  // until modules load, but we need logging during bootstrap.
  // Respects the same localStorage("debug") namespace convention.
  const NAMESPACE = "patchwork:elements:isolation:iframe";
  const peerId = "isolation-" + crypto.randomUUID().slice(0, 8);
  let debugEnabled = false;
  const log = (...args: unknown[]) => {
    if (!debugEnabled) return;
    console.debug(`%c${NAMESPACE}`, "color: #7c3aed", ...args);
  };

  // 1. Stub localStorage (no-op in-memory; see the injected helper), then
  // evaluate the debug flag now that localStorage is available.
  installLocalStorageStub();
  {
    const pattern = localStorage.getItem("debug") || "";
    if (pattern) {
      const re = new RegExp(
        "^" +
          pattern
            .split(",")
            .map((p: string) => p.trim().replace(/\*/g, ".*?"))
            .join("$|^") +
          "$"
      );
      debugEnabled = re.test(NAMESPACE);
    }
  }

  // Tag all debug-package output from inside the iframe
  const _originalConsoleDebug = console.debug;
  console.debug = (...args: any[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("%c")) {
      args[0] = `[${peerId}] ` + args[0];
    }
    _originalConsoleDebug.apply(console, args);
  };

  // 2. Declare the RPC port and its inbound-message consumers.
  // The RPC client (fetch req-reply), providers bridge, and plugin registry each
  // own their own state; see ./rpc.ts, ./providers-bridge.ts, ./registry.ts. The
  // port itself is owned here because it fans messages out to all three. They're
  // created once the port arrives (step 4).
  let rpcPort: MessagePort;
  let rpc: RpcClient;
  let providers: ProvidersBridge;
  let registry: Registry;
  let rootComponentData: RootComponentData;
  let dragDrop: DragDrop;

  // Route an inbound RPC message to whichever consumer owns it.
  function handleRpcMessage(event: MessageEvent) {
    if (rpc.handle(event)) return;
    if (providers.handle(event)) return;
    if (registry.handle(event)) return;
    if (rootComponentData.handle(event)) return;
    if (dragDrop.handle(event)) return;
  }

  // 3. Wait for the init ("boot") message from the host.
  const init: InitMessage = await new Promise((resolve) => {
    window.addEventListener("message", function handler(event: MessageEvent) {
      if (!event.data || event.data.type !== "boot") return;
      window.removeEventListener("message", handler);
      resolve({
        rpcPort: event.ports[0],
        syncPort: event.ports[1],
        data: event.data,
      });
    });
  });

  // 4. Create the message consumers and start routing the RPC port.
  rpcPort = init.rpcPort;
  rpc = createRpcClient(rpcPort);
  providers = createProvidersBridge(
    rpcPort,
    log,
    (init.data as {bridgedProviders?: string[]}).bridgedProviders ?? []
  );
  registry = createRegistry(log);
  rootComponentData = createRootComponentData(log);
  dragDrop = createDragDrop(log);
  rpcPort.addEventListener("message", handleRpcMessage);
  rpcPort.start();

  // 5. Navigation bridge: forward patchwork:open-document events to host.
  // We do NOT stopPropagation — the event still bubbles within the iframe
  // so that providers (e.g. SelectedDocProvider) inside the iframe can
  // observe it. The host's SelectedDocProvider deduplicates by URL, so
  // forwarding the same selection back is a no-op.
  //
  // This listener (like the RPC and patchwork:subscribe listeners) is never
  // removed: it is bound to the iframe's own document and lives for the
  // iframe's whole lifetime. The host tears the iframe down wholesale, so
  // there is nothing to clean up.
  document.addEventListener(
    "patchwork:open-document",
    ((event: CustomEvent) => {
      rpcPort.postMessage({ type: "open-document", detail: event.detail });
    }) as EventListener,
    true
  );

  // Forward patchwork:open-tool to the host, which checks it against
  // shared-tools (see open-tool-bridge).
  document.addEventListener(
    "patchwork:open-tool",
    ((event: CustomEvent) => {
      rpcPort.postMessage({ type: "open-tool", detail: event.detail });
    }) as EventListener,
    true
  );

  const d = init.data;
  log("init", { root: d.rootComponentId });

  // 6. Inject host page stylesheets so tools render with the same CSS
  // framework (Tailwind, DaisyUI, etc.) as on the host.
  if (d.hostStyles) {
    const style = document.createElement("style");
    style.textContent = d.hostStyles;
    document.head.appendChild(style);
  }

  try {
    // 7. Stand up es-module-shims (source hook → RPC, import map). All module
    // loading below goes through the returned importShim. See ./es-module-shims.ts.
    const importShim = await setupEsModuleShims({
      esmsSource: d.esmsSource,
      importMap: d.importMap,
      fetchModule: rpc.fetchModule,
      log,
    });

    // 8. Import core runtime modules
    const [
      automerge,
      automergeSubduction,
      automergeRepo,
      messagechannel,
      patchworkElements,
      patchworkPlugins,
      patchworkProviders,
    ] = await Promise.all([
      importShim("@automerge/automerge/slim"),
      importShim("@automerge/automerge-subduction/slim"),
      importShim("@automerge/automerge-repo/slim"),
      importShim("@automerge/automerge-repo-network-messagechannel"),
      importShim("@inkandswitch/patchwork-elements"),
      importShim("@inkandswitch/patchwork-plugins"),
      importShim("@inkandswitch/patchwork-providers"),
    ]);

    log("modules loaded");

    // 9. Initialize WASM from transferred ArrayBuffers
    automergeSubduction.initSync(new Uint8Array(d.subductionWasm));
    await automerge.initializeWasm(new Uint8Array(d.automergeWasm));
    log("wasm initialized");

    // 10. Route host-origin fetches through RPC, and intercept host-origin
    // <link> insertions that would bypass that proxy. See ./fetch-proxy.ts and
    // ./link-interception.ts. Order matters: link interception fetches through
    // the patched proxy.
    const hostOrigin = d.hostOrigin;
    installFetchProxy(hostOrigin, rpc.fetchResource, log);
    installLinkInterception(hostOrigin, log);

    // 11. Create in-memory Repo
    const syncAdapter = new messagechannel.MessageChannelNetworkAdapter(
      init.syncPort
    );
    const repo = new automergeRepo.Repo({
      peerId: peerId,
      network: [syncAdapter],
    });
    (window as any).repo = repo;
    log("repo connected");

    // 12. Register the patchwork-view and repo-provider custom elements, then
    // create the root <repo-provider> wrapper — mirrors the host bootloader
    // pattern. It answers `repo:handle-descriptor` subscriptions so
    // OverlayRepo.find() doesn't hang.
    patchworkElements.registerPatchworkViewElement({ repo });
    patchworkProviders.registerRepoProviderElement(repo);
    const repoProvider = document.createElement("repo-provider");
    document.body.appendChild(repoProvider);

    // 13. Register plugins (initial set + drain any queued live pushes, then go
    // live). Now that importShim + the plugins module exist, hand them to the
    // registry created above. See ./registry.ts.
    registry.start(importShim, patchworkPlugins, d.registryEntries);

    // 14. Mount the isolated root component.
    // The root is an ordinary patchwork:component named by the boot spec; the
    // normal <patchwork-view component=...> path resolves and mounts it from the
    // iframe's own registry (incl. the not-yet-loaded and hot-reload cases). Its
    // data travels as an inert <script> child (created by rootComponentData.mount)
    // — data, never executable, so nothing tool-bearing is ever constructed from
    // host-supplied content. It is appended before the <patchwork-view> connects,
    // and patchwork-view defers its render by a microtask, so the data is in
    // place before the root's mount fn runs. Later changes arrive as
    // `root-component-data-update` messages (see handleRpcMessage / the
    // rootComponentData helper); the root re-reads reactively without a reboot.
    const rootView = document.createElement("patchwork-view");
    rootView.setAttribute("component", d.rootComponentId);
    rootComponentData.mount(rootView, d.rootComponentData ?? "{}");
    repoProvider.appendChild(rootView);

    // 15. Providers bridge — forward unclaimed patchwork:subscribe events to
    // the host so host-side providers can answer them (see ./providers-bridge.ts).
    // Worker connections (`patchwork:worker-channel`) go through here too.
    providers.install();

    log(`boot complete — root "${d.rootComponentId}"`);
    rpcPort.postMessage({ type: "boot-complete" });
  } catch (err: any) {
    console.error("[iframe] boot failed:", err);
    document.body.textContent = "Failed to load tool: " + (err.message || err);
    rpcPort.postMessage({ type: "boot-error", error: String(err) });
  }
}
