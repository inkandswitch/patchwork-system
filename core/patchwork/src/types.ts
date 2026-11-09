import type { AutomergeUrl, DocHandle, Repo } from "@automerge/vanillajs/slim";
import type { AutomergeRepoKeyhiveBase as AutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";
import type {
  ModuleWatcher,
  HasPatchworkMetadata,
} from "@inkandswitch/patchwork-filesystem";
import type {
  AccountCreator,
  AccountDoc,
} from "@inkandswitch/patchwork-plugins";
import type * as pluginsNS from "@inkandswitch/patchwork-plugins";
import type { Heads } from "@automerge/automerge/slim";
import type { ExplainedChange, WriterSummary } from "./provenance/index.js";
import type { PublicReaderStatus } from "@inkandswitch/patchwork-bootloader";

export type PluginsApi = typeof pluginsNS;

export type SignerIdentity = { peerId: string; verifyingKey: string };

/** The sync server's last-known heads for one document, as it reports them. */
export interface SyncStateDocMessage {
  type: "sync-state";
  documentId: string;
  storageId: string;
  heads: string[];
  timestamp: number;
}

export interface ServiceWorkerApi {
  connectClassicSync: (server?: string) => Promise<void>;
  /**
   * Watch one document's heads at the sync server. Calls `listener` with
   * what the server holds now, then on every update. Returns unsubscribe.
   */
  subscribeSyncState: (
    documentId: string,
    listener: (update: SyncStateDocMessage) => void
  ) => () => void;
}

export interface OpenOptions {
  tool?: string;
  type?: string;
  title?: string;
}

export interface PatchworkOptions {
  /**
   * Where the site's default tools come from: the ones every user of this
   * site gets. Between them they must register a `patchwork:datatype` for
   * `"account"` (usually `@inkandswitch/patchwork-frame`'s).
   *
   * Each entry is an `automerge:` module-settings doc, followed live, or an
   * http(s) url (absolute or site-relative, like `/modules.json`) to a JSON
   * manifest shaped `{ modules: string[], branches? }`, fetched once at boot.
   * The modules either kind lists may be automerge folder docs or http(s)
   * bundles.
   */
  packageListURL?: string | string[];

  /**
   * `localStorage` key under which this site remembers which account document
   * belongs to the current user. Defaults to `"patchworkAccountURL"`. Sites
   * sharing an origin MUST use distinct keys so they do not clobber each
   * other's accounts.
   */
  accountKey?: string;
  createAccount?: AccountCreator;

  /**
   * This site's name, appended to the document title as `"<doc> | <title>"`
   * when a document is open (the separator is provided for you).
   *
   * Defaults to the build-time `__SITE_TITLE__` define — the vite plugin's
   * `title` option, which also names the html `<title>` and the manifest —
   * then `"Patchwork"`.
   */
  title?: string;

  /**
   * Id of the tool that frames this site — what mounts in the root view when
   * the user hasn't chosen one on their account and the URL doesn't name one
   * via `#frame=`. Must be a tool one of the {@link
   * PatchworkOptions.packageListURL} sources registers.
   *
   * Falls back to the first registered tool tagged `frame-tool`, which with
   * more than one of them depends on module load order.
   */
  frameToolId?: string;

  /** DOM id of the `<patchwork-view>` hosting the root tool. Defaults to "root". */
  rootElementId?: string;

  /**
   * Bring your own Repo. When provided, setup skips wasm initialization and
   * repo creation entirely — you are responsible for having initialized
   * automerge/subduction and wired the automerge-protocol-handler-worker
   * port yourself.
   */
  repo?: Repo;

  /** The keyhive instance accompanying a provided {@link PatchworkOptions.repo}. */
  hive?: AutomergeRepoKeyhive;

  /**
   * How document navigation maps onto the URL. `"hash"` (the default) drives
   * the root view from `location.hash`. `false` installs no router — call
   * `patchwork.open()` directly.
   */
  routing?: "hash" | false;

  /**
   * Milliseconds before boot counts as stuck, if it hasn't finished: the root
   * view hasn't mounted, or with `routing: false`, `setup()` hasn't resolved.
   * A stuck boot isn't an error and isn't cancelled — it often gets there — so
   * `setup()` doesn't reject; progress reports `stuck: true` and the boot
   * status box says where it's stuck, with a reload button, until boot
   * finishes. Defaults to 30 seconds; `false` never calls it stuck.
   */
  timeout?: number | false;

  /**
   * Discover an Automerge package's plugin descriptors in a dedicated module
   * worker instead of importing the package on the main thread. Each plugin's
   * `load()` still imports the package (at the same heads) on the main thread.
   * Defaults to `true`; `false` imports every package directly.
   */
  importModulesInWorker?: boolean;

  /**
   * Told what boot is doing, as it moves on, for a loading screen. Called
   * with a fresh object each time. Without it, Patchwork shows a small box in
   * the corner saying what boot is doing, if boot takes long enough to notice;
   * a site that listens draws its own.
   */
  onProgress?: (progress: BootProgress) => void;
}

/**
 * Where boot has got to, in order: starting the service worker and shared
 * workers, opening the user's identity and Repo, finding the package lists,
 * loading the packages on them, and opening the first view.
 */
export type BootStage =
  "workers" | "identity" | "package-list" | "packages" | "opening";

export interface BootProgress {
  stage: BootStage;
  /**
   * The public reader, which fetches documents made public to Patchwork
   * (system packages are). On a first visit it catches up on every keyhive
   * event the sync server holds before it can decrypt any of them.
   */
  publicReader?: PublicReaderStatus;
  /** How many of the listed packages have loaded, and the name of the last. */
  packages?: { loaded: number; total: number; latest?: string };
  /**
   * Boot as a whole has taken longer than `timeout` (counted from `setup()`,
   * not from entering `stage`) and hasn't finished; once set it stays `true`
   * as later stages are reported. It carries on, and may still finish.
   */
  stuck?: boolean;
}

/**
 * The site runtime `setup()` resolves with — what a site assigns to
 * `window.patchwork`. Plain fields: it exists only once setup has finished,
 * so every member is always usable.
 */
export interface Patchwork {
  readonly repo: Repo;
  readonly hive?: AutomergeRepoKeyhive;
  readonly account: DocHandle<AccountDoc>;
  readonly signer?: SignerIdentity;

  create<D>(
    type: string,
    init?: (doc: D) => void
  ): Promise<DocHandle<D & HasPatchworkMetadata>>;
  open(url: AutomergeUrl, options?: OpenOptions): void;
  find<D>(url: AutomergeUrl): Promise<DocHandle<D>>;

  readonly packages: ModuleWatcher;
  readonly plugins: PluginsApi;
  readonly sw: ServiceWorkerApi;

  /** Which package version made each of a doc's changes, newest first. */
  explain(
    target: AutomergeUrl | DocHandle<unknown>,
    options?: { limit?: number; since?: Heads }
  ): Promise<ExplainedChange[]>;
  /** A doc's whole history grouped by the package version that made it. */
  explainSummary(
    target: AutomergeUrl | DocHandle<unknown>
  ): Promise<WriterSummary[]>;
}
