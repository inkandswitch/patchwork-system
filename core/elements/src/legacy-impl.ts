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
  isLoadablePlugin,
  registerPlugins,
  type DatatypeDescription,
  type LoadedTool,
  type ToolDescription,
  type ToolElement,
} from "@inkandswitch/patchwork-plugins";
import debug from "debug";
import type { AutomergeRepoKeyhiveBase as AutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";
import {
  findingCard,
  invalidUrlCard,
  missingTypeCard,
  noToolCard,
  notSharedCard,
  toolFailedCard,
  unavailableCard,
  type Anything,
  type Card,
} from "./cards.js";
import { contactCardText, gateOnAccess } from "./keyhive-access.js";
import { MountedEvent, NoToolEvent, UnmountedEvent } from "./events.js";
import { loadRetryDelay, resyncBeforeRetry } from "./load-retry.js";
import { importSource, presentableImportUrl } from "./import-url.js";
import { readClaims } from "./package-info.js";
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
  tool: ToolDescription,
  type: string | undefined
): boolean {
  const datatypes = tool.supportedDatatypes;
  const list = datatypes === "*" ? ["*"] : (datatypes ?? []);
  return list.includes("*") && (type === undefined || !list.includes(type));
}

/**
 * A tool that opens anything, to offer for a look at a doc's insides: `raw`
 * when there is one, else the first listed `*` tool.
 */
function anythingTool(): Anything | undefined {
  const wildcards = getRegistry<ToolDescription>("patchwork:tool").filter(
    (tool) => !tool.unlisted && isWildcardOnlyMatch(tool, undefined)
  );
  const tool = wildcards.find((t) => t.id === "raw") ?? wildcards[0];
  return tool && { id: tool.id, name: tool.name };
}

