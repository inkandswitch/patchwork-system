import {
  parseAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type DocHandleChangePayload,
  type DocumentId,
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
  getSupertypes,
  isKeyhiveDoc,
  isLoadablePlugin,
  registerPlugins,
  type DatatypeDescription,
  type LoadedTool,
  type ToolDescription,
  type ToolElement,
} from "@inkandswitch/patchwork-plugins";
import debug from "debug";
import type { AutomergeRepoKeyhiveBase as AutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";
import { gateOnAccess } from "./keyhive-access.js";
import { MountedEvent, UnmountedEvent } from "./events.js";
import { importSource, presentableImportUrl } from "./import-url.js";
import {
  dispatchFromNearestConnected,
  Serialized,
  Teardowns,
} from "./lifecycle.js";

const log = debug("patchwork:elements:legacy");

/**
 * Whether `tool` supports `type` only through a `*` wildcard rather than by
 * naming the datatype or one of its supertypes. A wildcard-only match means the
 * tool is a generic fallback (e.g. a raw viewer), not a tool built for this
 * datatype.
 */
function isWildcardOnlyMatch(
  tool: LoadedTool,
  type: string | undefined
): boolean {
  const datatypes = tool.supportedDatatypes;
  const list = datatypes === "*" ? ["*"] : datatypes;
  if (!list.includes("*")) return false;
  if (type === undefined) return true;
  return ![type, ...getSupertypes(type)].some((t) => list.includes(t));
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

// How long a failed load waits before trying again, attempt by attempt. A
// grant can land seconds before the doc it grants is fetchable, and the op
// that carried it may be the last one for a while, so a keyhive op alone
// can't be relied on to bring the view back. After ~30s it settles on the
// last delay, and keeps asking for as long as the view is up: a sender's
// device can take minutes to push a doc it just shared.
const LOAD_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];

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
 * `doc-url`/`tool-id`-driven legacy view behavior for `<patchwork-view>`. The
 * tool renders into an inner `.patchwork-view-content` element (the only thing
 * wiped on re-render); the host stays the identity/event node, leaving safe
 * sibling space for augmentations a tool's re-render can't trample.
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
  // `unable` because the doc failed to load; a keyhive op retries the load,
  // and so does a timer, backing off through LOAD_RETRY_DELAYS_MS.
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

  // Tear down and mount again. Every remount goes through `#init`, which a
  // disposed impl refuses, so one disconnected mid-teardown stays down.
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
            if (
              loadedTool.id !== this.#tool?.id ||
              loadedTool.importUrl !== this.#tool?.importUrl
            ) {
              await this.#restart();
            }
          }
        }
      }
    );

    // Registering the doc's datatype, or one of its supertypes, can bring in a
    // `conformsTo` that makes an already-registered tool a closer fit.
    const removeDatatypeListener = getRegistry<DatatypeDescription>(
      "patchwork:datatype"
    ).on("registered", (added) => {
      if (!this.#handle || this.#toolId) return;
      const type = getType(this.#handle.doc());
      if (!type) return;
      if (added.id != type && !getSupertypes(type).includes(added.id)) return;
      const fallback = getFallbackTool(this.#handle.doc());
      if (!fallback) return;
      if (fallback.id == this.#fallbackId && this.#state != State.unable) {
        return;
      }
      this.#fallbackId = fallback.id;
      if (!fallback.module) {
        // The "loaded" listener mounts it once it's in.
        if (isLoadablePlugin(fallback)) toolRegistry.load(fallback.id);
      } else if (this.#state == State.unable) {
        this.#queueRender();
      } else if (this.#state == State.fallback) {
        void this.#restart();
      }
    });

    this.#teardowns.add(() => {
      removeAddedListener();
      removeLoadedListener();
      removeDatatypeListener();
    });

    const repo = this.#repo;
    this.#element.repo = repo;
    this.#content.repo = repo;

    let handle: DocHandle<HasPatchworkMetadata>;
    try {
      handle = await repo.find<HasPatchworkMetadata>(this.#docUrl);
    } catch (err) {
      if (epoch !== this.#initEpoch) return;
      // Every caller voids `#init`'s promise, so rethrowing would only
      // produce an unhandled rejection and wedge `#state` in `initializing`.
      // Show the error and park in `unable`: the usual reason a find fails
      // is that the doc hasn't synced yet, and a keyhive op retries it.
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

  // Load the doc again after a failed find, leaving the error up while it
  // runs: a teardown would blank the view and fade the error back in on every
  // keyhive op, which arrive far faster than the fade. Overlapping retries
  // collapse into the one in flight, with one follow-up for an op received
  // while it runs.
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
      // Still unavailable. The error stays up; the next op, or the timer,
      // tries again.
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

  // Have the repo ask the sync server for the doc again. Once a doc's query
  // has settled on "unavailable", `find` answers from that verdict without
  // asking anyone: the subduction source only re-arms when data is pushed, a
  // connection changes, or a key arrives. So a timed re-find on its own finds
  // nothing new. `resyncSubduction` marks the doc never-synced, and the round
  // it opens starts a macrotask later, so it's asked for when a retry is
  // scheduled: by the time the retry's `find` runs, the query is loading or
  // has a fresh answer. A repo without a subduction source has no
  // `resyncSubduction`, and a doc that isn't attached to it is a no-op.
  //
  // It goes by the url the view was given. Under a remapping provider the doc
  // actually fetched may be another (a draft's clone), which this doesn't
  // reach; that's no worse than before, when no retry re-armed anything.
  #askAgain(url: AutomergeUrl): void {
    const repo = this.#repo as Repo & {
      resyncSubduction?: (documentId: DocumentId) => void;
    };
    if (typeof repo.resyncSubduction !== "function") return;
    try {
      repo.resyncSubduction(parseAutomergeUrl(url).documentId);
    } catch (err) {
      log("resync of %s failed: %o", url, err);
    }
  }

  // Try a failed load again after the next delay in LOAD_RETRY_DELAYS_MS,
  // staying on the last one once they've all been used.
  #scheduleRetry(): void {
    if (this.#disposed || this.#retryTimer) return;
    const delay =
      LOAD_RETRY_DELAYS_MS[
        Math.min(this.#retryAttempt, LOAD_RETRY_DELAYS_MS.length - 1)
      ];
    this.#retryAttempt++;
    if (this.#docUrl) this.#askAgain(this.#docUrl);
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

  // A registration can shift the fallback only when we don't have one yet or
  // the new tool supports the doc's type or a supertype (a closer match sorts
  // ahead, so a supporting tool can displace the current pick).
  #couldChangeFallback(added: ToolDescription): boolean {
    if (!this.#fallbackId) return true;
    const supported = added.supportedDatatypes;
    if (!supported) return false;
    if (supported === "*" || supported.includes("*")) return true;
    const type = this.#handle ? getType(this.#handle.doc()) : undefined;
    if (type == null) return false;
    return [type, ...getSupertypes(type)].some((t) => supported.includes(t));
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

  // A render queued before a teardown began must not land while it runs: the
  // tool's cleanup would join a set the teardown has already drained, and
  // nothing would ever call it. Teardown bumps the epoch first thing, but
  // registry listeners can queue a fresh render (with the new epoch) until
  // their own cleanup runs, hence the in-flight check too.
  #mayRender(epoch: number): boolean {
    return (
      !this.#disposed && epoch === this.#initEpoch && !this.#teardown.pending
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

    // A wildcard fallback tool (`supportedDatatypes: ["*"]`) supports this doc
    // only generically, not because it's built for the doc's datatype — it's a
    // stopgap, so it gives way to anything the doc suggests we load instead.
    const mountingWildcardStopgap =
      fallingBack &&
      !!fallbackTool &&
      isWildcardOnlyMatch(fallbackTool, getType(doc));

    if (fallingBack) {
      console.warn(`falling back to default tool for ${this.#docUrl}`);
      // A wildcard stopgap is a raw viewer, not this datatype's editor. When the
      // doc names a package that would bring the real thing, offer that instead
      // of mounting the stopgap: raw JSON isn't what was asked for, and it would
      // only be swapped out from under the reader once the import lands. Parking
      // in `unable` is what lets the registry listeners re-render then — the
      // loaded tool sorts ahead of the wildcard as the new fallback.
      if (mountingWildcardStopgap) {
        const suggestion = this.#suggestedImport();
        if (suggestion) {
          this.#state = State.unable;
          // While the import is in flight `#loadSuggestedImport`'s progress
          // toast is already up, and `#resetDisplay` leaves it alone.
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
      // Something mounted, so retire any "loading suggested import" toast. A
      // wildcard stopgap only gets this far when the doc suggests nothing, so
      // there's no offer left standing either way.
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
   * The module the current doc suggests importing (its `suggestedImportUrl`,
   * in the form {@link presentableImportUrl} makes safe to show and import),
   * if there is one we haven't already been refused. `loading` means it's been
   * accepted and the import is in flight, so callers show a spinner instead of
   * offering it again.
   */
  #suggestedImport(): { url: string; loading: boolean } | null {
    if (!this.#docUrl || !this.#handle) return null;
    const url = presentableImportUrl(getSuggestedImportUrl(this.#handle.doc()));
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
   * The import registered nothing, so the view it was going to fill has nothing
   * coming: say so, and offer to try again, rather than sit empty once the
   * progress toast times out.
   * Only called where nothing could have been registered, so no render is in
   * flight, and only acts while this view still has nothing mounted.
   */
  #reportImportFailed(epoch: number, url: string, error?: unknown): void {
    // No longer in flight, so the doc's suggestion can be offered again
    // rather than every later render showing a spinner for an import that's
    // over.
    if (epoch !== this.#initEpoch) return;
    this.#requestedToolImports.delete(url);
    if (this.#state !== State.unable) return;
    this.#dismissToast(true);
    // Replace whatever was standing in while the import ran (the loading
    // pulse) rather than stacking the error under it.
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
