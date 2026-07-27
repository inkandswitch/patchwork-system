/**
 * One import for a Patchwork site.
 *
 * `setup(options)` constructs the Repo, wires up the automerge-worker port,
 * loads plugins via the ModuleWatcher, resolves the user's account document,
 * installs the router, and resolves with the site's runtime API — `repo`,
 * `create`, `open`, `find`, `packages`, `plugins`, `sw` — which is what a
 * site assigns to `window.patchwork`.
 *
 * Setup owns page-wide state — the `window.repo`/`window.Automerge`/
 * `window.AutomergeRepo`/`window.hive` globals, custom-element registration,
 * document listeners — so it may run only once per page; a second call
 * throws.
 *
 * Pulls in DOM- and plugin-layer dependencies, so it is for a browser site's
 * `main.ts` only. Non-UI consumers should import
 * `@inkandswitch/patchwork-bootloader` directly, which does SW registration
 * and the automerge-worker handoff and nothing else.
 */
import {
  type AutomergeUrl,
  type DocHandle,
  MessageChannelNetworkAdapter,
  Repo,
} from "@automerge/vanillajs/slim";
import * as Automerge from "@automerge/automerge/slim";
import * as AutomergeRepo from "@automerge/automerge-repo/slim";
import type { AutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";

import { ModuleWatcher } from "@inkandswitch/patchwork-filesystem";
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
  lifecycleLog,
} from "@inkandswitch/patchwork-bootloader";
import debug from "debug";

import type {
  OpenOptions,
  Patchwork,
  PatchworkOptions,
  SignerIdentity,
} from "./types.js";
import {
  createRepo,
  firstRepoPort,
  initWasm,
  removeAdapterFor,
} from "./repo.js";
import { createRouter, type Router } from "./router.js";
import { createDefaultAccount } from "./createAccount.js";

const log = debug("patchwork:setup");

declare const __SITE_NAME__: string;

declare global {
  interface Window {
    patchwork: Patchwork;
    repo: Repo;
    Automerge: typeof import("@automerge/automerge");
    AutomergeRepo: typeof import("@automerge/automerge-repo");
    hive?: AutomergeRepoKeyhive;
  }
}

