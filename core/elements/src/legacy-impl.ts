import {
  type AutomergeUrl,
  type DocHandle,
  type DocHandleChangePayload,
  type Repo,
} from "@automerge/automerge-repo";
import {
  getSuggestedImportUrl,
  getType,
  importPackage,
  type HasPatchworkMetadata,
} from "@inkandswitch/patchwork-filesystem";
import {
  getFallbackTool,
  getRegistry,
  isLoadablePlugin,
  registerPlugins,
  type LoadedTool,
  type ToolDescription,
  type ToolElement,
} from "@inkandswitch/patchwork-plugins";
import debug from "debug";
import {
  docIdFromAutomergeUrl,
  type initializeAutomergeRepoKeyhive,
} from "@automerge/automerge-repo-keyhive";
import { MountedEvent, UnmountedEvent } from "./events.js";

const log = debug("patchwork:elements:legacy");

/**
 * Whether `tool` supports `type` only through a `*` wildcard rather than by
 * naming the datatype explicitly. A wildcard-only match means the tool is a
 * generic fallback (e.g. a raw viewer), not a tool built for this datatype.
 */
function isWildcardOnlyMatch(
  tool: LoadedTool,
  type: string | undefined
): boolean {
  const datatypes = tool.supportedDatatypes;
  const list = datatypes === "*" ? ["*"] : datatypes;
  return list.includes("*") && (type === undefined || !list.includes(type));
}

type AutomergeRepoKeyhive = Awaited<
  ReturnType<typeof initializeAutomergeRepoKeyhive>
>;

const State = {
  none: "none",
  initializing: "initializing",
  rendering: "rendering",
  unable: "unable",
  rendered: "rendered",
  fallback: "fallback",
  error: "error",
} as const;

type State = (typeof State)[keyof typeof State];

const ATTRS = {
  docUrl: "doc-url",
  toolId: "tool-id",
} as const;

export type LegacyImplParams = {
  /**
   * Repo used to resolve the primary doc handle. This is the
   * `<patchwork-view>`'s overlay shim, so the handle the tool receives is
   * remapped (e.g. to a draft clone) when a remapper answers
   * `repo:handle-descriptor`.
   */
  repo: Repo;
  hive?: AutomergeRepoKeyhive;
};

type HostElement = HTMLElement & {
  repo?: Repo;
  hive?: AutomergeRepoKeyhive;
};

const ERROR_STYLE_ID = "patchwork-view-error-style";

// Distinct ids so each view's `:(` can point its `popovertarget` at its own
// flyout.
let errorFlyoutSeq = 0;

