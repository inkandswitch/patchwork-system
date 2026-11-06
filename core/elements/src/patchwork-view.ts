import type { AutomergeUrl, Repo } from "@automerge/automerge-repo/slim";
import type { AutomergeRepoKeyhiveBase as AutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";
import { gateOnAccess } from "./keyhive-access.js";
import {
  getRegistry,
  isKeyhiveDoc,
  isLoadablePlugin,
  type LoadablePlugin,
  type LoadedPlugin,
  type PluginDescription,
} from "@inkandswitch/patchwork-plugins";
import {
  OverlayRepo,
  registerPatchworkViewTag,
} from "@inkandswitch/patchwork-providers";
import { MountedEvent, UnmountedEvent } from "./events.js";
import { LegacyImpl } from "./legacy-impl.js";
import {
  dispatchFromNearestConnected,
  Serialized,
  Teardowns,
} from "./lifecycle.js";
import debug from "debug";

const log = debug("patchwork:elements:patchwork-view");

/**
 * A component receives the element it is mounted on plus the realm-local base
 * `Repo`. The base repo (not the overlay shim) is handed to components so
 * providers that answer `repo:handle-descriptor` can clone/create against the
 * real repo without re-entering their own remapping.
 */
export type ComponentRender = (
  element: PatchworkViewElement,
  repo: Repo
) => () => void;

export type ComponentDescription = PluginDescription & {
  id: string;
  type: "patchwork:component";
  name: string;
  icon?: string;
  tags?: string[];
};

export type LoadedComponent = LoadedPlugin<
  ComponentDescription,
  ComponentRender
>;

export type Component = LoadablePlugin<ComponentDescription, ComponentRender>;

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
} as const;

export type RegisterPatchworkViewElementParams = {
  name?: string;
  /**
   * The realm-local base `Repo`. Each `<patchwork-view>` wraps it in an
   * {@link OverlayRepo} (exposed as `element.repo`) so legacy-mode tools
   * resolve their primary handle through the remapping shim. Components also
   * get `element.repo`, but the base repo is passed to the component render fn
   * directly so `repo:handle-descriptor`-answering providers don't re-enter.
   */
  repo: Repo;
  /**
   * Threaded into the `LegacyImpl` so legacy-mode tools get access to a
   * Keyhive instance via `element.hive`.
   */
  hive?: AutomergeRepoKeyhive;
};