/** The types something here opens, to suggest when giving a doc a type. */
function knownTypes(): { id: string; name?: string }[] {
  const names = new Map<string, string | undefined>();
  for (const tool of getRegistry<ToolDescription>("patchwork:tool").all()) {
    const supported = tool.supportedDatatypes;
    if (!supported || supported === "*") continue;
    for (const type of supported) if (type !== "*") names.set(type, undefined);
  }
  for (const datatype of getRegistry<DatatypeDescription>(
    "patchwork:datatype"
  ).all()) {
    if (datatype.unlisted) continue;
    names.set(datatype.id, datatype.name);
  }
  return [...names]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// The repo says so when it can't parse a url: "Invalid AutomergeUrl: …" from
// interpretAsDocumentId, "Invalid document URL: …" from parseAutomergeUrl.
// We go by what the repo says rather than checking the url ourselves, so a
// form the host's repo accepts is never turned away here.
function isInvalidUrlError(error: unknown): boolean {
  const message = (error as Error)?.message ?? String(error);
  return /invalid (automergeurl|document url|documentid|document id)/i.test(
    message
  );
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
  /**
   * The realm's repo, for reading a suggested package's folder doc, which no
   * remapper should have a say in. Defaults to `repo`.
   */
  baseRepo?: Repo;
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
 *
 * When it can't show the doc, it says why in a card (see `cards.ts`) in place
 * of the tool: still finding it, couldn't get it, not shared, a broken link,
 * no type, no tool for the type, or a tool that didn't load. Only a tool that
 * throws while rendering gets the bare `:(`, with its error under it.
 */
export class LegacyImpl {
  #element: HostElement;
  #content: HostElement;
  #repo: Repo;
  #baseRepo: Repo;
  #hive: AutomergeRepoKeyhive | undefined;
  // Set on disconnect. The host makes a fresh impl for each connection, so a
  // disposed impl never mounts again, whatever async work is still in flight.
  #disposed = false;
  #docUrl: AutomergeUrl | null = null;
  #toolId: string | null = null;
  // A tool that opens anything, which the reader picked from a card to look
  // at the doc with. Kept across restarts, dropped when the doc's type, the
  // doc, or the asked-for tool changes.
  #peekToolId: string | null = null;
  #handle: DocHandle<HasPatchworkMetadata> | null = null;
  #tool: LoadedTool | null = null;
  #state: State = State.none;
  #requestedToolImports = new Set<string>();
  // Why the last import of a suggested package didn't bring a tool, by url.
  #importFailures = new Map<string, string>();
  // A tool whose code failed to load, and why; its card offers to try again.
  #toolLoadError: { id: string; message: string } | null = null;
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
  #errorReposition: (() => void) | null = null;
  // The card on screen, and what it was drawn from, so a render that would
  // draw the same one leaves it be (and its fade-in doesn't replay).
  #card: Card | null = null;
  #cardKey: string | null = null;

  constructor(element: HTMLElement, params: LegacyImplParams) {
    this.#element = element as HostElement;
    this.#repo = params.repo;
    this.#baseRepo = params.baseRepo ?? params.repo;
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
      this.#peekToolId = null;
      void this.#restart();
    }
    if (name === ATTRS.docUrl) {
      this.#docUrl = val as AutomergeUrl;
      this.#peekToolId = null;
      this.#importFailures.clear();
      void this.#restart();
    }
  }

  // A new type means a new tool, if there's one for it: a doc given a type
  // (from its card, or in the raw view) opens with that type's tool.
  #onDocChange = (payload: DocHandleChangePayload<HasPatchworkMetadata>) => {
    const { before, after } = payload.patchInfo;
    if (getType(before) != getType(after)) {
      this.#peekToolId = null;
      void this.#restart();
    }
  };

  /** The tool asked for: by `tool-id`, or picked from a card. */
  #chosenToolId(): string | null {
    return this.#toolId || this.#peekToolId;
  }

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
      this.#showCard("not-shared", () =>
        notSharedCard({ contactCard: contactCardText(this.#hive) })
      );
      return;
    }

    const removeAddedListener = toolRegistry.on(
      "registered",
      async (addedTool) => {
        const toolId = addedTool.id;
        const isChosenTool = toolId == this.#chosenToolId();
        // getFallbackTool scans the whole registry: calling it on every
        // registration is O(N²) across a load burst.
        if (this.#handle && this.#couldChangeFallback(addedTool)) {
          this.#fallbackId = getFallbackTool(this.#handle.doc())?.id;
        }
        const isFallbackTool = toolId == this.#fallbackId;
        if (isChosenTool || isFallbackTool) {
          if (isLoadablePlugin(addedTool)) {
            this.#watchLoad(toolId, toolRegistry.load(addedTool.id));
          }
        } else if (
          this.#state === State.unable &&
          this.#handle &&
          isWildcardOnlyMatch(addedTool, undefined)
        ) {
          // a card that could offer a look with it now
          this.#queueRender();
        }
      }
    );

    const removeLoadedListener = toolRegistry.on(
      "loaded",
      async (loadedTool) => {
        const toolId = loadedTool.id;
        const isChosenTool = toolId == this.#chosenToolId();
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

    this.#showCard("finding", () => findingCard("finding this doc…"), false);

    let handle: DocHandle<HasPatchworkMetadata>;
    try {
      handle = await repo.find<HasPatchworkMetadata>(this.#docUrl);
    } catch (err) {
      if (epoch !== this.#initEpoch) return;
      // Callers void `#init`'s promise, so a rethrow would only wedge `#state`
      // in `initializing`.
      console.error(`failed to load ${this.#docUrl}`, err);
      this.#state = State.unable;
      // A url the repo can't even parse won't turn up however long we wait.
      if (isInvalidUrlError(err)) {
        const url = this.#docUrl;
        this.#showCard("invalid-url", () => invalidUrlCard({ url }));
        return;
      }
      // Usually the doc just hasn't synced yet, and a keyhive op, the timer
      // or the sync server coming back retries.
      this.#loadFailed = true;
      this.#showCard("unavailable", () =>
        unavailableCard({
          repo: this.#repo,
          onReconnect: () => {
            if (!this.#loadFailed) return;
            this.#retryAttempt = 0;
            void this.#retryLoad();
          },
        })
      );
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

  // Leaves the card up while it runs: a teardown would blank the view and fade
  // the card back in on every keyhive op, and they come far faster than the
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

    this.#unableNoAccess = false;
    this.#loadFailed = false;
    this.#cancelRetry();
    this.#retryAttempt = 0;
    this.#handle = null;
    this.#tool = null;
    this.#toolLoadError = null;
    this.#requestedToolImports.clear();
    this.#resetDisplay();
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

    const doc = this.#handle.doc();
    const type = getType(doc);
    const fallbackTool = getFallbackTool(doc);
    this.#fallbackId = fallbackTool?.id;
    const chosen = this.#chosenToolId();
    const fallingBack = !chosen;
    let toolId = chosen;

    if (!toolId) {
      // Nothing says what this doc is, so nothing can say how to open it.
      if (!type) {
        console.warn(`${this.#docUrl} has no @patchwork type`);
        this.#state = State.unable;
        this.#showMissingType(doc);
        return;
      }
      // A tool that opens anything (raw, an inspector) isn't this datatype's
      // tool: offer it rather than open the doc's insides unasked.
      if (!fallbackTool || isWildcardOnlyMatch(fallbackTool, type)) {
        console.warn(`no tool for ${this.#docUrl}`);
        this.#state = State.unable;
        this.#showNoTool(type, fallbackTool);
        return;
      }
      console.warn(`falling back to default tool for ${this.#docUrl}`);
      toolId = fallbackTool.id;
    }

    this.#tool = getRegistry<LoadedTool>("patchwork:tool").get(toolId) ?? null;

    if (!this.#tool) {
      this.#state = State.unable;
      this.#showNoTool(type ?? "doc with no type", undefined, toolId);
      return;
    }

    if (!this.#tool.module) {
      this.#state = State.unable;
      this.#loadTool(this.#tool);
      return;
    }

    this.#resetDisplay();
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

  // Loads a registered tool's code, behind a loading dot; when it fails, a
  // card says so, where the view would otherwise sit on the dot for good.
  #loadTool(tool: LoadedTool): void {
    const failed = this.#toolLoadError;
    if (failed?.id === tool.id) {
      this.#showCard(`tool-failed:${tool.id}:${failed.message}`, () =>
        toolFailedCard({
          name: tool.name ?? tool.id,
          error: failed.message,
          onRetry: () => {
            // the registry forgets a failed load, so this asks again
            this.#toolLoadError = null;
            if (this.#state === State.unable) this.#queueRender();
          },
        })
      );
      return;
    }
    log(`loading ${tool.id}`);
    this.#showCard(`loading:${tool.id}`, () => findingCard(), false);
    this.#watchLoad(tool.id, getRegistry("patchwork:tool").load(tool.id));
  }

  // A load of the chosen or fallback tool that fails puts its card up; one
  // that works is the registry's "loaded" listener's to mount.
  #watchLoad(id: string, load: Promise<unknown>): void {
    const epoch = this.#initEpoch;
    load.catch((error) => {
      if (this.#disposed || epoch !== this.#initEpoch) return;
      const message = error instanceof Error ? error.message : String(error);
      this.#toolLoadError = { id, message };
      if (this.#state === State.unable) this.#queueRender();
    });
  }

  #showMissingType(doc: HasPatchworkMetadata): void {
    const handle = this.#handle!;
    const hasMetadata = !!doc && "@patchwork" in doc;
    const anything = anythingTool();
    this.#showCard(
      `missing-type:${hasMetadata}:${anything?.id ?? ""}`,
      () =>
        missingTypeCard({
          hasMetadata,
          anything,
          onPeek: (id) => this.#peek(id),
          knownTypes: knownTypes(),
          // the change listener sees the new type and opens it with its tool
          onSetType: (type) =>
            handle.change((d) => {
              const meta = (d as Partial<HasPatchworkMetadata>)["@patchwork"];
              if (meta && typeof meta === "object") meta.type = type;
              else d["@patchwork"] = { type };
            }),
        })
    );
  }

  #showNoTool(
    type: string,
    fallbackTool: LoadedTool | undefined,
    missingToolId?: string
  ): void {
    const suggestion = this.#suggestedImport();
    const anything =
      !missingToolId && fallbackTool && isWildcardOnlyMatch(fallbackTool, type)
        ? { id: fallbackTool.id, name: fallbackTool.name }
        : undefined;
    this.#showCard(
      JSON.stringify(["no-tool", type, missingToolId, suggestion, anything]),
      () =>
        noToolCard({
          type,
          missingToolId,
          suggestion,
          anything,
          onLoad: (url) => this.#loadSuggestedImport(url),
          onPeek: (id) => this.#peek(id),
          repo: this.#baseRepo,
          readClaims,
        })
    );
  }

  // Opens the doc with a tool the reader picked from a card.
  #peek(toolId: string): void {
    this.#peekToolId = toolId;
    if (this.#state === State.unable) this.#queueRender();
  }

  /**
   * Puts a card up in place of the tool, unless the same one is up already.
   * `settled` says the view has given up on mounting a tool for now, which it
   * tells whoever's waiting with a `patchwork:no-tool`; a loading dot hasn't.
   */
  #showCard(key: string, build: () => Card, settled = true): void {
    if (this.#cardKey === key && this.#card?.element.isConnected) return;
    this.#resetDisplay();
    const card = build();
    this.#card = card;
    this.#cardKey = key;
    this.#content.append(card.element);
    if (settled && this.#docUrl) {
      this.#element.dispatchEvent(new NoToolEvent({ url: this.#docUrl }));
    }
  }

  // A lone `:(` that fades in; clicking it pops the full error under it.
  // `original` is logged again on open, so it's easy to grab from the console.
  #displayError = (summary: string, detail?: string, original?: unknown) => {
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

    wrap.append(face, flyout);
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
   * The package the doc suggests (as {@link presentableImportUrl} makes its
   * url), with how loading it stands: `loading` means it was accepted and is
   * in flight, `failed` why the last try didn't bring a tool.
   */
  #suggestedImport():
    | { url: string; loading: boolean; failed?: string }
    | undefined {
    if (!this.#docUrl || !this.#handle) return undefined;
    const url = presentableImportUrl(
      getSuggestedImportUrl(this.#handle.doc())
    );
    if (!url) return undefined;
    return {
      url,
      loading: this.#requestedToolImports.has(url),
      failed: this.#importFailures.get(url),
    };
  }

  /**
   * Confirm, then import, in this element's own realm, so a view inside an
   * iframe (which an event couldn't bubble out of) still gets its tool. Never
   * on our own: it's arbitrary JavaScript named by the document, so it takes
   * a click, then a confirm naming the URL.
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
    this.#importFailures.delete(url);
    // the card again, with its button saying it's on its way
    if (this.#state === State.unable) this.#queueRender();
    void this.#importSuggestedModule(url);
  }

  async #importSuggestedModule(url: string): Promise<void> {
    log("importing suggested module", url);
    const epoch = this.#initEpoch;
    try {
      // A `suggestedImportUrl` can be an `automerge:` folder doc served through
      // the service worker as well as a plain HTTP(S) module bundle.
      const mod = await importPackage(url);
      if (!Array.isArray(mod?.plugins)) {
        console.warn(`suggested module ${url} has no plugins array`);
        this.#reportImportFailed(epoch, url, "it doesn't export any plugins");
        return;
      }
      registerPlugins(mod.plugins, url);
      // Once its tool registers, the registry listeners swap the card for it.
      // A package that brings none would leave the card saying "loading…".
      if (!this.#bringsTool(mod.plugins)) {
        this.#reportImportFailed(epoch, url, this.#noToolReason());
      }
    } catch (error) {
      console.error(`Failed to import suggested module ${url}`, error);
      const message = (error as Error)?.message ?? String(error);
      this.#reportImportFailed(epoch, url, message);
    }
  }

  // Whether `plugins` has a tool this view would open the doc with.
  #bringsTool(plugins: unknown[]): boolean {
    const chosen = this.#chosenToolId();
    const type = this.#handle ? getType(this.#handle.doc()) : undefined;
    return plugins.some((plugin) => {
      const p = plugin as Partial<ToolDescription> | null;
      if (p?.type !== "patchwork:tool") return false;
      if (chosen) return p.id === chosen;
      const supported = p.supportedDatatypes;
      return (
        !!type && !!supported && supported !== "*" && supported.includes(type)
      );
    });
  }

  #noToolReason(): string {
    const chosen = this.#chosenToolId();
    if (chosen) return `it doesn't have the ${chosen} tool`;
    const type = this.#handle ? getType(this.#handle.doc()) : undefined;
    return `it doesn't have a tool for ${type ?? "this"}`;
  }

  /**
   * The import didn't bring a tool: say why on the card, and offer to try
   * again, rather than leave it saying "loading…".
   */
  #reportImportFailed(epoch: number, url: string, why: string): void {
    if (epoch !== this.#initEpoch) return;
    this.#requestedToolImports.delete(url);
    this.#importFailures.set(url, why);
    if (this.#state === State.unable) this.#queueRender();
  }

  #resetDisplay = () => {
    this.#removeErrorListeners();
    this.#card?.dispose();
    this.#card = null;
    this.#cardKey = null;
    this.#content.replaceChildren();
  };
}
