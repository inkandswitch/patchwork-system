import type { AutomergeUrl, DocHandle, Repo } from "@automerge/vanillajs/slim";
import type { AutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";
import type {
  ModuleWatcher,
  HasPatchworkMetadata,
} from "@inkandswitch/patchwork-filesystem";
import type {
  AccountCreator,
  AccountDoc,
} from "@inkandswitch/patchwork-plugins";
import type {
  ServiceWorkerRepoChannelListener,
  SyncStateDocMessage,
} from "@inkandswitch/patchwork-bootloader/types";
import type * as pluginsNS from "@inkandswitch/patchwork-plugins";

export type PluginsApi = typeof pluginsNS;

export type SignerIdentity = { peerId: string; verifyingKey: string };

export interface ServiceWorkerApi {
  connectClassicSync: (server?: string) => Promise<void>;
  subscribeToRepoChannel: (
    listener: ServiceWorkerRepoChannelListener
  ) => Promise<() => void>;
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
   * Brand word for this site: appended to the document title as
   * `"<doc> | <name>"` when a document is open (the separator is provided
   * for you), and used to namespace this site's storage and peer ids.
   *
   * Defaults to the build-time `__SITE_NAME__` define, then `"patchwork"`.
   */
  name?: string;

  /** DOM id of the `<patchwork-view>` hosting the root tool. Defaults to "root". */
  rootElementId?: string;

  /**
   * Bring your own Repo. When provided, setup skips wasm initialization and
   * repo creation entirely — you are responsible for having initialized
   * automerge/subduction and wired the automerge-worker port yourself.
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
   * Milliseconds before the promise `setup()` returned rejects because boot
   * hasn't finished — so a hang (service worker stuck, sync unreachable)
   * surfaces as an error a site can show instead of blank space. The boot
   * itself is not cancelled and may still complete in the background.
   * Defaults to 30 seconds; `false` disables the deadline.
   */
  timeout?: number | false;
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
}