// One shared stylesheet for every view's error UI. Colours/fonts/radii come
// from ../base/theming (the `--studio-*` custom properties) with plain
// fallbacks so the error still reads sensibly outside a themed context.
function ensureErrorStyles() {
  if (document.getElementById(ERROR_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = ERROR_STYLE_ID;
  style.textContent = /* css */ `
    .pw-error {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      min-height: 2.5em;
      padding: 1rem;
      box-sizing: border-box;
    }
    /* A single clickable :( in a little box that turns 90° when open. */
    .pw-error__face {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-family: var(--studio-family-code, ui-monospace, "SF Mono", Menlo, monospace);
      font-size: 1.25rem;
      line-height: 1;
      color: var(--studio-danger-text, #c2415f);
      background: color-mix(in oklch, var(--studio-danger-text, #c2415f), transparent 92%);
      border: 1px solid color-mix(in oklch, var(--studio-danger-text, #c2415f), transparent 60%);
      border-radius: var(--studio-radius-md, 8px);
      padding: 0.25em 0.4em;
      cursor: pointer;
      user-select: none;
      transition: transform 0.25s ease, background 0.12s ease, border-color 0.12s ease;
    }
    .pw-error__face:hover {
      background: color-mix(in oklch, var(--studio-danger-text, #c2415f), transparent 84%);
      border-color: color-mix(in oklch, var(--studio-danger-text, #c2415f), transparent 40%);
    }
    .pw-error__face[aria-expanded="true"] { transform: rotate(90deg); }

    .pw-error--offer {
      flex-direction: column;
      gap: 0.9rem;
      justify-content: center;
    }
    .pw-error__message {
      margin: 0;
      max-width: 34em;
      text-align: center;
      overflow-wrap: anywhere;
      font-family: var(--studio-family, system-ui, sans-serif);
      font-size: 0.85rem;
      line-height: 1.5;
      color: var(--studio-text, #1a1a1a);
    }
    .pw-error__actions {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    /* Offer to run the package the document names. Deliberately quiet — it
       executes third-party JavaScript, so it shouldn't read as the happy path. */
    .pw-error__load {
      display: inline-flex;
      align-items: center;
      gap: 0.35em;
      font-family: var(--studio-family, system-ui, sans-serif);
      font-size: 0.8rem;
      line-height: 1;
      color: var(--studio-text, #1a1a1a);
      background: var(--studio-fill, white);
      border: 1px solid var(--studio-fill-offset-30, rgba(0, 0, 0, 0.12));
      border-radius: var(--studio-radius-md, 8px);
      padding: 0.5em 0.7em;
      cursor: pointer;
      transition: background 0.12s ease, border-color 0.12s ease;
    }
    .pw-error__load:hover {
      background: var(--studio-fill-offset-10, rgba(0, 0, 0, 0.04));
      border-color: var(--studio-fill-offset-30, rgba(0, 0, 0, 0.24));
    }

    /* Flyout: a Popover-API callout (top layer, so it escapes any overflow
       clipping) positioned under the button in JS, with a caret + shadow. */
    .pw-error-flyout {
      position: fixed;
      margin: 0;
      inset: auto;
      width: max-content;
      max-width: min(360px, 92vw);
      padding: 0;
      border: none;
      background: transparent;
      overflow: visible;
      opacity: 0;
      transform: scale(0.97);
      transition: opacity 0.12s ease, transform 0.12s ease;
    }
    .pw-error-flyout.is-shown { opacity: 1; transform: scale(1); }
    .pw-error-flyout.is-below { transform-origin: top center; }
    .pw-error-flyout.is-above { transform-origin: bottom center; }
    .pw-error-flyout__box {
      overflow: hidden;
      border-radius: var(--studio-radius-md, 8px);
      border: 1px solid var(--studio-fill-offset-30, rgba(0, 0, 0, 0.12));
      background: var(--studio-fill, white);
      box-shadow: var(--studio-shadow-lg, 0 10px 30px rgba(0, 0, 0, 0.3));
    }
    .pw-error-flyout__body {
      margin: 0;
      padding: 0.6rem 0.7rem;
      overflow: auto;
      max-height: min(40vh, 320px);
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--studio-family-code, ui-monospace, "SF Mono", Menlo, monospace);
      font-size: 0.7rem;
      line-height: 1.5;
      color: var(--studio-danger-text, #c2415f);
    }
    /* A rotated square whose two outer edges are bordered, so it reads as a
       little triangle poking out of the box. JS sets its left; the direction
       class picks which edge it sits on. */
    .pw-error-flyout__caret {
      position: absolute;
      width: 11px;
      height: 11px;
      background: var(--studio-fill, white);
      transform: rotate(45deg);
    }
    .pw-error-flyout.is-below .pw-error-flyout__caret {
      top: -6px;
      border-top: 1px solid var(--studio-fill-offset-30, rgba(0, 0, 0, 0.12));
      border-left: 1px solid var(--studio-fill-offset-30, rgba(0, 0, 0, 0.12));
    }
    .pw-error-flyout.is-above .pw-error-flyout__caret {
      bottom: -6px;
      border-right: 1px solid var(--studio-fill-offset-30, rgba(0, 0, 0, 0.12));
      border-bottom: 1px solid var(--studio-fill-offset-30, rgba(0, 0, 0, 0.12));
    }
  `;
  document.head.append(style);
}

/**
 * `doc-url`/`tool-id`-driven legacy view behavior for `<patchwork-view>`. The
 * tool renders into an inner `.patchwork-view-content` element (the only thing
 * wiped on re-render); the host stays the identity/event node, leaving safe
 * sibling space for augmentations a tool's re-render can't trample.
 */
export class LegacyImpl {
  #element: HostElement;
  #content: HostElement;
  #repo: Repo;
  #docUrl: AutomergeUrl | null = null;
  #toolId: string | null = null;
  #handle: DocHandle<HasPatchworkMetadata> | null = null;
  #tool: LoadedTool | null = null;
  #state: State = State.none;
  #requestedToolImports = new Set<string>();
  #initEpoch = 0;
  #capturedParent: Element | null = null;
  #fallbackId: string | undefined;
  #teardowns = new Set<() => unknown | Promise<void>>();
  #teardownPromise: Promise<void> | null = null;
  #keyhiveRetrySetup = false;
  #handlingKeyhiveSync = false;
  #pendingKeyhiveSync = false;
  #unableNoAccess = false;
  #toast: HTMLElement | null = null;
  #toastTimer: ReturnType<typeof setTimeout> | null = null;
  #toastPositioned = false;
  #toastEscape: ((event: KeyboardEvent) => void) | null = null;
  #errorReposition: (() => void) | null = null;

  constructor(element: HTMLElement, params: LegacyImplParams) {
    this.#element = element as HostElement;
    this.#repo = params.repo;
    this.#element.hive = params.hive;

    // `height: 100%` makes the wrapper fill the host so tools that size/measure
    // their root element see the host's box (the wrapper carries the
    // `repo`/`hive` surface tools read off the element they're handed).
    this.#content = document.createElement("div") as HostElement;
    this.#content.className = "patchwork-view-content";
    this.#content.style.width = "100%";
    this.#content.style.height = "100%";
    this.#content.hive = params.hive;
  }

  connectedCallback(): void {
    this.#capturedParent = this.#element.parentElement;
    this.#element.appendChild(this.#content);
    this.#docUrl = this.#element.getAttribute(
      ATTRS.docUrl
    ) as AutomergeUrl | null;
    this.#toolId = this.#element.getAttribute(ATTRS.toolId);
    void this.#init();
  }

  async disconnectedCallback(): Promise<void> {
    await this.#teardown();
    this.#content.remove();
  }

  connectedMoveCallback(): void {
    this.#capturedParent = this.#element.parentElement;
  }

  attributeChangedCallback(
    name: string,
    old: string | null,
    val: string | null
  ): void {
    if (old === val) return;
    if (name === ATTRS.toolId) {
      this.#toolId = val;
      void this.#teardown().then(() => this.#init());
    }
    if (name === ATTRS.docUrl) {
      this.#docUrl = val as AutomergeUrl;
      void this.#teardown().then(() => this.#init());
    }
  }

  #onDocChange = (payload: DocHandleChangePayload<HasPatchworkMetadata>) => {
    const { before, after } = payload.patchInfo;
    if (getType(before) != getType(after)) {
      void this.#teardown().then(() => this.#init());
    }
  };

  #init = async () => {
    const toolRegistry = getRegistry<ToolDescription>("patchwork:tool");
    if (this.#state != State.none) return;
    if (!this.#docUrl) return;

    const epoch = ++this.#initEpoch;
    this.#state = State.initializing;

    if (this.#element.hive && this.#docUrl) {
      let isKeyhiveDoc = false;
      try {
        docIdFromAutomergeUrl(this.#docUrl);
        isKeyhiveDoc = true;
      } catch {
        // Legacy (padded-zero) doc: skip keyhive gate
      }

      if (isKeyhiveDoc) {
        const bestAccess = await this.#element.hive.bestAccessForDoc(
          this.#element.hive.active.individual.id,
          this.#docUrl
        );
        if (epoch !== this.#initEpoch) return;
        const accessLevel = bestAccess ? bestAccess.toString() : "None";

        if (accessLevel === "None") {
          this.#state = State.unable;
          this.#unableNoAccess = true;

          if (!this.#keyhiveRetrySetup) {
            this.#keyhiveRetrySetup = true;
            const onKeyhiveSync = () => this.#handleKeyhiveSync();
            (this.#element.hive.networkAdapter as any).on(
              "ingest-remote",
              onKeyhiveSync
            );
            this.#teardowns.add(() => {
              (this.#element.hive!.networkAdapter as any).off(
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
        (this.#element.hive.networkAdapter as any).on(
          "ingest-remote",
          onKeyhiveSync
        );
        this.#teardowns.add(() => {
          (this.#element.hive!.networkAdapter as any).off(
            "ingest-remote",
            onKeyhiveSync
          );
        });
      }
    }

    if (epoch !== this.#initEpoch) return;

    const removeAddedListener = toolRegistry.on(
      "registered",
      async (addedTool) => {
        const toolId = addedTool.id;
        const isChosenTool = toolId == this.#toolId;
        // `getFallbackTool` scans the whole registry, so recomputing it on
        // every registration is O(N²) across a load burst. A registration can
        // only change the outcome when no fallback is known yet or the new
        // tool supports this doc's type.
        if (this.#handle && this.#couldChangeFallback(addedTool)) {
          this.#fallbackId = getFallbackTool(this.#handle.doc())?.id;
        }
        const isFallbackTool = toolId == this.#fallbackId;
        if (isChosenTool || isFallbackTool) {
          if (isLoadablePlugin(addedTool)) {
            toolRegistry.load(addedTool.id);
          }
        }
      }
    );

    const removeLoadedListener = toolRegistry.on(
      "loaded",
      async (loadedTool) => {
        const toolId = loadedTool.id;
        const isChosenTool = toolId == this.#toolId;
        const isFallbackTool = toolId == this.#fallbackId;
        if (isChosenTool || isFallbackTool) {
          if (this.#state == "unable" || this.#state == "initializing") {
            this.#queueRender();
          }
          if (
            ((this.#state == "error" || this.#state == "rendered") &&
              isChosenTool) ||
            (this.#state == "fallback" && isFallbackTool)
          ) {
            if (loadedTool.importUrl !== this.#tool?.importUrl) {
              await this.#teardown();
              void this.#init();
            }
          }
        }
      }
    );

    this.#teardowns.add(() => {
      removeAddedListener();
      removeLoadedListener();
    });

    const repo = this.#repo;
    this.#element.repo = repo;
    this.#content.repo = repo;

    let handle: DocHandle<HasPatchworkMetadata>;
    try {
      handle = await repo.find<HasPatchworkMetadata>(this.#docUrl!);
    } catch (err) {
      if (epoch !== this.#initEpoch) return;
      // Every caller voids `#init`'s promise, so rethrowing would only
      // produce an unhandled rejection and wedge `#state` in `initializing`.
      // Show the error and park in `unable` so a keyhive sync (the usual
      // reason a find fails: the doc hasn't synced yet) can retry.
      console.error(`failed to load ${this.#docUrl}`, err);
      this.#state = State.unable;
      this.#unableNoAccess = true;
      const e = err as Error;
      this.#displayError(e?.message ?? String(err), e?.stack, err);
      return;
    }

    if (epoch !== this.#initEpoch) return;

    this.#handle = handle;
    this.#handle.on("change", this.#onDocChange);
    this.#teardowns.add(() => this.#handle!.off("change", this.#onDocChange));

    this.#queueRender();
  };

  // A registration can shift the fallback only when we don't have one yet or
  // the new tool supports the doc's type (a specific match sorts ahead of a
  // wildcard, so a supporting tool can displace the current pick).
  #couldChangeFallback(added: ToolDescription): boolean {
    if (!this.#fallbackId) return true;
    const supported = added.supportedDatatypes;
    if (!supported) return false;
    if (supported === "*" || supported.includes("*")) return true;
    const type = this.#handle ? getType(this.#handle.doc()) : undefined;
    return type != null && supported.includes(type);
  }

  // Serialized: overlapping calls (doc-url and tool-id both changing in one
  // tick) share the one in-flight run instead of double-running the same
  // cleanups.
  #teardown(): Promise<void> {
    if (!this.#teardownPromise) {
      this.#teardownPromise = this.#runTeardown().finally(() => {
        this.#teardownPromise = null;
      });
    }
    return this.#teardownPromise;
  }

  async #runTeardown(): Promise<void> {
    if (this.#state == State.none) return;

    // Capture the mount-event payload (if any) before clearing state,
    // so the unmount echoes the same {url, toolId} we dispatched at
    // mount. `rendered`/`fallback` are exactly the states in which
    // `#render` dispatched a MountedEvent (it sets `#tool` only after
    // the tool's module call succeeds).
    const wasMounted =
      this.#state == State.rendered || this.#state == State.fallback;
    const mountedUrl = this.#handle?.url;
    const mountedToolId = this.#tool?.id;

    this.#initEpoch++;

    const teardowns = [...this.#teardowns];
    this.#teardowns.clear();
    for (const fn of teardowns) {
      await fn?.();
    }

    this.#dismissToast(true);
    this.#removeErrorListeners();
    this.#keyhiveRetrySetup = false;
    this.#unableNoAccess = false;
    this.#handle = null;
    this.#tool = null;
    this.#requestedToolImports.clear();
    this.#content.textContent = "";
    this.#state = State.none;

    if (wasMounted && mountedUrl && mountedToolId) {
      this.#dispatchUnmount(
        new UnmountedEvent({ url: mountedUrl, toolId: mountedToolId })
      );
    }
  }

  // Detached elements have no parent path, so `bubbles: true` is a
  // no-op; fall back to the closest still-connected ancestor.
  #dispatchUnmount(event: UnmountedEvent): void {
    if (this.#element.isConnected) {
      this.#element.dispatchEvent(event);
      return;
    }
    let node: Element | null = this.#capturedParent;
    while (node && !node.isConnected) node = node.parentElement;
    if (node) node.dispatchEvent(event);
  }

  async #clearDocCache(): Promise<void> {
    if (!this.#docUrl || !this.#element.repo) return;

    const retryingDocs = ((globalThis as any).__patchwork_retrying_docs ??=
      new Set<string>());
    if (retryingDocs.has(this.#docUrl)) return;

    retryingDocs.add(this.#docUrl);
    try {
      const documentId = String(docIdFromAutomergeUrl(this.#docUrl));
      const handle = (this.#element.repo.handles as any)[documentId];
      if (handle && handle.state === "unavailable") {
        this.#element.repo.delete(this.#docUrl);
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 300));
    retryingDocs.delete(this.#docUrl);
  }

  async #handleKeyhiveSync(): Promise<void> {
    if (!this.#docUrl || !this.#element.hive) return;

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
        docIdFromAutomergeUrl(this.#docUrl);
        const bestAccess = await this.#element.hive.bestAccessForDoc(
          this.#element.hive.active.individual.id,
          this.#docUrl
        );
        hasAccess = !!bestAccess;
        accessCheckSucceeded = true;
      } catch {
        return;
      }

      const isDisplayed =
        this.#state === State.rendered || this.#state === State.fallback;
      const isUnable = this.#state === State.unable;

      if (hasAccess && isUnable && this.#unableNoAccess) {
        await this.#clearDocCache();
        await this.#teardown();
        void this.#init();
      } else if (!hasAccess && isDisplayed && accessCheckSucceeded) {
        await this.#clearDocCache();
        await this.#teardown();
        void this.#init();
      }
    } finally {
      this.#handlingKeyhiveSync = false;
      if (this.#pendingKeyhiveSync) {
        this.#handleKeyhiveSync();
      }
    }
  }

  #queueRender(): void {
    if (this.#state == "none") return;
    if (this.#state == "rendering") return;
    this.#state = "rendering";
    queueMicrotask(() => this.#render());
  }

  #render(): void {
    if (this.#state != "rendering") return;
    if (!this.#docUrl || !this.#handle) {
      this.#state = "unable";
      return;
    }

    this.#resetDisplay();

    const doc = this.#handle.doc();
    const fallbackTool = getFallbackTool(doc);
    this.#fallbackId = fallbackTool?.id;
    const fallingBack = !this.#toolId;
    const toolId = this.#toolId || this.#fallbackId;

    // A wildcard fallback tool (`supportedDatatypes: ["*"]`) supports this doc
    // only generically, not because it's built for the doc's datatype — it's a
    // stopgap we render while we try to load something better.
    const mountingWildcardStopgap =
      fallingBack &&
      !!fallbackTool &&
      isWildcardOnlyMatch(fallbackTool, getType(doc));

    if (fallingBack) {
      console.warn(`falling back to default tool for ${this.#docUrl}`);
      // For a wildcard stopgap, also offer the doc's suggested import so a
      // datatype-specific tool can load, at which point the registry listeners
      // above swap it in (it sorts ahead of the wildcard as the new fallback).
      // We still render the wildcard tool in the meantime, so the offer goes in
      // a toast rather than replacing what's mounted.
      if (mountingWildcardStopgap) {
        const suggestion = this.#suggestedImport();
        if (suggestion && !suggestion.loading) {
          this.#showToast(
            "This document suggests a package",
            suggestion.url,
            () => this.#loadSuggestedImport(suggestion.url)
          );
        }
      }
    }

    if (!toolId) {
      this.#state = "unable";
      // The doc's datatype has no registered tool and no explicit tool was
      // requested. If the doc points at a module to import, offer it — the
      // registry listeners re-render once an accepted import registers a
      // supporting tool. Otherwise there's genuinely nothing to open.
      const suggestion = this.#suggestedImport();
      if (suggestion) {
        if (suggestion.loading) this.#displayLoading("");
        else this.#displaySuggestion(suggestion.url);
        return;
      }
      const hasPatchworkMetadata = doc && "@patchwork" in doc;
      if (!hasPatchworkMetadata) {
        console.warn(`Document ${this.#docUrl} is missing @patchwork metadata`);
        this.#displayError(
          `This document is missing @patchwork metadata and cannot be opened.`
        );
      } else {
        console.warn(`no tool for ${this.#docUrl}`);
        this.#displayError(`I couldn't find a tool to open ${this.#docUrl}.`);
      }
      return;
    }

    this.#tool = getRegistry<LoadedTool>("patchwork:tool").get(toolId) ?? null;

    if (!this.#tool) {
      this.#state = "unable";
      // The requested tool isn't loaded. If the doc suggests a module to import
      // it from, offer that; otherwise there's nothing more to try.
      const suggestion = this.#suggestedImport();
      if (!suggestion) {
        this.#displayError(`I couldn't find the tool with id ${toolId}.`);
      } else if (suggestion.loading) {
        this.#displayLoading(toolId);
      } else {
        this.#displaySuggestion(suggestion.url);
      }
      return;
    }

    if (!this.#tool.module) {
      const toolRegistry = getRegistry("patchwork:tool");
      toolRegistry.load(this.#tool.id);
      if (toolRegistry.isLoading(this.#tool.id)) {
        this.#state = "unable";
        log(`loading ${toolId}`);
        this.#displayLoading(toolId);
      } else {
        this.#state = "unable";
        this.#displayError(`I couldn't load the tool with id ${toolId}.`);
      }
      return;
    }

    try {
      // `#init` set the content element's `repo` before reaching `#queueRender`,
      // so it satisfies `ToolElement`'s non-optional `repo`.
      const cleanup = this.#tool.module(
        this.#handle,
        this.#content as ToolElement
      );
      if (typeof cleanup === "function") {
        this.#teardowns.add(cleanup);
      } else {
        console.warn(`return a cleanup function from ${toolId}`);
      }
      // Mounting a datatype-specific tool (or an explicitly chosen one) means an
      // editor was found, so retire the "loading suggested import" toast. A
      // wildcard stopgap keeps it up — we're still waiting on the real tool.
      if (!mountingWildcardStopgap) this.#dismissToast();
      this.#state = fallingBack ? "fallback" : "rendered";
      this.#element.dispatchEvent(
        new MountedEvent({ url: this.#docUrl, toolId })
      );
    } catch (error) {
      const err = error as Error;
      this.#displayError(err?.message ?? String(error), err?.stack, error);
      console.error(error);
      this.#state = "error";
    }
  }

  #displayLoading = (_toolId: string) => {
    const div = document.createElement("div");
    div.style.display = "flex";
    div.style.alignItems = "center";
    div.style.justifyContent = "center";
    div.style.height = "100%";
    div.style.opacity = "0";
    div.style.transition = "opacity 0.8s ease-in";
    div.innerHTML = /* html */ `
      <style>
        @keyframes pw-loading-pulse {
          0%, 100% { opacity: 0; transform: scale(0); }
          50% { opacity: 1; transform: scale(1); }
        }
      </style>
      <div style="
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #888;
        animation: pw-loading-pulse 2s ease-in-out infinite;
      "></div>
    `;
    this.#content.append(div);
    const timer = setTimeout(() => {
      div.style.opacity = "1";
    }, 2000);
    this.#teardowns.add(() => clearTimeout(timer));
  };

  // A lone `:(` that fades in instead of a bare details triangle. Clicking it
  // rotates it 90° and pops the full error (message + stack) as a caret flyout
  // under the button; `original` is what gets re-logged when it opens so it's
  // easy to grab from the console again.
  #displayError = (
    summary: string,
    detail?: string,
    original?: unknown,
    action?: { label: string; run: () => void }
  ) => {
    ensureErrorStyles();

    // Stacks usually begin with the message already; only prepend the summary
    // as a headline when the detail doesn't lead with it.
    const full =
      detail && !detail.startsWith(summary)
        ? `${summary}\n\n${detail}`
        : (detail ?? summary);

    const flyoutId = `pw-error-flyout-${++errorFlyoutSeq}`;
    // A `popover` renders in the top layer, so the flyout floats above (and
    // escapes the overflow clipping of) whatever the view is nested in.
    const flyout = document.createElement("div");
    flyout.className = "pw-error-flyout";
    flyout.id = flyoutId;
    flyout.setAttribute("popover", "auto");
    const box = document.createElement("div");
    box.className = "pw-error-flyout__box";
    const body = document.createElement("pre");
    body.className = "pw-error-flyout__body";
    body.textContent = full;
    box.append(body);
    const caret = document.createElement("div");
    caret.className = "pw-error-flyout__caret";
    flyout.append(box, caret);

    const wrap = document.createElement("div");
    wrap.className = "pw-error";
    wrap.style.opacity = "0";
    // Stay invisible for 0.5s, then fade in over 1s.
    wrap.style.transition = "opacity 1s ease 0.5s";

    const face = document.createElement("button");
    face.type = "button";
    face.className = "pw-error__face";
    face.textContent = ":(";
    face.title = summary;
    face.setAttribute("aria-label", "see error");
    face.setAttribute("aria-expanded", "false");
    // Let the browser own the open/close (toggle + light-dismiss on click-out
    // or Esc); we just react to it below.
    face.setAttribute("popovertarget", flyoutId);

    // Place the flyout under the button, centred on it, flipping above when
    // there isn't room below and clamping to the viewport. The caret always
    // points back at the button's centre.
    const GAP = 9;
    const MARGIN = 8;
    const position = () => {
      const r = face.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const fw = flyout.offsetWidth;
      const fh = flyout.offsetHeight;

      const below =
        r.bottom + GAP + fh + MARGIN <= vh || r.top - GAP - fh - MARGIN < 0;
      const top = below ? r.bottom + GAP : r.top - GAP - fh;

      const centerX = r.left + r.width / 2;
      const left = Math.max(
        MARGIN,
        Math.min(centerX - fw / 2, vw - MARGIN - fw)
      );

      flyout.style.top = `${top}px`;
      flyout.style.left = `${left}px`;
      flyout.classList.toggle("is-below", below);
      flyout.classList.toggle("is-above", !below);

      const caretX = Math.max(12, Math.min(centerX - left, fw - 12));
      caret.style.left = `${caretX - 5.5}px`;
    };

    const reposition = () => {
      if (flyout.matches(":popover-open")) position();
    };

    flyout.addEventListener("toggle", (event) => {
      const open = (event as ToggleEvent).newState === "open";
      face.setAttribute("aria-expanded", String(open));
      if (open) {
        console.error(original ?? full);
        position();
        requestAnimationFrame(() => flyout.classList.add("is-shown"));
      } else {
        flyout.classList.remove("is-shown");
      }
    });

    this.#removeErrorListeners();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    this.#errorReposition = reposition;

    const actions = document.createElement("div");
    actions.className = "pw-error__actions";
    actions.append(face, flyout);

    if (action) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pw-error__load";
      button.textContent = `⚡ ${action.label}`;
      button.addEventListener("click", action.run);
      actions.append(button);

      // An unexplained button is worse than no button, so the summary reads out
      // in the open here rather than hiding behind the `:(`.
      const message = document.createElement("p");
      message.className = "pw-error__message";
      message.textContent = summary;
      wrap.classList.add("pw-error--offer");
      wrap.append(message);
    }

    wrap.append(actions);
    this.#content.append(wrap);
    requestAnimationFrame(() => {
      wrap.style.opacity = "1";
    });
  };

  #removeErrorListeners(): void {
    const reposition = this.#errorReposition;
    if (!reposition) return;
    this.#errorReposition = null;
    window.removeEventListener("scroll", reposition, true);
    window.removeEventListener("resize", reposition);
  }

  /**
   * The module the current doc suggests importing (its `suggestedImportUrl`),
   * if there is one we haven't already been refused. `loading` means it's been
   * accepted and the import is in flight, so callers show a spinner instead of
   * offering it again.
   */
  #suggestedImport(): { url: string; loading: boolean } | null {
    if (!this.#docUrl || !this.#handle) return null;
    const url = getSuggestedImportUrl(this.#handle.doc());
    if (!url) return null;
    return { url, loading: this.#requestedToolImports.has(url) };
  }

  /**
   * Say that the doc names a package and offer to run it. We never import on
   * our own: the module is arbitrary JavaScript named by the document, so it
   * takes a click and then a confirm naming the URL before anything is fetched.
   */
  #displaySuggestion(url: string): void {
    this.#displayError(
      `No tool was found for this document, but it suggests a package at ${url}.`,
      undefined,
      undefined,
      {
        label: "Load suggested package",
        run: () => this.#loadSuggestedImport(url),
      }
    );
  }

  /**
   * Confirm, then import. The import runs in this element's own realm rather
   * than being delegated to a single top-level handler, so a `<patchwork-view>`
   * nested in an embedded context (e.g. an iframe an event couldn't bubble out
   * of) still resolves its own tool. Once registered, the tool registry gains a
   * supporting tool and this view's registry listeners re-render.
   */
  #loadSuggestedImport(url: string): void {
    const ok = window.confirm(
      `This will execute JavaScript stored at ${url}.\n\n` +
        `Only do this if you trust the source of this tool.\n\n` +
        `Load it?`
    );
    if (!ok) return;
    this.#requestedToolImports.add(url);
    this.#dismissToast(true);
    this.#showToast("Loading tool", url);
    if (this.#state === State.unable) this.#queueRender();
    void this.#importSuggestedModule(url);
  }

  /**
   * A small o-message-style toast, floated over the view, announcing that we're
   * fetching the doc's suggested import because no built-in editor matched. It's
   * appended to the host element (never `#content`, which a tool's re-render
   * wipes) and retired by `#dismissToast` once a real tool mounts or on
   * teardown; a timer clears it if the import never resolves.
   */
  #showToast(title: string, body: string, action?: () => void): void {
    this.#dismissToast(true);

    // Give the absolutely-positioned toast a containing block without
    // clobbering an inline position the host author may have set.
    if (getComputedStyle(this.#element).position === "static") {
      this.#element.style.position = "relative";
      this.#toastPositioned = true;
    }

    const toast = document.createElement("div");
    toast.setAttribute("role", "status");
    Object.assign(toast.style, {
      position: "absolute",
      top: "16px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "2147483000",
      maxWidth: "min(360px, calc(100% - 32px))",
      boxSizing: "border-box",
      display: "flex",
      gap: "10px",
      padding: "12px 14px",
      borderRadius: "6px",
      background: "#eaf1fb",
      color: "#1a1a1a",
      borderLeft: "4px solid #1e5fbf",
      boxShadow: "0 6px 20px rgba(0, 0, 0, 0.18)",
      font: "13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      opacity: "0",
      transition: "opacity 0.25s ease",
      pointerEvents: action ? "auto" : "none",
    } as Partial<CSSStyleDeclaration>);

    const dot = document.createElement("div");
    Object.assign(dot.style, {
      flex: "0 0 auto",
      width: "8px",
      height: "8px",
      marginTop: "4px",
      borderRadius: "50%",
      background: "#1e5fbf",
    });
    if (!action) {
      dot.animate(
        [
          { opacity: "0.3", transform: "scale(0.6)" },
          { opacity: "1", transform: "scale(1)" },
          { opacity: "0.3", transform: "scale(0.6)" },
        ],
        { duration: 1400, iterations: Infinity, easing: "ease-in-out" }
      );
    }

    const inner = document.createElement("div");
    inner.style.minWidth = "0";

    const titleEl = document.createElement("div");
    titleEl.textContent = title;
    titleEl.style.fontWeight = "600";

    const bodyEl = document.createElement("div");
    bodyEl.textContent = body;
    Object.assign(bodyEl.style, {
      marginTop: "2px",
      opacity: "0.75",
      overflowWrap: "anywhere",
    } as Partial<CSSStyleDeclaration>);

    inner.append(titleEl, bodyEl);

    if (action) {
      ensureErrorStyles();
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pw-error__load";
      button.textContent = "⚡ Load suggested package";
      button.style.marginTop = "8px";
      button.addEventListener("click", action);
      inner.append(button);
    }

    toast.append(dot, inner);

    // Only the offer is dismissable — the progress toast retires itself, and a
    // × on it would suggest it cancels the import, which it doesn't.
    if (action) {
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "×";
      close.setAttribute("aria-label", "dismiss");
      Object.assign(close.style, {
        flex: "0 0 auto",
        marginLeft: "auto",
        alignSelf: "flex-start",
        padding: "0 2px",
        border: "none",
        background: "none",
        color: "inherit",
        opacity: "0.5",
        font: "16px/1 inherit",
        cursor: "pointer",
      } as Partial<CSSStyleDeclaration>);
      close.addEventListener("click", () => this.#dismissToast());
      toast.append(close);

      const escape = (event: KeyboardEvent) => {
        if (event.key === "Escape") this.#dismissToast();
      };
      window.addEventListener("keydown", escape);
      this.#toastEscape = escape;
    }
    this.#element.append(toast);
    this.#toast = toast;

    requestAnimationFrame(() => {
      toast.style.opacity = "1";
    });

    // An offer waits for the user; only the progress toast times itself out.
    if (!action) {
      this.#toastTimer = setTimeout(() => this.#dismissToast(), 8000);
    }
  }

  #dismissToast(immediate = false): void {
    if (this.#toastTimer) {
      clearTimeout(this.#toastTimer);
      this.#toastTimer = null;
    }
    if (this.#toastEscape) {
      window.removeEventListener("keydown", this.#toastEscape);
      this.#toastEscape = null;
    }
    const toast = this.#toast;
    if (!toast) return;
    this.#toast = null;
    if (immediate) {
      toast.remove();
      this.#restoreToastPosition();
      return;
    }
    toast.style.opacity = "0";
    setTimeout(() => {
      toast.remove();
      this.#restoreToastPosition();
    }, 300);
  }

  #restoreToastPosition(): void {
    if (!this.#toastPositioned || this.#toast) return;
    this.#toastPositioned = false;
    this.#element.style.position = "";
  }

  async #importSuggestedModule(url: string): Promise<void> {
    log("importing suggested module", url);
    try {
      // A `suggestedImportUrl` can be an `automerge:` folder doc served through
      // the service worker as well as a plain HTTP(S) module bundle.
      const mod = await importPackage(url);
      if (Array.isArray(mod?.plugins)) {
        registerPlugins(mod.plugins, url);
      } else {
        console.warn(`suggested module ${url} has no plugins array`);
      }
    } catch (error) {
      console.error(`Failed to import suggested module ${url}`, error);
    }
  }

  #resetDisplay = () => {
    this.#removeErrorListeners();
    this.#content.replaceChildren();
  };
}