// ── Setup ────────────────────────────────────────────────────────────────

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
          new Error(
            `patchwork.setup: boot did not finish within ${timeout}ms`
          )
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
  const siteName =
    options.name ??
    (typeof __SITE_NAME__ !== "undefined" ? __SITE_NAME__ : "patchwork");
  const moduleSources = resolveDefaultModules(options);
  const routing = options.routing ?? "hash";

  log("booting", options);
  installLifecycleLogging();

  if (!options.repo) await initWasm();

  const sw = await setupServiceWorker();
  if (!sw) throw new Error("Failed to set up service worker");
  log("workers ready");

  let hive: AutomergeRepoKeyhive | undefined;
  let repo: Repo;
  let signerIdentity: SignerIdentity | undefined;
  // Called with a fresh port when the automerge worker dies and is recreated.
  // Assigned once the repo exists.
  let onWorkerPortRenewed: ((port: MessagePort) => void) | undefined;

  if (options.repo) {
    log("using provided Repo");
    repo = options.repo;
    hive = options.hive;
  } else {
    const workerPort = await firstRepoPort(sw, (port) => {
      if (onWorkerPortRenewed) onWorkerPortRenewed(port);
      else {
        console.warn(
          "automerge worker port renewed before the repo existed; dropping it"
        );
      }
    });

    let workerAdapter = new MessageChannelNetworkAdapter(workerPort);
    ({ repo, hive, signerIdentity } = await createRepo(
      siteName,
      workerAdapter
    ));

    // The worker was recreated with cold state: wire the repo onto the fresh
    // port and drop the adapter stranded on the dead one.
    const bootHive = hive;
    onWorkerPortRenewed = (port) => {
      const fresh = new MessageChannelNetworkAdapter(port);
      // Mirror the boot wiring: a keyhive repo talks to the worker through a
      // keyhive adapter wrapped around the message channel.
      const registered = bootHive
        ? bootHive.createKeyhiveNetworkAdapter(fresh, false, false, 2000)
        : fresh;
      repo.networkSubsystem.addNetworkAdapter(registered as any);
      removeAdapterFor(repo, workerAdapter, registered);
      workerAdapter = fresh;
      lifecycleLog("repo re-wired to the recreated automerge worker");
    };
  }

  // Dev-console / tool-runtime globals (e2e and loaded tools read these). The
  // `window.patchwork` handle is deliberately not set here — the caller does
  // `window.patchwork = await setup(...)`.
  window.repo = repo;
  window.Automerge = Automerge as typeof import("@automerge/automerge");
  window.AutomergeRepo =
    AutomergeRepo as typeof import("@automerge/automerge-repo");
  if (hive) window.hive = hive;

  await repo.networkSubsystem.whenReady();
  log("networkSubsystem ready");
  (hive?.networkAdapter as any)?.syncKeyhive?.();

  registerRepoProviderElement(repo as any);

  const rootElementId = options.rootElementId ?? "root";
  const rootElement = document.getElementById(rootElementId);
  if (!rootElement) {
    throw new Error(`patchwork.setup: no element with id="${rootElementId}"`);
  }

  // `<repo-provider>` sits above the root and answers `repo:handle-descriptor`
  // for any view outside a remapper, resolving to the requested url unchanged.
  // Generated site html already declares it around the root; wrap only
  // hand-written markup that lacks one.
  if (!rootElement.closest("repo-provider")) {
    const repoProvider = document.createElement("repo-provider");
    rootElement.parentElement!.insertBefore(repoProvider, rootElement);
    repoProvider.appendChild(rootElement);
  }

  registerPatchworkViewElement({ hive, repo });

  // Started with the site bundle alone so resolveAccountHandle has something to
  // await on — the `account` datatype lives there. The user's own
  // module-settings URL is added lazily once it appears on the account doc.
  const moduleWatcher = new ModuleWatcher(
    repo,
    nameSources(moduleSources),
    onModuleLoaded,
    unregisterPlugins,
    // Discover an Automerge package's plugin descriptors off the main thread;
    // each plugin's load() re-imports the package (at heads) on this thread.
    importAutomergePackageViaWorker
  );

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

  let router: Router | undefined;
  if (routing !== false) {
    rootElement.style.visibility = "hidden";
    await toolsLoaded;
    router = createRouter({
      rootElement,
      repo,
      accountDocHandle,
      siteName,
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
      connectClassicSync: sw.connectClassicSync,
      subscribeToRepoChannel: sw.subscribeToRepoChannel,
      subscribeSyncState: sw.subscribeSyncState,
    },

    async create<D>(type: string, init?: (doc: D) => void) {
      const datatype = await getRegistry<DatatypeDescription>(
        "patchwork:datatype"
      ).load(type);
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

// ── Reveal / mount ───────────────────────────────────────────────────────

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

  // If nothing ever mounts, reveal anyway so the user sees something rather
  // than a blank page.
  setTimeout(reveal, 12_000);
}

// ── Module sources ───────────────────────────────────────────────────────

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

/** Page Lifecycle and connectivity transitions, to line up against the
 * SharedWorker's sync-socket reaps. */
function installLifecycleLogging(): void {
  if (typeof document === "undefined") return;
  const opts = { capture: true } as const;
  const persisted = (e: Event) => (e as PageTransitionEvent).persisted;

  document.addEventListener(
    "visibilitychange",
    () => lifecycleLog("visibilitychange → %s", document.visibilityState),
    opts
  );
  document.addEventListener(
    "freeze",
    () => lifecycleLog("freeze (tab suspended)"),
    opts
  );
  document.addEventListener(
    "resume",
    () => lifecycleLog("resume (tab unsuspended)"),
    opts
  );
  window.addEventListener(
    "pageshow",
    (e) => lifecycleLog("pageshow persisted=%s", persisted(e)),
    opts
  );
  window.addEventListener(
    "pagehide",
    (e) => lifecycleLog("pagehide persisted=%s", persisted(e)),
    opts
  );
  window.addEventListener("online", () => lifecycleLog("online"), opts);
  window.addEventListener("offline", () => lifecycleLog("offline"), opts);

  lifecycleLog(
    "logging installed (visibilityState=%s, hasFocus=%s)",
    document.visibilityState,
    document.hasFocus()
  );
}

// ── Named exports ────────────────────────────────────────────────────────

export { createRepo, initWasm } from "./repo.js";
export { createRouter } from "./router.js";
export {
  showLoadingAnimation,
  hideLoadingAnimation,
  showErrorScreen,
} from "./loading.js";
export type {
  OpenOptions,
  Patchwork,
  PatchworkOptions,
  ServiceWorkerApi,
  SignerIdentity,
} from "./types.js";