// Shared shape for every `<patchwork-view>` instance, regardless of whether it
// renders a component or a legacy tool. `repo` (the per-element overlay shim)
// is always provisioned before the mounted code runs - see `#ensureOverlayRepo`,
// called on both the legacy and component render paths - so it is non-optional.
export type PatchworkViewElementBase = HTMLElement & {
  repo: Repo;
  docUrl?: AutomergeUrl | null;
  toolId?: string | null;
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
      #loaded: LoadedComponent | null = null;
      #state: State = State.none;
      #initEpoch = 0;
      #teardowns = new Teardowns();
      #teardown = new Serialized(() => this.#runTeardown());
      // True when `unable` because access hasn't synced yet.
      // Receiving a keyhive op can recover this.
      #unableNoAccess = false;

      // Realm-local remapping shim, created lazily on first render. Exposed as
      // `element.repo` so tools resolve their primary handle through it.
      #overlayRepo: OverlayRepo | null = null;
      repo!: Repo;

      // In legacy mode, the legacy view logic is hosted on *this*
      // element (not a child) so events dispatched on `<patchwork-view>`
      // and listeners attached by the mounted tool land on the same
      // DOM node — matching the pre-split behavior.
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

      static get observedAttributes() {
        return [ATTRS.component, ATTRS.url, ATTRS.docUrl, ATTRS.toolId];
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
        // The overlay repo survives attribute-driven re-syncs; only a real
        // disconnect releases it. Detach now so a re-connect gets a fresh
        // shim, then dispose once the teardown has run.
        const overlayRepo = this.#overlayRepo;
        this.#overlayRepo = null;
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

        // Already in legacy mode and still want it: forward doc-url /
        // tool-id changes into the impl so it tears down and re-inits
        // without us having to rebuild the element.
        if (this.#legacyImpl && !this.#wantsComponent()) {
          if (attrName === ATTRS.docUrl || attrName === ATTRS.toolId) {
            this.#legacyImpl.attributeChangedCallback(attrName, old, val);
          }
          return;
        }

        // Already mounting a component and still want one: only react
        // to the component-driving attributes; doc-url / tool-id are
        // ignored while a `component` attribute is set.
        if (this.#state !== State.none && this.#wantsComponent()) {
          if (attrName !== ATTRS.component && attrName !== ATTRS.url) return;
        }

        // Either transitioning between forms or initial setup after an
        // attribute landed on an idle element. Tear down whatever is
        // there (no-op when idle) and re-sync against the attributes.
        void this.#restart();
      }

      // Tear down and mount again against the current attributes. Every
      // remount goes through `#sync`, which won't mount a detached element, so
      // a view removed while the teardown was in flight stays down.
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
          (this.hasAttribute(ATTRS.docUrl) || this.hasAttribute(ATTRS.toolId))
        );
      }

      #sync() {
        // Attributes change on detached elements too (a framework sets them
        // before inserting), and async remounts can land after a disconnect.
        // Only a connected element mounts; `connectedCallback` syncs on
        // (re)insertion, and nothing would ever tear down a detached mount.
        if (!this.isConnected) return;

        if (this.#wantsLegacy()) {
          this.#renderLegacy();
          return;
        }

        if (this.#wantsComponent()) {
          // Legacy mode leaves `display` alone so sites' CSS rules on
          // `patchwork-view` (e.g. `display: block`) apply.
          if (!this.style.display) this.style.display = "contents";
          this.#initComponent();
        }
      }

      #renderLegacy() {
        if (this.#legacyImpl) return;
        this.#legacyImpl = new LegacyImpl(this, {
          repo: this.#ensureOverlayRepo(),
          hive: params.hive,
        });
        this.#legacyImpl.connectedCallback();
      }

      // The overlay shim is per-element (it dispatches `repo:handle-descriptor`
      // from `this`) but wraps the single shared base repo.
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

        const registry = getRegistry<ComponentDescription>(
          "patchwork:component"
        );

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
              console.error(
                `patchwork-view: failed to load ${url}`,
                initial.error
              );
              this.#state = State.error;
              return;
            }
            if (initial.state !== "ready") {
              this.#state = State.unable;
              const unsubscribe = progress.subscribe((queryState) => {
                if (epoch !== this.#initEpoch) return;
                if (queryState.state === "ready") {
                  void this.#restart();
                } else if (queryState.state === "failed") {
                  console.error(
                    `patchwork-view: failed to load ${url}`,
                    queryState.error
                  );
                  this.#state = State.error;
                }
              });
              this.#teardowns.add(unsubscribe);
              return;
            }
          }
        }

        if (epoch !== this.#initEpoch) return;

        const removeAddedListener = registry.on("registered", async (added) => {
          if (added.id !== this.component) return;
          if (isLoadablePlugin(added)) {
            registry.load(added.id);
          }
        });

        const removeLoadedListener = registry.on("loaded", async (loaded) => {
          if (loaded.id !== this.component) return;

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
          removeLoadedListener();
        });

        if (epoch !== this.#initEpoch) return;

        this.#queueRender();
      };

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

      // Access to the mounted doc changed: mount once it's granted, unmount
      // once it's revoked.
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

      // A render queued before a teardown began must not land while it runs:
      // its cleanup would join a set the teardown has already drained, and
      // nothing would ever call it. Teardown bumps the epoch first thing, but
      // registry listeners can queue a fresh render (with the new epoch)
      // until their own cleanup runs, hence the in-flight check too.
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
        const registry = getRegistry<LoadedComponent>("patchwork:component");
        this.#loaded = registry.get(componentId) ?? null;

        if (!this.#loaded) {
          this.#state = "unable";
          console.warn(
            `patchwork-view: no component registered with id "${componentId}"`
          );
          return;
        }

        if (!this.#loaded.module) {
          registry.load(this.#loaded.id);
          if (registry.isLoading(this.#loaded.id)) {
            this.#state = "unable";
            log(`loading component "${componentId}"`);
          } else {
            this.#state = "unable";
            console.warn(
              `patchwork-view: failed to load component "${componentId}"`
            );
          }
          return;
        }

        try {
          // Expose `element.repo` (the overlay shim) so components that want
          // ancestor-remapped resolution can opt in; the render fn still
          // receives the base repo (see ComponentRender docs).
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
