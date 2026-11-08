/**
 * One import for a Patchwork site. `setup(options)` makes the Repo, connects
 * the automerge worker, loads the packages, opens the user's account,
 * installs the router, and resolves with what a site assigns to
 * `window.patchwork`.
 *
 * It owns page-wide state (the `window.repo`, `window.Automerge`,
 * `window.AutomergeRepo` and `window.hive` globals, custom elements, document
 * listeners), so it runs once per page; a second call throws.
 *
 * It's for a browser site's `main.ts`. Anything without a UI should import
 * `@inkandswitch/patchwork-bootloader`, which only registers the service
 * worker and hands the automerge worker its port.
 */
import {
  type AutomergeUrl,
  type DocHandle,
  type DocumentId,
  type StorageId,
  Repo,
} from "@automerge/vanillajs/slim";
import * as Automerge from "@automerge/automerge/slim";
import * as AutomergeRepo from "@automerge/automerge-repo/slim";
import type { AutomergeRepoKeyhiveBase as AutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";

import {
  ModuleWatcher,
  trackPackagesViaServiceWorker,
} from "@inkandswitch/patchwork-filesystem";
import { importAutomergePackageViaWorker } from "@inkandswitch/patchwork-bootloader/module-loader";
import { registerPatchworkViewElement } from "@inkandswitch/patchwork-elements";
import { registerRepoProviderElement } from "@inkandswitch/patchwork-providers";
import {
  type AccountDoc,
  type DatatypeDescription,
  type LoadedDatatype,
  createDocOfDatatype2,
  getRegistry,
  registerPlugins,
  resolveAccountHandle,
  unregisterPlugins,
} from "@inkandswitch/patchwork-plugins";
import * as plugins from "@inkandswitch/patchwork-plugins";
import setupServiceWorker, {
  connectClassicSync,
  onPublicReaderStatus,
  resolveHandoffsWith,
} from "@inkandswitch/patchwork-bootloader";
import debug from "debug";

import type {
  BootProgress,
  OpenOptions,
  Patchwork,
  PatchworkOptions,
  SignerIdentity,
  SyncStateDocMessage,
} from "./types.js";
import { createRepo, initWasm } from "./repo.js";
import { gatePublicDocsOnReader } from "./public-access.js";
import { watchDocument } from "./watch-document.js";
import { createRouter, type Router } from "./router.js";
import { createDefaultAccount } from "./createAccount.js";

const log = debug("patchwork:setup");

declare const __SITE_TITLE__: string;

declare global {
  interface Window {
    patchwork: Patchwork;
    repo: Repo;
    Automerge: typeof import("@automerge/automerge/slim");
    AutomergeRepo: typeof import("@automerge/automerge-repo/slim");
    hive?: AutomergeRepoKeyhive;
  }
}

let setupCalled = false;

export function setup(options: PatchworkOptions = {}): Promise<Patchwork> {
  if (setupCalled) {
    throw new Error(
      "patchwork.setup: already called — setup owns page-wide state and may run only once"
    );
  }
  setupCalled = true;
  const done = doSetup(options);
  void done.then(() => log("patchwork setup complete"));

  const timeout = options.timeout ?? 30_000;
  if (timeout === false) return done;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`patchwork.setup: boot did not finish within ${timeout}ms`)
        ),
      timeout
    );
  });
  done.then(
    () => clearTimeout(timer),
    () => clearTimeout(timer)
  );
  return Promise.race([done, deadline]);
}

export default setup;

