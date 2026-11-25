import type { AutomergeUrl, Repo } from "@automerge/automerge-repo/slim";
import type { AutomergeRepoKeyhiveBase as AutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";
import { gateOnAccess } from "./keyhive-access.js";
import {
  isKeyhiveDoc,
  packages,
  type PackageEntry,
  type PluginView,
} from "@inkandswitch/patchwork-filesystem";
import {
  OverlayRepo,
  registerPatchworkViewTag,
} from "@inkandswitch/patchwork-providers";
import { MountedEvent, UnmountedEvent } from "./events.js";
import { LegacyImpl } from "./legacy-impl.js";
import { loadRetryDelay, resyncBeforeRetry } from "./load-retry.js";
import {
  dispatchFromNearestConnected,
  Serialized,
  Teardowns,
} from "./lifecycle.js";
import debug from "debug";

const log = debug("patchwork:elements:patchwork-view");

/**
 * A component gets the element it's mounted on and the realm's base `Repo`,
 * not the overlay, so providers answering `repo:handle-descriptor` can clone
 * and create in the real repo without going through their own remapping.
 */
export type ComponentRender = (
  element: PatchworkViewElement,
  repo: Repo
) => () => void;

export type ComponentDescription = {
  id: string;
  type: "patchwork:component";
  name: string;
  icon?: string;
  tags?: string[];
};

export type LoadedComponent = ComponentDescription & {
  module: ComponentRender;
};

export type Component = ComponentDescription &
  ({ load: () => Promise<ComponentRender> } | { import: string });

// A component in the package database.
type ComponentView = PluginView & { module?: ComponentRender };

const COMPONENT = "patchwork:component";

const State = {
  none: "none",
  initializing: "initializing",
  rendering: "rendering",
  unable: "unable",
  rendered: "rendered",
  error: "error",
} as const;

type State = (typeof State)[keyof typeof State];

const ATTRS = {
  component: "component",
  url: "url",
  docUrl: "doc-url",
  toolId: "tool-id",
  packageUrl: "package-url",
} as const;

export type RegisterPatchworkViewElementParams = {
  name?: string;
  /**
   * The realm's base `Repo`. Each `<patchwork-view>` wraps it in an
   * {@link OverlayRepo}, as `element.repo`, so tools find their primary doc
   * through the remappers above. Components get the base repo itself (see
   * {@link ComponentRender}).
   */
  repo: Repo;
  /** Handed to legacy-mode tools as `element.hive`. */
  hive?: AutomergeRepoKeyhive;
};

// Every `<patchwork-view>`, component or legacy tool. `repo` (the element's
// overlay) is always set before the mounted code runs, so it isn't optional.
export type PatchworkViewElementBase = HTMLElement & {
  repo: Repo;
  docUrl?: AutomergeUrl | null;
  toolId?: string | null;
  /**
   * A package to take the tool from, in place of the database: its
   * `patchwork:tool` with the id `tool-id`, or with no `tool-id`, its tool
   * for the doc's type. An `automerge:` url without heads follows the
   * package doc, mounting the new version when its heads move; one with
   * heads, or an http(s) url, stays put.
   */
  packageUrl?: string | null;
};

export type PatchworkViewElement = PatchworkViewElementBase & {
  component?: string | null;
  url?: AutomergeUrl | null;
};

declare global {
  interface HTMLElementTagNameMap {
    "patchwork-view": PatchworkViewElement;
  }
}

export type LegacyPatchworkViewElement = PatchworkViewElementBase & {
  hive?: AutomergeRepoKeyhive;
};

export function registerPatchworkViewElement(
  params: RegisterPatchworkViewElementParams
) {
  const name = params.name ?? "patchwork-view";

  registerPatchworkViewTag(name);

  if (customElements.get(name)) return;

  customElements.define(
    name,
    class PatchworkViewElement extends HTMLElement {
      #capturedParent: Element | null = null;

      #component: string | null = null;
      #url: AutomergeUrl | null = null;
      #loaded: ComponentView | null = null;
      #state: State = State.none;
      #initEpoch = 0;
      #teardowns = new Teardowns();
      #teardown = new Serialized(() => this.#runTeardown());
      // True when `unable` because access hasn't synced yet.
      // Receiving a keyhive op can recover this.
      #unableNoAccess = false;
      // Failed loads of this view's doc since it last loaded, for the back-off.
      #retryAttempt = 0;
      #retryTimer: ReturnType<typeof setTimeout> | null = null;

      // Made on first render; `element.repo` is this.
      #overlayRepo: OverlayRepo | null = null;
      repo!: Repo;

      // Legacy mode runs on this element, not a child, so events dispatched on
      // `<patchwork-view>` and the tool's listeners meet on one node.
      #legacyImpl: LegacyImpl | null = null;

      get component() {
        return this.#component;
      }

      set component(id: string | null) {
        if (this.#component === id) return;
        this.#component = id;
        const attr = this.getAttribute(ATTRS.component);
        if (attr == id) return;
        if (id) this.setAttribute(ATTRS.component, id);
        else this.removeAttribute(ATTRS.component);
      }

      get url() {
        return this.#url;
      }

      set url(url: AutomergeUrl | null) {
        if (this.#url === url) return;
        this.#url = url;
        const attr = this.getAttribute(ATTRS.url);
        if (attr == url) return;
        if (url) this.setAttribute(ATTRS.url, url);
        else this.removeAttribute(ATTRS.url);
      }

      get docUrl(): AutomergeUrl | null {
        return this.getAttribute(ATTRS.docUrl) as AutomergeUrl | null;
      }

      set docUrl(url: AutomergeUrl | null) {
        if (this.docUrl === url) return;
        if (url) this.setAttribute(ATTRS.docUrl, url);
        else this.removeAttribute(ATTRS.docUrl);
      }

      get toolId(): string | null {
        return this.getAttribute(ATTRS.toolId);
      }

      set toolId(id: string | null) {
        if (this.toolId === id) return;
        if (id) this.setAttribute(ATTRS.toolId, id);
        else this.removeAttribute(ATTRS.toolId);
      }

      get packageUrl(): string | null {
        return this.getAttribute(ATTRS.packageUrl);
      }

      set packageUrl(url: string | null) {
        if (this.packageUrl === url) return;
        if (url) this.setAttribute(ATTRS.packageUrl, url);
        else this.removeAttribute(ATTRS.packageUrl);
      }

      static get observedAttributes() {
        return [
          ATTRS.component,
          ATTRS.url,
          ATTRS.docUrl,
          ATTRS.toolId,
          ATTRS.packageUrl,
        ];
      }

      connectedCallback() {
        this.#capturedParent = this.parentElement;
        (this as { hive?: AutomergeRepoKeyhive }).hive = params.hive;
        this.#component = this.getAttribute(ATTRS.component);
        this.#url = this.getAttribute(ATTRS.url) as AutomergeUrl | null;
        // A same-task remove-and-reinsert (keyed reorder, `insertBefore`)
        // reconnects while the disconnect's teardown is still in flight;
        // syncing now would no-op against the not-yet-reset state and the
        // view would stay blank forever. Wait the teardown out.
        if (this.#teardown.pending) void this.#afterTeardown();
        else this.#sync();
      }

      async #afterTeardown() {
        await this.#teardown.pending;
        this.#sync();
      }

      disconnectedCallback() {
        // The overlay outlives attribute re-syncs; only a real disconnect lets
        // it go. Detached now so a reconnect gets a fresh one, disposed once
        // the teardown has run.
        const overlayRepo = this.#overlayRepo;
        this.#overlayRepo = null;
        this.#retryAttempt = 0;
        void this.#disposeAfterTeardown(overlayRepo);
      }

      async #disposeAfterTeardown(overlayRepo: OverlayRepo | null) {
        await this.#teardown.run();
        overlayRepo?.dispose();
      }

      connectedMoveCallback() {
        this.#capturedParent = this.parentElement;
        this.#legacyImpl?.connectedMoveCallback();
      }

      attributeChangedCallback(
        attrName: string,
        old: string | null,
        val: string | null
      ) {
        if (old === val) return;

        if (attrName === ATTRS.component) this.#component = val;
        else if (attrName === ATTRS.url) this.#url = val as AutomergeUrl | null;

        if (this.#legacyImpl && !this.#wantsComponent()) {
          if (
            attrName === ATTRS.docUrl ||
            attrName === ATTRS.toolId ||
            attrName === ATTRS.packageUrl
          ) {
            this.#legacyImpl.attributeChangedCallback(attrName, old, val);
          }
          return;
        }

        // While a `component` attribute is set, doc-url, tool-id and
        // package-url are ignored.
        if (this.#state !== State.none && this.#wantsComponent()) {
          if (attrName !== ATTRS.component && attrName !== ATTRS.url) return;
        }

        // A different component or doc starts the back-off over.
        this.#retryAttempt = 0;
        void this.#restart();
      }

      // Every remount goes through `#sync`, which won't mount a detached
      // element, so a view removed while the teardown was in flight stays down.
      async #restart() {
        await this.#teardown.run();
        this.#sync();
      }

      #wantsComponent() {
        return this.hasAttribute(ATTRS.component);
      }

      #wantsLegacy() {
        return (
          !this.hasAttribute(ATTRS.component) &&
          (this.hasAttribute(ATTRS.docUrl) ||
            this.hasAttribute(ATTRS.toolId) ||
            this.hasAttribute(ATTRS.packageUrl))
        );
      }

      #sync() {
        // Attributes change on detached elements too (a framework sets them
        // before inserting), and async remounts can land after a disconnect;
        // nothing would ever tear down a detached mount.
        if (!this.isConnected) return;

        if (this.#wantsLegacy()) {
          this.#renderLegacy();
          return;
        }

        if (this.#wantsComponent()) {
          // Only here: legacy mode leaves `display` to sites' CSS rules on
          // `patchwork-view` (`display: block`, say).
          if (!this.style.display) this.style.display = "contents";
          this.#initComponent();
        }
      }

      #renderLegacy() {
        if (this.#legacyImpl) return;
        this.#legacyImpl = new LegacyImpl(this, {
          repo: this.#ensureOverlayRepo(),
          baseRepo: params.repo,
          hive: params.hive,
        });
        this.#legacyImpl.connectedCallback();
      }

      // One per element (it asks from `this`), over the one shared base repo.
      #ensureOverlayRepo(): Repo {
        if (!this.#overlayRepo) {
          this.#overlayRepo = new OverlayRepo(params.repo, this);
          this.repo = this.#overlayRepo as unknown as Repo;
        }
        return this.repo;
      }

      #initComponent = async () => {
        if (this.#state != State.none) return;
        if (!this.component) return;

        const epoch = ++this.#initEpoch;
        this.#state = State.initializing;

        const url = this.url;
        if (url) {
          const hasAccess = await gateOnAccess(
            params.hive,
            url,
            this.#teardowns,
            (granted) => this.#onAccessChange(granted)
          );
          if (epoch !== this.#initEpoch) return;
          if (!hasAccess) {
            this.#state = State.unable;
            this.#unableNoAccess = true;
            return;
          }

          // Access is confirmed, but the doc's content may not have synced
          // yet.
          if (params.hive && isKeyhiveDoc(url)) {
            const progress = params.repo.findWithProgress(url);
            const initial = progress.peek();
            if (initial.state === "failed") {
              this.#onLoadFailed(url, initial.error, epoch);
              return;
            }
            if (initial.state !== "ready") {
              this.#state = State.unable;
              if (initial.state === "unavailable") {
                this.#onUnavailable(url, epoch);
              }
              const unsubscribe = progress.subscribe((queryState) => {
                if (epoch !== this.#initEpoch) return;
                if (queryState.state === "ready") {
                  void this.#restart();
                } else if (queryState.state === "unavailable") {
                  this.#onUnavailable(url, epoch);
                } else if (queryState.state === "failed") {
                  this.#onLoadFailed(url, queryState.error, epoch);
                }
              });
              this.#teardowns.add(unsubscribe);
              return;
            }
          }
          this.#retryAttempt = 0;
        }

        if (epoch !== this.#initEpoch) return;

        // A package that brings this component, or a new version of one.
        const loadAdded = (entry: PackageEntry) => {
          const view = this.component
            ? packages.plugin(COMPONENT, this.component)
            : undefined;
          if (view?.package === entry) this.#load(view);
        };
        const removeAddedListener = packages.on("added", loadAdded);
        const removeReplacedListener = packages.on("replaced", loadAdded);

        const removeLoadedListener = packages.on("loaded", async (loaded) => {
          if (loaded.type !== COMPONENT || loaded.id !== this.component) return;

          if (this.#state == "unable" || this.#state == "initializing") {
            this.#queueRender();
            return;
          }

          // Hot reload: a newer importUrl re-mounts.
          if (this.#state == "error" || this.#state == "rendered") {
            if (loaded.importUrl !== this.#loaded?.importUrl) {
              await this.#restart();
            }
          }
        });

        this.#teardowns.add(() => {
          removeAddedListener();
          removeReplacedListener();
          removeLoadedListener();
        });

        if (epoch !== this.#initEpoch) return;

        this.#queueRender();
      };

      // Once it's in, the "loaded" listener renders it.
      #load(view: PluginView) {
        packages.load(view).catch((error) => {
          console.warn(
            `patchwork-view: failed to load component "${view.id}"`,
            error
          );
        });
      }

      // A failed load isn't final: the doc may just not have synced yet. The
      // restart runs through the normal teardown, so the epoch, the teardowns
      // and the serialized `#restart` keep a stale timer from landing; the
      // timer is itself a teardown, so a disconnect or a newer restart clears
      // it.
      #onLoadFailed(url: AutomergeUrl, error: Error, epoch: number) {
        console.error(`patchwork-view: failed to load ${url}`, error);
        if (this.#state === State.error) return;
        this.#state = State.error;
        this.#scheduleRetry(url, epoch);
      }

      // The state a view really gets stuck in: the doc isn't there yet, and
      // nothing re-asks. The subscription stays, so a `ready` that comes
      // before the timer restarts at once (the restart clears the timer).
      #onUnavailable(url: AutomergeUrl, epoch: number) {
        this.#scheduleRetry(url, epoch);
      }

      // One timer at a time; a repeat report while it's pending keeps it.
      #scheduleRetry(url: AutomergeUrl, epoch: number) {
        if (this.#retryTimer) return;
        const delay = loadRetryDelay(this.#retryAttempt++);
        resyncBeforeRetry(params.repo, url, (err) =>
          log("resync of %s failed: %o", url, err)
        );
        this.#retryTimer = setTimeout(() => {
          this.#retryTimer = null;
          if (epoch === this.#initEpoch) void this.#restart();
        }, delay);
        this.#teardowns.add(() => {
          if (this.#retryTimer) clearTimeout(this.#retryTimer);
          this.#retryTimer = null;
        });
      }

      async #runTeardown() {
        if (this.#legacyImpl) {
          const impl = this.#legacyImpl;
          this.#legacyImpl = null;
          await impl.disconnectedCallback();
        }

        if (this.#state != State.none) {
          // Only `rendered` reached the `MountedEvent` dispatch.
          const wasMounted = this.#state == State.rendered;
          const mountedComponentId = this.#loaded?.id;

          this.#initEpoch++;
          await this.#teardowns.run();

          this.#loaded = null;
          this.#unableNoAccess = false;
          this.#state = State.none;

          if (wasMounted && mountedComponentId) {
            dispatchFromNearestConnected(
              this,
              this.#capturedParent,
              new UnmountedEvent({ componentId: mountedComponentId })
            );
          }
        }

        this.#overlayRepo?.dispose();
        this.#overlayRepo = null;
      }

      #onAccessChange(hasAccess: boolean) {
        const granted =
          hasAccess && this.#state === State.unable && this.#unableNoAccess;
        const revoked = !hasAccess && this.#state === State.rendered;
        if (granted || revoked) void this.#restart();
      }

      #queueRender() {
        if (this.#state == "none") return;
        if (this.#state == "rendering") return;
        this.#state = "rendering";
        const epoch = this.#initEpoch;
        queueMicrotask(() => {
          if (this.#mayRender(epoch)) this.#renderComponent();
        });
      }

      // A render mustn't land during a teardown: its cleanup would join a set
      // the teardown already drained, and never run. The epoch bumps first
      // thing, but database listeners can queue a render (with the new epoch)
      // until their own cleanup runs, hence the in-flight check.
      #mayRender(epoch: number) {
        return epoch === this.#initEpoch && !this.#teardown.pending;
      }

      #renderComponent() {
        if (this.#state != "rendering") return;
        if (!this.component) {
          this.#state = "unable";
          return;
        }

        const componentId = this.component;
        this.#loaded =
          (packages.plugin(COMPONENT, componentId) as ComponentView) ?? null;

        if (!this.#loaded) {
          this.#state = "unable";
          console.warn(
            `patchwork-view: no component registered with id "${componentId}"`
          );
          return;
        }

        if (!this.#loaded.module) {
          this.#state = "unable";
          log(`loading component "${componentId}"`);
          this.#load(this.#loaded);
          return;
        }

        try {
          // `element.repo` for components that want the remappers above; the
          // render fn still gets the base repo.
          this.#ensureOverlayRepo();
          const cleanup = this.#loaded.module(this, params.repo);
          if (typeof cleanup === "function") {
            this.#teardowns.add(cleanup);
          } else {
            console.warn(`return a cleanup function from ${componentId}`);
          }
          this.#state = "rendered";
          this.dispatchEvent(new MountedEvent({ componentId }));
        } catch (error) {
          console.error(
            `patchwork-view: component "${componentId}" threw during mount`,
            error
          );
          this.#state = "error";
        }
      }
    }
  );
}
