import {
  type AutomergeUrl,
  type DocHandle,
  type DocHandleChangePayload,
  type Repo,
} from "@automerge/automerge-repo/slim";
import {
  getSuggestedImportUrl,
  getType,
  importPackage,
  type HasPatchworkMetadata,
} from "@inkandswitch/patchwork-filesystem";
import {
  getFallbackTool,
  getRegistry,
  isKeyhiveDoc,
  isLoadablePlugin,
  registerPlugins,
  type LoadedTool,
  type ToolDescription,
  type ToolElement,
} from "@inkandswitch/patchwork-plugins";
import debug from "debug";
import type { AutomergeRepoKeyhiveBase as AutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";
import { gateOnAccess } from "./keyhive-access.js";
import { MountedEvent, UnmountedEvent } from "./events.js";
import { loadRetryDelay, resyncBeforeRetry } from "./load-retry.js";
import { importSource, presentableImportUrl } from "./import-url.js";
import {
  dispatchFromNearestConnected,
  Serialized,
  Teardowns,
} from "./lifecycle.js";

const log = debug("patchwork:elements:legacy");

/**
 * Whether `tool` takes `type` only through a `*`: a generic fallback like a
 * raw viewer, not a tool built for that datatype.
 */
function isWildcardOnlyMatch(
  tool: LoadedTool,
  type: string | undefined
): boolean {
  const datatypes = tool.supportedDatatypes;
  const list = datatypes === "*" ? ["*"] : datatypes;
  return list.includes("*") && (type === undefined || !list.includes(type));
}

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
   * Finds the primary doc. It's the view's overlay repo, so a remapper (a
   * draft, say) decides which document the tool gets.
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

// One stylesheet for every view's error UI, from the `--studio-*` properties,
// with fallbacks for when nothing is themed.
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
      color: var(--studio-line, #1a1a1a);
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
      color: var(--studio-line, #1a1a1a);
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
 * The `doc-url`/`tool-id` behaviour of `<patchwork-view>`. The tool renders
 * into an inner `.patchwork-view-content`, the only thing a re-render wipes, so
 * the host keeps its identity and events, with room beside the content for
 * things a re-render mustn't trample.
 */
export class LegacyImpl {
  #element: HostElement;
  #content: HostElement;
  #repo: Repo;
  #hive: AutomergeRepoKeyhive | undefined;
  // Set on disconnect. The host makes a fresh impl for each connection, so a
  // disposed impl never mounts again, whatever async work is still in flight.
  #disposed = false;
  #docUrl: AutomergeUrl | null = null;
  #toolId: string | null = null;
  #handle: DocHandle<HasPatchworkMetadata> | null = null;
  #tool: LoadedTool | null = null;
  #state: State = State.none;
  #requestedToolImports = new Set<string>();
  #initEpoch = 0;
  #capturedParent: Element | null = null;
  #fallbackId: string | undefined;
  #teardowns = new Teardowns();
  #teardown = new Serialized(() => this.#runTeardown());
  // `unable` because the identity has no access yet; a grant mounts the view.
  #unableNoAccess = false;
  // `unable` because the doc failed to load; a keyhive op or the timer retries.
  #loadFailed = false;
  #retryingLoad = false;
  #pendingRetryEpoch: number | null = null;
  #retryAttempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #toast: HTMLElement | null = null;
  #toastTimer: ReturnType<typeof setTimeout> | null = null;
  #toastPositioned = false;
  #toastEscape: ((event: KeyboardEvent) => void) | null = null;
  #errorReposition: (() => void) | null = null;

  constructor(element: HTMLElement, params: LegacyImplParams) {
    this.#element = element as HostElement;
    this.#repo = params.repo;
    this.#hive = params.hive;
    this.#element.hive = params.hive;

  // Fills the host, so tools that measure their root element see the host's
  // box.
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
    this.#disposed = true;
    await this.#teardown.run();
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
      void this.#restart();
    }
    if (name === ATTRS.docUrl) {
      this.#docUrl = val as AutomergeUrl;
      void this.#restart();
    }
  }

  #onDocChange = (payload: DocHandleChangePayload<HasPatchworkMetadata>) => {
    const { before, after } = payload.patchInfo;
    if (getType(before) != getType(after)) void this.#restart();
  };

  // Every remount goes through `#init`, which a disposed impl refuses, so one
  // disconnected mid-teardown stays down.
  async #restart(): Promise<void> {
    await this.#teardown.run();
    await this.#init();
  }

  #init = async () => {
    const toolRegistry = getRegistry<ToolDescription>("patchwork:tool");
    if (this.#disposed) return;
    if (this.#state != State.none) return;
    if (!this.#docUrl) return;

    const epoch = ++this.#initEpoch;
    this.#state = State.initializing;

    const hasAccess = await gateOnAccess(
      this.#hive,
      this.#docUrl,
      this.#teardowns,
      (granted) => this.#onAccessChange(granted)
    );
    if (epoch !== this.#initEpoch) return;
    if (!hasAccess) {
      this.#state = State.unable;
      this.#unableNoAccess = true;
      return;
    }

    const removeAddedListener = toolRegistry.on(
      "registered",
      async (addedTool) => {
        const toolId = addedTool.id;
        const isChosenTool = toolId == this.#toolId;
        // getFallbackTool scans the whole registry: calling it on every
        // registration is O(N²) across a load burst.
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
              await this.#restart();
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
      handle = await repo.find<HasPatchworkMetadata>(this.#docUrl);
    } catch (err) {
      if (epoch !== this.#initEpoch) return;
      // Callers void `#init`'s promise, so a rethrow would only wedge `#state`
      // in `initializing`. Usually the doc just hasn't synced yet, and a
      // keyhive op or the timer retries.
      console.error(`failed to load ${this.#docUrl}`, err);
      this.#state = State.unable;
      this.#loadFailed = true;
      const e = err as Error;
      this.#displayError(e?.message ?? String(err), e?.stack, err);
      this.#scheduleRetry();
      return;
    }

    if (epoch !== this.#initEpoch) return;
    this.#mountHandle(handle);
  };

  #mountHandle(handle: DocHandle<HasPatchworkMetadata>): void {
    this.#handle = handle;
    handle.on("change", this.#onDocChange);
    this.#teardowns.add(() => handle.off("change", this.#onDocChange));
    this.#queueRender();
  }

  // Leaves the error up while it runs: a teardown would blank the view and fade
  // the error back in on every keyhive op, and they come far faster than the
  // fade. Retries asked for during one collapse into a single follow-up.
  async #retryLoad(): Promise<void> {
    if (!this.#docUrl) return;
    if (this.#retryingLoad) {
      this.#pendingRetryEpoch = this.#initEpoch;
      return;
    }
    this.#cancelRetry();
    this.#retryingLoad = true;
    const epoch = this.#initEpoch;
    try {
      const handle = await this.#repo.find<HasPatchworkMetadata>(this.#docUrl);
      if (epoch !== this.#initEpoch || !this.#loadFailed) return;
      this.#loadFailed = false;
      this.#retryAttempt = 0;
      this.#mountHandle(handle);
    } catch (err) {
      log("retry of %s failed: %o", this.#docUrl, err);
      if (epoch === this.#initEpoch && this.#loadFailed) this.#scheduleRetry();
    } finally {
      this.#retryingLoad = false;
      const pendingRetryEpoch = this.#pendingRetryEpoch;
      this.#pendingRetryEpoch = null;
      if (
        pendingRetryEpoch === this.#initEpoch &&
        !this.#disposed &&
        this.#loadFailed
      ) {
        void this.#retryLoad();
      }
    }
  }

  #scheduleRetry(): void {
    if (this.#disposed || this.#retryTimer) return;
    const delay = loadRetryDelay(this.#retryAttempt);
    this.#retryAttempt++;
    if (this.#docUrl) {
      resyncBeforeRetry(this.#repo, this.#docUrl, (err) =>
        log("resync of %s failed: %o", this.#docUrl, err)
      );
    }
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      void this.#retryLoad();
    }, delay);
  }

  #cancelRetry(): void {
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  // Access to the doc changed. A grant mounts a view that had none, a
  // revocation unmounts a mounted one, and either retries a failed load
  // (access is checked on every keyhive op, the same ops that sync the doc).
  #onAccessChange(hasAccess: boolean): void {
    if (this.#loadFailed) {
      if (!hasAccess) {
        void this.#restart();
        return;
      }
      // a fresh op starts the back-off again
      this.#retryAttempt = 0;
      void this.#retryLoad();
      return;
    }
    const granted =
      hasAccess && this.#state === State.unable && this.#unableNoAccess;
    const revoked =
      !hasAccess &&
      (this.#state === State.rendered || this.#state === State.fallback);
    if (granted || revoked) void this.#restart();
  }

  // Only when there's no fallback yet, or the new tool supports the doc's type
  // (a specific match sorts ahead of a wildcard).
  #couldChangeFallback(added: ToolDescription): boolean {
    if (!this.#fallbackId) return true;
    const supported = added.supportedDatatypes;
    if (!supported) return false;
    if (supported === "*" || supported.includes("*")) return true;
    const type = this.#handle ? getType(this.#handle.doc()) : undefined;
    return type != null && supported.includes(type);
  }

  async #runTeardown(): Promise<void> {
    if (this.#state == State.none) return;

    // Read before clearing, so the unmount names the same {url, toolId} the
    // mount did; `#render` sends a MountedEvent only in these two states.
    const wasMounted =
      this.#state == State.rendered || this.#state == State.fallback;
    const mountedUrl = this.#handle?.url;
    const mountedToolId = this.#tool?.id;

    this.#initEpoch++;
    this.#pendingRetryEpoch = null;
    await this.#teardowns.run();

    this.#dismissToast(true);
    this.#removeErrorListeners();
    this.#unableNoAccess = false;
    this.#loadFailed = false;
    this.#cancelRetry();
    this.#retryAttempt = 0;
    this.#handle = null;
    this.#tool = null;
    this.#requestedToolImports.clear();
    this.#content.textContent = "";
    this.#state = State.none;

    if (wasMounted && mountedUrl && mountedToolId) {
      dispatchFromNearestConnected(
        this.#element,
        this.#capturedParent,
        new UnmountedEvent({ url: mountedUrl, toolId: mountedToolId })
      );
    }
  }

  #queueRender(): void {
    if (this.#state == "none") return;
    if (this.#state == "rendering") return;
    this.#state = "rendering";
    const epoch = this.#initEpoch;
    queueMicrotask(() => {
      if (this.#mayRender(epoch)) this.#render();
    });
  }

  // A render mustn't land during a teardown: the tool's cleanup would join a
  // set the teardown already drained, and never run. The epoch bumps first
  // thing, but registry listeners can queue a render (with the new epoch)
  // until their own cleanup runs, hence the in-flight check.
  #mayRender(epoch: number): boolean {
    return (
      !this.#disposed &&
      epoch === this.#initEpoch &&
      !this.#teardown.pending
    );
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

    const mountingWildcardStopgap =
      fallingBack &&
      !!fallbackTool &&
      isWildcardOnlyMatch(fallbackTool, getType(doc));

    if (fallingBack) {
      console.warn(`falling back to default tool for ${this.#docUrl}`);
      // A wildcard stopgap is a raw viewer, not this datatype's editor. If the
      // doc names a package that brings the real one, offer it rather than show
      // raw JSON that'd be swapped out once the import lands. Parking in
      // `unable` lets the registry listeners re-render then.
      if (mountingWildcardStopgap) {
        const suggestion = this.#suggestedImport();
        if (suggestion) {
          this.#state = State.unable;
          // In flight: the progress toast is already up.
          if (!suggestion.loading) {
            this.#showToast(
              "This document suggests a package",
              suggestion.url,
              () => this.#loadSuggestedImport(suggestion.url)
            );
          }
          return;
        }
      }
    }

    if (!toolId) {
      this.#state = "unable";
      // Nothing is registered for this datatype. Offer the doc's suggested
      // import, if any; the registry listeners re-render once it registers.
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
      // `#init` set the content's `repo` before `#queueRender`, so it is a
      // `ToolElement`.
      const cleanup = this.#tool.module(
        this.#handle,
        this.#content as ToolElement
      );
      if (typeof cleanup === "function") {
        this.#teardowns.add(cleanup);
      } else {
        console.warn(`return a cleanup function from ${toolId}`);
      }
      // A stopgap only gets this far when the doc suggests nothing, so no
      // offer goes with the toast.
      this.#dismissToast();
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
    div.className = "pw-loading";
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

  // A lone `:(` that fades in; clicking it pops the full error under it.
  // `original` is logged again on open, so it's easy to grab from the console.
  #displayError = (
    summary: string,
    detail?: string,
    original?: unknown,
    action?: { label: string; run: () => void }
  ) => {
    ensureErrorStyles();

    // Stacks usually start with the message already.
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
    wrap.style.transition = "opacity 1s ease 0.5s";

    const face = document.createElement("button");
    face.type = "button";
    face.className = "pw-error__face";
    face.textContent = ":(";
    face.title = summary;
    face.setAttribute("aria-label", "see error");
    face.setAttribute("aria-expanded", "false");
    // The browser opens, closes and light-dismisses it.
    face.setAttribute("popovertarget", flyoutId);

    // Under the button and centred on it, flipped above when there's no room
    // below, kept in the viewport; the caret points at the button's centre.
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
   * The module the doc suggests importing (as {@link presentableImportUrl}
   * makes it), unless it's been refused. `loading` means it was accepted and
   * is in flight: show a spinner, not the offer.
   */
  #suggestedImport(): { url: string; loading: boolean } | null {
    if (!this.#docUrl || !this.#handle) return null;
    const url = presentableImportUrl(
      getSuggestedImportUrl(this.#handle.doc())
    );
    if (!url) return null;
    return { url, loading: this.#requestedToolImports.has(url) };
  }

  /**
   * Offer to run the package the doc names. Never on our own: it's arbitrary
   * JavaScript named by the document, so it takes a click, then a confirm
   * naming the URL.
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
   * Confirm, then import, in this element's own realm, so a view inside an
   * iframe (which an event couldn't bubble out of) still gets its tool.
   */
  #loadSuggestedImport(url: string): void {
    const ok = window.confirm(
      `This will run JavaScript from ${importSource(url)}:\n\n` +
        `${url}\n\n` +
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
   * A small o-message-style toast over the view. It goes on the host, never
   * `#content`, which a tool's re-render wipes.
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
      borderRadius: "var(--studio-radius, 6px)",
      // Themed surface, faintly tinted by the accent: a hardcoded light card
      // would hold a dark-themed button (they share `--studio-*`) and read as
      // black-on-black in a dark theme.
      background:
        "color-mix(in oklch, var(--studio-fill, #eaf1fb), var(--studio-primary, #1e5fbf) 8%)",
      color: "var(--studio-line, #1a1a1a)",
      borderLeft: "4px solid var(--studio-primary, #1e5fbf)",
      boxShadow: "var(--studio-shadow-lg, 0 6px 20px rgba(0, 0, 0, 0.18))",
      font: "13px/1.4 var(--studio-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif)",
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
      background: "var(--studio-primary, #1e5fbf)",
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
    const epoch = this.#initEpoch;
    try {
      // A `suggestedImportUrl` can be an `automerge:` folder doc served through
      // the service worker as well as a plain HTTP(S) module bundle.
      const mod = await importPackage(url);
      if (Array.isArray(mod?.plugins)) {
        registerPlugins(mod.plugins, url);
      } else {
        console.warn(`suggested module ${url} has no plugins array`);
        this.#reportImportFailed(epoch, url);
      }
    } catch (error) {
      console.error(`Failed to import suggested module ${url}`, error);
      this.#reportImportFailed(epoch, url, error);
    }
  }

  /**
   * The import registered nothing: say so and offer to try again, rather than
   * sit empty once the progress toast times out. Only called where nothing
   * could have registered, so no render is in flight.
   */
  #reportImportFailed(epoch: number, url: string, error?: unknown): void {
    // It's over, so the suggestion can be offered again instead of a spinner.
    if (epoch !== this.#initEpoch) return;
    this.#requestedToolImports.delete(url);
    if (this.#state !== State.unable) return;
    this.#dismissToast(true);
    // In place of the loading pulse, not under it.
    this.#resetDisplay();
    const err = error as Error | undefined;
    this.#displayError(
      `I couldn't load the package at ${url}.`,
      err?.stack ?? err?.message,
      error,
      { label: "Try again", run: () => this.#loadSuggestedImport(url) }
    );
  }

  #resetDisplay = () => {
    this.#removeErrorListeners();
    this.#content.replaceChildren();
  };
}