async function doSetup(options: PatchworkOptions): Promise<Patchwork> {
  const siteTitle =
    options.title ??
    (typeof __SITE_TITLE__ !== "undefined" ? __SITE_TITLE__ : "Patchwork");
  const moduleSources = resolveDefaultModules(options);
  const routing = options.routing ?? "hash";

  log("booting", options);

  const progress: BootProgress = { stage: "workers" };
  const report = (change: Partial<BootProgress>) => {
    Object.assign(progress, change);
    try {
      options.onProgress?.({ ...progress });
    } catch (error) {
      console.error("patchwork.setup: onProgress threw", error);
    }
  };
  report({});

  if (!options.repo) await initWasm();

  const sw = await setupServiceWorker();
  if (!sw) throw new Error("Failed to set up service worker");
  log("workers ready");
  const stopHearingReader = onPublicReaderStatus((publicReader) =>
    report({ publicReader })
  );
  report({ stage: "identity" });

  let hive: AutomergeRepoKeyhive | undefined;
  let repo: Repo;
  let signerIdentity: SignerIdentity | undefined;

  if (options.repo) {
    log("using provided Repo");
    repo = options.repo;
    hive = options.hive;
  } else {
    ({ repo, hive, signerIdentity } = await createRepo());
    // The service worker asks this tab to resolve its own `automerge:`
    // requests, and leaves them to the automerge worker until now. A site's
    // own Repo isn't asked: it may not be able to find them.
    resolveHandoffsWith(repo);
  }

  // Loaded tools and e2e read these. `window.patchwork` is the caller's to set.
  window.repo = repo;
  window.Automerge = Automerge as typeof import("@automerge/automerge/slim");
  window.AutomergeRepo =
    AutomergeRepo as typeof import("@automerge/automerge-repo/slim");
  if (hive) window.hive = hive;

  (hive?.networkAdapter as any)?.syncKeyhive?.();

  registerRepoProviderElement(repo as any);

  const rootElementId = options.rootElementId ?? "root";
  const rootElement = document.getElementById(rootElementId);
  if (!rootElement) {
    throw new Error(`patchwork.setup: no element with id="${rootElementId}"`);
  }

  // Answers `repo:handle-descriptor` for views with no remapper above them.
  // Generated site html already has one around the root.
  if (!rootElement.closest("repo-provider")) {
    const repoProvider = document.createElement("repo-provider");
    rootElement.parentElement!.insertBefore(repoProvider, rootElement);
    repoProvider.appendChild(rootElement);
  }

  if (hive) gatePublicDocsOnReader(repo);
  registerPatchworkViewElement({ hive, repo });

  // Starts with the site's sources alone: they hold the `account` datatype
  // resolveAccountHandle waits for, and the account's own settings join later.
  // Counted by settings entry, not heads-pinned url, so a reload doesn't count
  // twice, and only against the current list, so removed packages drop out.
  const loaded = new Set<string>();
  let listed: Set<string> | undefined;
  const loadedCount = () => {
    const current = listed;
    if (!current) return loaded.size;
    return [...loaded].filter((key) => current.has(key)).length;
  };
  const moduleWatcher = new ModuleWatcher(
    repo,
    nameSources(moduleSources),
    (name, mod, moduleKey) => {
      onModuleLoaded(name, mod);
      loaded.add(moduleKey);
      report({
        packages: {
          loaded: loadedCount(),
          total: Math.max(progress.packages?.total ?? 0, loadedCount()),
          latest: packageName(mod) ?? progress.packages?.latest,
        },
      });
    },
    // Counted by settings entry; registered under the url that was loaded,
    // which for a branch package is a different document.
    (moduleKey, importUrl) => {
      loaded.delete(moduleKey);
      unregisterPlugins(importUrl);
    },
    options.importModulesInWorker === false
      ? undefined
      : importAutomergePackageViaWorker,
    // Look packages up through the automerge worker and watch them through
    // this tab's Subduction subscriptions, so their docs never load into this
    // tab's Repo.
    trackPackagesViaServiceWorker((url, onChange) =>
      watchDocument(repo, url, onChange)
    )
  );

  moduleWatcher.onModules = (modules) => {
    listed = new Set(modules);
    report({
      stage: progress.stage === "package-list" ? "packages" : progress.stage,
      packages: {
        ...progress.packages,
        loaded: loadedCount(),
        total: modules.length,
      },
    });
  };
  report({ stage: "package-list" });

  const accountDocHandle = (await resolveAccountHandle(repo, {
    storageKey: options.accountKey ?? "patchworkAccountURL",
    hive,
    createAccount: options.createAccount ?? createDefaultAccount,
  })) as DocHandle<AccountDoc>;

  wireModuleSettings(accountDocHandle, moduleWatcher);

  const toolsLoaded = moduleWatcher.doneLoading.then(
    () =>
      log(
        "doneLoading, tools registered:",
        getRegistry("patchwork:tool")
          .all()
          .map((t: any) => t.id)
      ),
    (err: unknown) => console.error("doneLoading rejected:", err)
  );

  void toolsLoaded.then(() => {
    stopHearingReader();
    report({ stage: "opening" });
  });

  let router: Router | undefined;
  if (routing !== false) {
    rootElement.style.visibility = "hidden";
    await toolsLoaded;
    router = createRouter({
      rootElement,
      repo,
      accountDocHandle,
      siteTitle,
      frameToolId: options.frameToolId,
    });
  }

  installReveal(rootElement, router, toolsLoaded);

  return {
    repo,
    hive,
    account: accountDocHandle,
    signer: signerIdentity,
    packages: moduleWatcher,
    plugins,
    sw: {
      connectClassicSync: (server) => connectClassicSync(repo, server),
      subscribeSyncState: (documentId, listener) =>
        subscribeSyncState(repo, documentId, listener),
    },

    async create<D>(type: string, init?: (doc: D) => void) {
      const datatype =
        await getRegistry<DatatypeDescription>("patchwork:datatype").load(type);
      if (!datatype) {
        throw new Error(
          `patchwork.create: no datatype registered for "${type}"`
        );
      }
      return createDocOfDatatype2(
        datatype as unknown as LoadedDatatype<D>,
        repo,
        init,
        hive
      );
    },
    open(url: AutomergeUrl, openOptions: OpenOptions = {}) {
      rootElement.dispatchEvent(
        new CustomEvent("patchwork:open-document", {
          detail: {
            url,
            toolId: openOptions.tool,
            type: openOptions.type,
            title: openOptions.title,
          },
        })
      );
    },
    find<D>(url: AutomergeUrl) {
      return repo.find<D>(url);
    },
  };
}

