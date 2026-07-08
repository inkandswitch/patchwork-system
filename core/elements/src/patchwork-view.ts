import type { AutomergeUrl, Repo } from "@automerge/automerge-repo";
import type { LegacyAutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";
import {
  getRegistry,
  isLoadablePlugin,
  type LoadablePlugin,
  type LoadedPlugin,
  type PluginDescription,
} from "@inkandswitch/patchwork-plugins";
import { OverlayRepo } from "@inkandswitch/patchwork-providers";
import { MountedEvent, UnmountedEvent } from "./events.js";
import { LegacyImpl } from "./legacy-impl.js";
import { isUnprotectedDoc } from "@automerge/automerge-repo-keyhive";

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
  hive?: LegacyAutomergeRepoKeyhive;
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

export type LegacyPatchworkViewElement = PatchworkViewElementBase & {
  hive?: LegacyAutomergeRepoKeyhive;
};

export function registerPatchworkViewElement(
  params: RegisterPatchworkViewElementParams
) {
  const name = params.name ?? "patchwork-view";

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
      #teardowns = new Set<() => unknown | Promise<void>>();
      #keyhiveRetrySetup = false;
      #handlingKeyhiveSync = false;
      #pendingKeyhiveSync = false;
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
        (this as { hive?: LegacyAutomergeRepoKeyhive }).hive = params.hive;
        this.#component = this.getAttribute(ATTRS.component);
        this.#url = this.getAttribute(ATTRS.url) as AutomergeUrl | null;
        this.#sync();
      }

      disconnectedCallback() {
        void this.#teardown();
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
        void this.#teardown().then(() => this.#sync());
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
          hostName: name,
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

        if (params.hive && this.url) {
          const isKeyhiveDoc = !isUnprotectedDoc(this.url);

          if (isKeyhiveDoc) {
            const bestAccess = await params.hive.bestAccessForDoc(
              params.hive.active.individual.id,
              this.url
            );
            const accessLevel = bestAccess ? bestAccess.toString() : "None";

            if (accessLevel === "None") {
              this.#state = State.unable;
              this.#unableNoAccess = true;

              if (!this.#keyhiveRetrySetup) {
                this.#keyhiveRetrySetup = true;
                const onKeyhiveSync = () => this.#handleKeyhiveSync();
                params.hive.networkAdapter.on("ingest-remote", onKeyhiveSync);
                this.#teardowns.add(() => {
                  params.hive!.networkAdapter.off(
                    "ingest-remote",
                    onKeyhiveSync
                  );
                });
              }
              return;
            }
          }

          if (!this.#keyhiveRetrySetup) {
            this.#keyhiveRetrySetup = true;
            const onKeyhiveSync = () => this.#handleKeyhiveSync();
            params.hive.networkAdapter.on("ingest-remote", onKeyhiveSync);
            this.#teardowns.add(() => {
              params.hive!.networkAdapter.off("ingest-remote", onKeyhiveSync);
            });
          }

          if (isKeyhiveDoc) {
            // Access is confirmed, but the doc's content may not have synced
            // yet.
            const progress = params.repo.findWithProgress(
              this.url as AutomergeUrl
            );
            if (progress.peek().state !== "ready") {
              this.#state = State.unable;
              const unsubscribe = progress.subscribe((queryState) => {
                if (
                  queryState.state === "ready" &&
                  epoch === this.#initEpoch
                ) {
                  void this.#teardown().then(() => this.#sync());
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
              await this.#teardown();
              this.#sync();
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

      async #teardown() {
        if (this.#legacyImpl) {
          await this.#legacyImpl.disconnectedCallback();
          this.#legacyImpl = null;
        }

        if (this.#state == State.none) return;

        // Only `rendered` reached the `MountedEvent` dispatch.
        const wasMounted = this.#state == State.rendered;
        const mountedComponentId = this.#loaded?.id;

        this.#initEpoch++;

        for (const fn of this.#teardowns) {
          await fn?.();
        }

        this.#teardowns.clear();
        this.#loaded = null;
        this.#keyhiveRetrySetup = false;
        this.#unableNoAccess = false;
        this.#state = State.none;

        if (wasMounted && mountedComponentId) {
          this.#dispatchUnmount(
            new UnmountedEvent({ componentId: mountedComponentId })
          );
        }
      }

      // Bubbling is a no-op when detached; fall back to the closest
      // still-connected ancestor.
      #dispatchUnmount(event: UnmountedEvent) {
        if (this.isConnected) {
          this.dispatchEvent(event);
          return;
        }
        let node: Element | null = this.#capturedParent;
        while (node && !node.isConnected) node = node.parentElement;
        if (node) node.dispatchEvent(event);
      }

      async #handleKeyhiveSync() {
        if (!this.url || !params.hive) return;

        if (this.#handlingKeyhiveSync) {
          this.#pendingKeyhiveSync = true;
          return;
        }
        this.#handlingKeyhiveSync = true;
        this.#pendingKeyhiveSync = false;

        try {
          let hasAccess = false;
          let accessCheckSucceeded = false;
          try {
            if (isUnprotectedDoc(this.url)) return;
            const bestAccess = await params.hive.bestAccessForDoc(
              params.hive.active.individual.id,
              this.url
            );
            hasAccess = !!bestAccess;
            accessCheckSucceeded = true;
          } catch {
            return;
          }

          const isDisplayed = this.#state === State.rendered;
          const isUnable = this.#state === State.unable;

          if (hasAccess && isUnable && this.#unableNoAccess) {
            // Was unable because access hadn't synced, but it just did. Re-sync.
            await this.#teardown();
            this.#sync();
          } else if (!hasAccess && isDisplayed && accessCheckSucceeded) {
            await this.#teardown();
            this.#sync();
          }
        } finally {
          this.#handlingKeyhiveSync = false;
          if (this.#pendingKeyhiveSync) {
            this.#handleKeyhiveSync();
          }
        }
      }

      #queueRender() {
        if (this.#state == "none") return;
        if (this.#state == "rendering") return;
        this.#state = "rendering";
        queueMicrotask(() => this.#renderComponent());
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
            console.info(`patchwork-view: loading component "${componentId}"`);
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
