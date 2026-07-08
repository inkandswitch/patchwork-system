/**
 * High-level browser-app boot sequence for a Patchwork site.
 *
 * Layers on top of {@link setupServiceWorker} (the package default export) to
 * construct the Repo, wire up the automerge-worker port, load plugins via the
 * ModuleWatcher, resolve the user's account document, and hand control to the
 * configured root tool.
 *
 * This entry point pulls in DOM- and plugin-layer dependencies (patchwork
 * elements, plugins, filesystem) and is intended for use only from a browser
 * site's `main.ts`. Non-UI consumers should import the package default (which
 * only does SW registration and the automerge-worker handoff).
 */
import {
  type DocHandle,
  initializeWasm,
  isValidAutomergeUrl,
  isValidDocumentId,
  MessageChannelNetworkAdapter,
  Repo,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocumentId,
} from "@automerge/vanillajs/slim";
import { IndexedDBWorkerStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb/IndexedDBWorkerStorageAdapter";
import * as Automerge from "@automerge/automerge/slim";
import * as AutomergeRepo from "@automerge/automerge-repo/slim";
import {
  initializeLegacyAutomergeRepoKeyhive,
  type LegacyAutomergeRepoKeyhive,
} from "@automerge/automerge-repo-keyhive";
// eslint-disable-next-line
// @ts-ignore — initSync is a wasm-bindgen runtime helper not in the .d.ts
import { initSync as initSubductionSync } from "@automerge/automerge-subduction/slim";
import { MemorySigner } from "@automerge/automerge-subduction/slim";

declare const __SITE_NAME__: string;
const siteName =
  typeof __SITE_NAME__ !== "undefined" ? __SITE_NAME__ : "tiny-patchwork";

// Sync-server selection for keyhive. Defaults to "subduction". Build with
// KEYHIVE_SYNC_SERVER=true to target keyhive.sync.automerge.org. This must match
// the automerge-worker (SharedWorker) selection so the tab and the SW grant relay
// access to the same server.
declare const __KEYHIVE_SYNC_SERVER__: boolean;
const useKeyhiveSyncServer =
  typeof __KEYHIVE_SYNC_SERVER__ !== "undefined" && __KEYHIVE_SYNC_SERVER__;

import { ModuleWatcher } from "@inkandswitch/patchwork-filesystem";
import { importAutomergeModuleViaWorker } from "./module-loader.js";
import {
  openDocument,
  registerPatchworkViewElement,
} from "@inkandswitch/patchwork-elements";
import { registerRepoProviderElement } from "@inkandswitch/patchwork-providers";
import {
  type AccountDoc,
  type DatatypeDescription,
  type DatatypeImplementation,
  getRegistry,
  registerPlugins,
  resolveAccountHandle,
  unregisterPlugins,
} from "@inkandswitch/patchwork-plugins";
import * as plugins from "@inkandswitch/patchwork-plugins";

import setupServiceWorker, {
  getAutomergeWorker,
  lifecycleLoggingEnabled,
} from "./setup.js";
import type {
  ServiceWorkerRepoChannelListener,
  SyncStateDocMessage,
} from "./types.js";
import debug from "debug";
const log = debug("patchwork:bootloader:site");

declare global {
  interface Window {
    accountDocHandle: DocHandle<AccountDoc>;
    Automerge: typeof import("@automerge/automerge");
    AutomergeRepo: typeof import("@automerge/automerge-repo");
    repo: Repo;
    hive?: LegacyAutomergeRepoKeyhive;
    getRepoChannel: () => MessagePort;
    patchwork: {
      repo: Repo;
      packages: ModuleWatcher;
      plugins: typeof plugins;
      accountDocHandle: DocHandle<AccountDoc>;
      signer?: {
        peerId: string;
        verifyingKey: string;
      };
      sw: {
        connectClassicSync: (server?: string) => Promise<void>;
        subscribeToRepoChannel: (
          listener: ServiceWorkerRepoChannelListener
        ) => Promise<() => void>;
        subscribeSyncState: (
          documentId: string,
          listener: (update: SyncStateDocMessage) => void
        ) => () => void;
      };
    };
    uncache: (match: string) => Promise<void>;
  }
}

export interface SiteConfig {
  /**
   * The site's default tool bundle — the tools every user of this site gets
   * out of the box. Must collectively contribute at least a
   * `patchwork:datatype` registration for `"account"` (typically the one
   * supplied by `@inkandswitch/patchwork-frame`).
   *
   * Each entry is a *module-list source* and may be either:
   *  - an Automerge module-settings doc URL (`automerge:...`), which is
   *    live-reloaded, or
   *  - an HTTP(S) URL (absolute or site-relative, e.g. `/modules.json`) to a
   *    static JSON manifest of the shape `{ modules: string[], branches? }`,
   *    fetched once at boot.
   *
   * The module URLs *inside* either kind of source may themselves be Automerge
   * folder docs or plain HTTP(S) bundles, so deployment targets can be freely
   * mixed.
   *
   * Can be overridden at runtime by setting `localStorage.defaultToolsUrl` to
   * another `automerge:` URL or manifest URL — useful for local development
   * against an unpublished tool set.
   */
  defaultModules?: string | string[];

  /**
   * @deprecated Use {@link SiteConfig.defaultModules}. Retained for backwards
   * compatibility with existing sites.
   */
  defaultModulesUrl?: AutomergeUrl;

  /**
   * `localStorage` key under which this site remembers which account document
   * belongs to the current user. Sites sharing an origin MUST use distinct
   * keys so they do not clobber each other's accounts.
   */
  accountStorageKey: string;

  /**
   * Brand word appended to the document title as `"<doc> | <titleSuffix>"`
   * when a document is open. The separator is provided for you.
   */
  titleSuffix: string;

  /**
   * DOM id of the `<patchwork-view>` element that will host the root tool.
   * Defaults to `"root"`.
   */
  rootElementId?: string;

  /**
   * When true, initialize keyhive for access control.
   * The Repo will use keyhive's network adapter, peerId, and idFactory
   * instead of a sharePolicy.
   */
  keyhive?: boolean;
}

export interface BootResult {
  repo: Repo;
  moduleWatcher: ModuleWatcher;
  accountDocHandle: DocHandle<AccountDoc>;
}

// Legacy big-patchwork hash shape: `<slug>--<documentId>[?…]`. The slug can
// contain characters we don't otherwise permit (e.g. `drawing-(branch-1)`), so
// we anchor on the `--` before the base58 document id and allow any non-query
// characters ahead of it rather than a strict slug charset.
const BIG_PATCHWORK_HASH_REGEX =
  /^(?<title>[^=&?/#]*)--(?<docId>[1-9A-HJ-NP-Za-km-z]+)/;

const [automergeWasm, subductionWasm] = await Promise.all([
  fetch("/automerge.wasm?main").then((r) => r.bytes()),
  fetch("/subduction.wasm").then((r) => r.bytes()),
]);

/**
 * Boot a Patchwork browser site.
 *
 * Performs the full application-shell setup: service worker + port, Repo,
 * plugin/module loading, account resolution, URL-hash routing, and dev-console
 * globals (`window.repo`, `window.patchwork`, `window.uncache`). Returns the
 * constructed Repo, ModuleWatcher and account handle for sites that want to
 * do additional wiring after boot.
 */
export async function bootPatchworkSite(
  config: SiteConfig
): Promise<BootResult> {
  const defaultModuleSources = resolveDefaultModules(config);
  showLoadingAnimation();
  log(`booting`, config);
  installLifecycleLogging();
  await initializeWasm(automergeWasm);
  initSubductionSync(subductionWasm);

  log("enabling workers");
  const sw = await setupServiceWorker();
  if (!sw) throw new Error("Failed to set up service worker");
  log("workers ready");

  let hive: LegacyAutomergeRepoKeyhive | undefined;
  let repo: Repo;
  let tabSignerIdentity: { peerId: string; verifyingKey: string } | undefined;

  // If a Repo is already on `window` — an embedding context provided one before
  // this entry ran — reuse it and its keyhive instead of standing up a fresh
  // realm-local Repo, so we share the same documents and sync/keyhive context.
  // Otherwise create our own below.
  if (window.repo) {
    log("using existing Repo from window");
    repo = window.repo;
    hive = window.hive;
  } else {
    // Get the initial automerge-worker port via subscribeToRepoChannel,
    // then pass it to keyhive init which wraps it in its own network adapter.
    let resolvePort!: (port: MessagePort) => void;
    const portPromise = new Promise<MessagePort>((r) => {
      resolvePort = r;
    });
    log("subscribing to repo channel");
    await sw.subscribeToRepoChannel(resolvePort);
    log("repo channel subscribed");
    const workerPort = await portPromise;

    if (config.keyhive) {
      log("setting up keyhive");

      ({ hive, repo } = await initializeLegacyAutomergeRepoKeyhive({
        createRepo: (config) => new Repo(config),
        storage: new IndexedDBWorkerStorageAdapter(`${siteName}-keyhive`),
        peerIdSuffix: siteName,
        networkAdapter: new MessageChannelNetworkAdapter(workerPort),
        automaticArchiveIngestion: true,
        cachingMode: "periodic",
        onlyShareWithSyncServer: false,
        syncServer: useKeyhiveSyncServer ? "keyhive" : "subduction",
        repo: {
          storage: new IndexedDBWorkerStorageAdapter(),
          enableRemoteHeadsGossiping: true,
        },
      }));
      log("keyhive setup complete");
    } else {
      log("creating repo");
      // Pass an explicit signer (instead of the Repo's internal default) so we
      // can expose tab signer identity on window.patchwork for dev inspection.
      // The tab never connects via Subduction (no endpoints/adapters), so this
      // id never goes on the wire.
      const tabSigner = new MemorySigner();
      repo = new Repo({
        network: [new MessageChannelNetworkAdapter(workerPort)],
        storage: new IndexedDBWorkerStorageAdapter(),
        signer: tabSigner,
        async sharePolicy(peerId) {
          return peerId.includes("automerge-worker");
        },
        enableRemoteHeadsGossiping: true,
        peerId:
          `${config.titleSuffix}-tab-${crypto.randomUUID()}` as AutomergeRepo.PeerId,
      });
      tabSignerIdentity = {
        peerId: tabSigner.peerId().toString(),
        verifyingKey: (
          tabSigner.verifyingKey() as Uint8Array<ArrayBufferLike> & {
            toHex(): string;
          }
        ).toHex(),
      };
      console.log("[patchwork] tab subduction identity:", tabSignerIdentity);
      log("repo created");
    }
  }
  log("popping repo on window");
  window.repo = repo;
  log("await repo.networkSubsystem.whenReady()");

  await repo.networkSubsystem.whenReady();
  log("networkSubsystem ready");

  if (hive) {
    (hive.networkAdapter as any).syncKeyhive?.();
  }

  installDevConsoleGlobals(repo, hive, sw.getRepoChannel);

  registerRepoProviderElement(repo as any);

  const rootElement = document.getElementById(config.rootElementId ?? "root");
  if (!rootElement) {
    throw new Error(
      `bootPatchworkSite: no element with id="${config.rootElementId ?? "root"}"`
    );
  }
  // `<repo-provider>` sits above the root and answers `repo:handle-descriptor`
  // for any view outside a remapper (resolving to the requested url unchanged).
  const repoProvider = document.createElement("repo-provider");
  rootElement.parentElement!.insertBefore(repoProvider, rootElement);
  repoProvider.appendChild(rootElement);

  registerPatchworkViewElement({ hive, repo });

  // The watcher is started with the site's default-tools bundle alone so that
  // `resolveAccountHandle` below has something to await on (the `account`
  // datatype lives in that bundle today). The user's own module-settings URL
  // is added lazily once it appears on the account doc — see below.
  const moduleWatcher = new ModuleWatcher(
    repo,
    buildSystemSources(defaultModuleSources),
    onModuleLoaded,
    unregisterPlugins,
    // Discover an Automerge package's plugin descriptors off the main thread;
    // each plugin's load() re-imports the package (at heads) on this thread.
    importAutomergeModuleViaWorker
  );

  const accountDocHandle = (await resolveAccountHandle(repo, {
    storageKey: config.accountStorageKey,
    hive,
  })) as DocHandle<AccountDoc>;
  // TODO: something we (Orion & pvh) changed in the types made this necessary
  //       fix this before merging to main!

  window.accountDocHandle = accountDocHandle;

  wireModuleSettingsWhenReady(accountDocHandle, moduleWatcher);

  primeRootElement(rootElement, accountDocHandle);
  logToolRegistryWhenLoaded(moduleWatcher);

  window.patchwork = {
    repo,
    packages: moduleWatcher,
    plugins,
    accountDocHandle,
    ...(tabSignerIdentity ? { signer: tabSignerIdentity } : {}),
    sw: {
      connectClassicSync: sw.connectClassicSync,
      subscribeToRepoChannel: sw.subscribeToRepoChannel,
      subscribeSyncState: sw.subscribeSyncState,
    },
  };
  window.uncache = uncache;

  installHashRouting({
    rootElement,
    repo,
    accountDocHandle,
    titleSuffix: config.titleSuffix,
  });

  return { repo, moduleWatcher, accountDocHandle };
}

// ─── Internals ──────────────────────────────────────────────────────────

/**
 * A module-list source is valid if it is an Automerge URL or looks like an
 * HTTP(S)/site-relative manifest URL.
 */
function isValidModuleSource(source: string): boolean {
  if (isValidAutomergeUrl(source)) return true;
  return (
    source.startsWith("/") ||
    source.startsWith("http://") ||
    source.startsWith("https://") ||
    source.startsWith("./")
  );
}

/**
 * Resolve the site's default module-list sources, honouring the
 * `localStorage.defaultToolsUrl` dev override (which replaces the entire
 * built-in default bundle).
 */
function resolveDefaultModules(config: SiteConfig): string[] {
  const builtin = config.defaultModules ?? config.defaultModulesUrl ?? [];
  const builtinList = (Array.isArray(builtin) ? builtin : [builtin]).filter(
    Boolean
  );

  const override = globalThis.localStorage?.getItem("defaultToolsUrl");
  if (override) {
    if (isValidModuleSource(override)) {
      if (!builtinList.includes(override)) {
        console.info(
          `using defaultToolsUrl override from localStorage: ${override}`
        );
      }
      return [override];
    }
    console.warn(
      `ignoring invalid defaultToolsUrl in localStorage: ${override}; using built-in default`
    );
  }

  if (builtinList.length === 0) {
    throw new Error(
      "bootPatchworkSite: no default module sources configured (set `defaultModules`)"
    );
  }
  return builtinList;
}

/**
 * Turn an ordered list of module-list sources into the name-keyed map the
 * ModuleWatcher expects. The first source keeps the canonical `system` name;
 * additional sources get suffixed names. None may be `user` (reserved for the
 * per-account settings doc, which has branch-override precedence).
 */
function buildSystemSources(sources: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  sources.forEach((source, index) => {
    const name = index === 0 ? "system" : `system-${index}`;
    map[name] = source;
  });
  return map;
}

function installDevConsoleGlobals(
  repo: Repo,
  hive: LegacyAutomergeRepoKeyhive | undefined,
  getRepoChannel: () => MessagePort
): void {
  window.repo = repo;
  window.Automerge = Automerge;
  window.AutomergeRepo = AutomergeRepo;
  if (hive) {
    window.hive = hive;
  }
  window.getRepoChannel = getRepoChannel;
}

/**
 * Log this tab's Page Lifecycle + connectivity transitions (visibility,
 * freeze, bfcache, online/offline) so they line up against the SharedWorker's
 * sync-socket reaps. [lifecycle]-tagged, on by default.
 */
function installLifecycleLogging(): void {
  if (typeof document === "undefined") return;
  const opts = { capture: true } as const;
  const note = (label: string, extra?: unknown) => {
    if (!lifecycleLoggingEnabled()) return;
    const msg = `[lifecycle] ${new Date().toISOString()} ${label}`;
    if (extra === undefined) console.info(msg);
    else console.info(msg, extra);
  };

  document.addEventListener(
    "visibilitychange",
    () => note(`visibilitychange → ${document.visibilityState}`),
    opts
  );
  document.addEventListener("freeze", () => note("freeze (tab suspended)"), opts);
  document.addEventListener("resume", () => note("resume (tab unsuspended)"), opts);
  window.addEventListener(
    "pageshow",
    e => note("pageshow", { persisted: (e as PageTransitionEvent).persisted }),
    opts
  );
  window.addEventListener(
    "pagehide",
    e => note("pagehide", { persisted: (e as PageTransitionEvent).persisted }),
    opts
  );
  window.addEventListener("online", () => note("online"), opts);
  window.addEventListener("offline", () => note("offline"), opts);

  note(
    `lifecycle logging installed (visibilityState=${document.visibilityState}, hasFocus=${document.hasFocus()})`
  );
}

function onModuleLoaded(name: string, mod: any): void {
  if (Array.isArray(mod.plugins)) {
    log(
      `registering ${mod.plugins.length} plugin(s) from ${name.slice(0, 30)}...`,
      mod.plugins.map((p: any) => `${p.type}:${p.id}`)
    );
    registerPlugins(mod.plugins, name);
  } else {
    console.warn(
      `module ${name.slice(0, 30)}... has no plugins array`,
      Object.keys(mod)
    );
  }
}

/**
 * The frame lazy-creates `moduleSettingsUrl` on first mount. Watch for it to
 * appear on the account doc and feed it into the ModuleWatcher so the user's
 * own tool bundle loads alongside the site default. Idempotent.
 */
function wireModuleSettingsWhenReady(
  accountDocHandle: DocHandle<AccountDoc>,
  moduleWatcher: ModuleWatcher
): void {
  const wire = () => {
    const url = accountDocHandle.doc()?.moduleSettingsUrl;
    if (!url) return;
    void moduleWatcher.addUrl("user", url);
    accountDocHandle.off("change", wire);
  };
  wire();
  if (!accountDocHandle.doc()?.moduleSettingsUrl) {
    accountDocHandle.on("change", wire);
  }
}

/**
 * Set initial `tool-id` / `doc-url` attributes on the root
 * `<patchwork-view>` based on the URL hash (if it specifies a frame
 * override) or the account doc's configured frame tool + the account doc
 * itself.
 */
function primeRootElement(
  rootElement: HTMLElement,
  accountDocHandle: DocHandle<AccountDoc>
): void {
  rootElement.style.visibility = "hidden";

  const initialParams = new URLSearchParams(location.hash.slice(1));
  if (initialParams.has("frame")) {
    rootElement.setAttribute("tool-id", initialParams.get("frame")!);
    const docUrl =
      docParamToUrl(initialParams.get("doc")) ?? accountDocHandle.url;
    rootElement.setAttribute("doc-url", docUrl);
  } else {
    rootElement.setAttribute("tool-id", accountDocHandle.doc().frameToolId);
    rootElement.setAttribute("doc-url", accountDocHandle.url);
  }
}

function logToolRegistryWhenLoaded(moduleWatcher: ModuleWatcher): void {
  moduleWatcher.doneLoading
    .then(() => {
      const toolReg = getRegistry("patchwork:tool");
      const tools = toolReg.all();
      log(
        `doneLoading: ${tools.length} tools registered:`,
        tools.map((t: any) => t.id)
      );
    })
    .catch((err: unknown) => {
      console.error("doneLoading rejected:", err);
    });
}

const LOADING_STYLE_ID = "pw-bootloader-loading-styles";
const LOADING_ELEMENT_ID = "pw-bootloader-loading";

function showLoadingAnimation(): void {
  if (!document.getElementById(LOADING_STYLE_ID)) {
    const style = document.createElement("style");
    style.id = LOADING_STYLE_ID;
    style.textContent = `
      @keyframes pw-bootloader-pulse {
        0%, 100% { opacity: 0.25; }
        50% { opacity: 0.95; }
      }
      #${LOADING_ELEMENT_ID} {
        position: fixed;
        inset: 0;
        z-index: 0;
        pointer-events: none;
        background-color: #fff;
        background-image:
          radial-gradient(ellipse 55% 45% at 28% 35%, #fde4ec, transparent 70%),
          radial-gradient(ellipse 50% 55% at 72% 65%, #e0f0fb, transparent 70%),
          radial-gradient(ellipse 65% 55% at 50% 50%, #f1e6f6, transparent 80%);
        animation: pw-bootloader-pulse 3.5s ease-in-out infinite;
        transition: opacity 0.6s ease-out;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
      }
      @media (prefers-color-scheme: dark) {
        #${LOADING_ELEMENT_ID} {
          background-color: #000;
          background-image:
            radial-gradient(ellipse 55% 45% at 28% 35%, #2a1d33, transparent 70%),
            radial-gradient(ellipse 50% 55% at 72% 65%, #1a2738, transparent 70%),
            radial-gradient(ellipse 65% 55% at 50% 50%, #221a2e, transparent 80%);
        }
      }
      #${LOADING_ELEMENT_ID}.pw-bootloader-fading {
        opacity: 0;
        animation: none;
      }
    `;
    document.head.appendChild(style);
  }
  if (document.getElementById(LOADING_ELEMENT_ID)) return;
  const el = document.createElement("div");
  el.id = LOADING_ELEMENT_ID;
  document.body.appendChild(el);
}

function hideLoadingAnimation(): void {
  const el = document.getElementById(LOADING_ELEMENT_ID);
  if (!el) return;
  el.classList.add("pw-bootloader-fading");
  setTimeout(() => el.remove(), 700);
}

async function uncache(match: string): Promise<void> {
  for (const name of await caches.keys()) {
    const cache = await caches.open(name);
    for (const request of await cache.keys()) {
      if (request.url.includes(match)) {
        cache.delete(request);
      }
    }
  }
}

// The `doc=` value is an automerge URL — we keep its `:` (and any `#`/`|`
// heads) literal rather than percent-encoding it so links stay readable.
const RAW_HASH_KEYS = new Set(["doc"]);
// Emit hash params in a stable order so re-serializing the same logical params
// yields a byte-identical string (avoids spurious `hashchange` round-trips).
const HASH_KEY_ORDER = ["doc", "tool", "type", "title", "frame"];

function serializeHashParams(params: URLSearchParams): string {
  const emitted = new Set<string>();
  const parts: string[] = [];
  const emit = (key: string) => {
    if (emitted.has(key)) return;
    const value = params.get(key);
    if (!value) return;
    emitted.add(key);
    parts.push(
      `${key}=${RAW_HASH_KEYS.has(key) ? value : encodeURIComponent(value)}`
    );
  };
  for (const key of HASH_KEY_ORDER) emit(key);
  for (const key of params.keys()) emit(key);
  return parts.join("&");
}

/**
 * Coerce a `doc=` hash param to a full automerge URL. Accepts a full URL
 * (`automerge:<id>[#heads]`) or a bare document id for backwards compatibility
 * with older links.
 */
function docParamToUrl(docParam: string | null): AutomergeUrl | undefined {
  if (!docParam) return undefined;
  if (isValidAutomergeUrl(docParam as AutomergeUrl)) {
    return docParam as AutomergeUrl;
  }
  const documentId = docParam.replace(/^automerge:/, "");
  if (isValidDocumentId(documentId)) {
    return stringifyAutomergeUrl({ documentId: documentId as DocumentId });
  }
  return undefined;
}

interface HashRoutingParams {
  rootElement: HTMLElement;
  repo: Repo;
  accountDocHandle: DocHandle<AccountDoc>;
  titleSuffix: string;
}

function installHashRouting(params: HashRoutingParams): void {
  const { rootElement, repo, accountDocHandle, titleSuffix } = params;

  rootElement.addEventListener("patchwork:open-document", async (event) => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const { url, toolId, type, title } = event.detail as {
      url: AutomergeUrl;
      toolId?: string;
      type?: string;
      title?: string;
    };
    // `doc` is now the full automerge URL — heads, if any, live inside it, so
    // the separate `heads=` param is gone.
    params.delete("heads");
    params.set("doc", url);
    if (toolId) params.set("tool", toolId);
    else params.delete("tool");
    if (title) params.set("title", title);
    else params.delete("title");
    if (type) params.set("type", type);
    else params.delete("type");
    window.location.hash = serializeHashParams(params);

    try {
      const docHandle = await repo.find<{ "@patchwork"?: { type?: string } }>(
        url
      );
      const doc = docHandle.doc();
      const docType = type || doc?.["@patchwork"]?.type;
      if (!docType) return;
      const registry = getRegistry<DatatypeDescription>("patchwork:datatype");
      const datatype = await registry.load(docType);
      if (!datatype) return;
      const docTitle = (datatype.module as DatatypeImplementation).getTitle(
        doc
      );
      if (docTitle) {
        document.title = `${docTitle} | ${titleSuffix}`;
      }
    } catch (e) {
      console.error("Failed to update document title", e);
    }
  });

  let firstMount = true;
  const reveal = () => {
    if (!firstMount) return;
    firstMount = false;
    rootElement.style.visibility = "visible";
    hideLoadingAnimation();
  };

  rootElement.addEventListener("patchwork:mounted", (event) => {
    handleHashChange();
    if (event.target !== rootElement) return;
    console.info("root element mounted");
    reveal();
    // Re-resolve routing after a beat so deep-links from freshly-loaded tools
    // get a second chance to render.
    setTimeout(handleHashChange, 1000);
  });

  // Failsafe: if nothing ever mounts, reveal the element anyway after 12s so
  // the user sees *something* rather than a blank page.
  setTimeout(reveal, 12_000);

  const handleHashChange = async () => {
    const hash = window.location.hash.slice(1);

    // Legacy big-patchwork link (`<slug>--<docId>?…`): if the hash carries a
    // `--` followed by a valid document id, normalize it to the canonical
    // `#doc=automerge:<docId>` form and let routing re-run on the hashchange.
    const legacyDocId = BIG_PATCHWORK_HASH_REGEX.exec(hash)?.groups?.docId;
    if (legacyDocId && isValidDocumentId(legacyDocId)) {
      window.location.hash = serializeHashParams(
        new URLSearchParams({
          doc: stringifyAutomergeUrl({ documentId: legacyDocId as DocumentId }),
        })
      );
      return;
    }

    // Bare automerge URL in hash: /#automerge:<documentId>
    if (isValidAutomergeUrl(hash as AutomergeUrl)) {
      const url = hash as AutomergeUrl;
      window.location.hash = "";
      openDocument(rootElement, url);
      return;
    }

    const params = new URLSearchParams(hash);
    const docUrl = docParamToUrl(params.get("doc"));
    const toolId = params.get("tool");
    const title = params.get("title");
    const type = params.get("type");
    const frame = params.get("frame");
    if (frame) {
      const frameDocUrl = docUrl ?? accountDocHandle.url;
      if (
        rootElement.getAttribute("tool-id") !== frame ||
        rootElement.getAttribute("doc-url") !== frameDocUrl
      ) {
        rootElement.setAttribute("tool-id", frame);
        rootElement.setAttribute("doc-url", frameDocUrl);
      }
    }
    if (docUrl) {
      rootElement.dispatchEvent(
        new CustomEvent("patchwork:open-document", {
          detail: { url: docUrl, toolId, title, type },
        })
      );
    }
  };

  window.addEventListener("hashchange", handleHashChange);
}