function installReveal(
  rootElement: HTMLElement,
  router: Router | undefined,
  toolsLoaded: Promise<unknown>
): void {
  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    rootElement.style.visibility = "visible";
  };

  rootElement.addEventListener("patchwork:mounted", (event) => {
    if (event.target !== rootElement) return;
    log("root element mounted");
    if (router) {
      void router.route();
      // Deep-links into tools that were still loading get routed again once
      // every module has registered.
      void toolsLoaded.then(() => router.route());
    }
    reveal();
  });

  // Reveal anyway if nothing ever mounts.
  setTimeout(reveal, 12_000);
}

/**
 * The site's module-list sources. The site owns any dev overrides and passes
 * the result in as `packageListURL`.
 */
function resolveDefaultModules(options: PatchworkOptions): string[] {
  const configured = options.packageListURL ?? [];
  const builtin = (
    Array.isArray(configured) ? configured : [configured]
  ).filter(Boolean);

  if (builtin.length === 0) {
    throw new Error(
      "patchwork.setup: no default module sources configured (set `packageListURL`)"
    );
  }
  return builtin;
}

/**
 * Name the sources for the ModuleWatcher. The first keeps the canonical
 * `system` name; the rest get suffixed. None may be `user`, which is reserved
 * for the per-account settings doc and has branch-override precedence.
 */
function nameSources(sources: string[]): Record<string, string> {
  return Object.fromEntries(
    sources.map((source, i) => [i === 0 ? "system" : `system-${i}`, source])
  );
}

/** What to call a package on a loading screen: its first tool's name, say. */
function packageName(mod: any): string | undefined {
  const plugins: any[] = Array.isArray(mod?.plugins) ? mod.plugins : [];
  const named =
    plugins.find((p) => p?.type === "patchwork:tool" && p.name) ??
    plugins.find((p) => p?.name);
  return named?.name ?? plugins[0]?.id;
}

function onModuleLoaded(name: string, mod: any): void {
  if (!Array.isArray(mod.plugins)) {
    console.warn(`module ${name} has no plugins array`, Object.keys(mod));
    return;
  }
  log(
    `registering ${mod.plugins.length} plugin(s) from ${name}`,
    mod.plugins.map((p: any) => `${p.type}:${p.id}`)
  );
  registerPlugins(mod.plugins, name);
}

/**
 * Feed the account's module settings document to the ModuleWatcher.
 */
function wireModuleSettings(
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

// The tab's own Repo hears the server's heads directly, so this is a filter
// over its `subduction-remote-heads` event. The current value is replayed
// from the handle's sync info, when the server has reported any.
function subscribeSyncState(
  repo: Repo,
  documentId: string,
  listener: (update: SyncStateDocMessage) => void
): () => void {
  const onHeads = (payload: {
    documentId: string;
    storageId: string;
    heads: readonly string[];
    timestamp: number;
  }) => {
    if (payload.documentId !== documentId) return;
    listener({
      type: "sync-state",
      documentId,
      storageId: payload.storageId,
      heads: [...payload.heads],
      timestamp: payload.timestamp,
    });
  };
  repo.on("subduction-remote-heads", onHeads);

  void (async () => {
    const handle = repo.handles[documentId as DocumentId];
    if (!handle) return;
    for (const storageId of await repo.connectedSubductionPeerIds()) {
      const info = handle.getSyncInfo(storageId as StorageId);
      if (info) {
        onHeads({
          documentId,
          storageId,
          heads: info.lastHeads,
          timestamp: info.lastSyncTimestamp,
        });
      }
    }
  })();

  return () => repo.off("subduction-remote-heads", onHeads);
}

export { createRepo, initWasm } from "./repo.js";
export { watchDocument } from "./watch-document.js";
export { createRouter } from "./router.js";
export {
  showLoadingAnimation,
  hideLoadingAnimation,
  showErrorScreen,
} from "./loading.js";
export type {
  BootProgress,
  BootStage,
  OpenOptions,
  Patchwork,
  PatchworkOptions,
  ServiceWorkerApi,
  SignerIdentity,
  SyncStateDocMessage,
} from "./types.js";
