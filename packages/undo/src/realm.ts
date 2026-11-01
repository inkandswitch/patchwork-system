import {
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo/slim";
import { connect, type Connection } from "@inkandswitch/patchwork-providers";

import {
  UndoHistory,
  type AppliedEvent,
  type PressOptions,
  type UndoControls,
  type UndoHistoryOptions,
  type UndoState,
} from "./history.js";
import { rootOf, type HandleIndex } from "./handles.js";
import { UNDO_MARKER } from "./marker.js";
import {
  UNDO_SOURCE,
  type SourceCommand,
  type SourceSelector,
  type SourceState,
} from "./protocol.js";

export type UndoOptions = UndoHistoryOptions & {
  /**
   * Where to find the root handle when `handle` is a sub-handle. Defaults to
   * the realm's `window.repo`.
   */
  repo?: HandleIndex;
};

/**
 * A tool's access to the shared history of a document. Every tool in the
 * realm that edits the document shares the history; `dispose()` releases
 * this tool's part in it.
 */
export interface Undo extends UndoControls {
  /** The history currently behind this binding (it changes on a draft swap). */
  readonly history: UndoHistory;
}

type Shared = { history: UndoHistory; refs: number };

/**
 * Realm-wide state. Kept on the global object under a registered symbol so
 * that tools bundling their own copy of this library still share one
 * history per document and one key binding per realm.
 */
type RealmState = {
  histories: Map<DocHandle<unknown>, Shared>;
  elements: Map<Element, Binding[]>;
  lastUsed: Binding | undefined;
  windows: WeakSet<object>;
};

const REALM = Symbol.for("@inkandswitch/patchwork-undo/realm");

function realm(): RealmState {
  const global = globalThis as { [REALM]?: RealmState };
  return (global[REALM] ??= {
    histories: new Map(),
    elements: new Map(),
    lastUsed: undefined,
    windows: new WeakSet(),
  });
}

/**
 * Undo and redo for `handle`'s document, shared by every tool in the realm
 * that edits it, and bound to the page-wide keys (Cmd/Ctrl+Z,
 * Cmd/Ctrl+Shift+Z, and Ctrl+Y outside macOS) while the event's target is inside `element`, or
 * while `element` is the one the user used last.
 *
 * The history is keyed by the backing document: an `OverlayHandle` (a draft)
 * and its base are different histories, and when the overlay's backing is
 * swapped, the binding moves to the new backing's history and resets it.
 *
 * Works without a Patchwork host (plain automerge-repo apps); inside one,
 * the binding also announces itself to the `patchwork:undo` provider, so
 * host UI (an Edit menu, a toolbar button) can reach the history.
 */
export function undoFor<T>(
  element: HTMLElement | null,
  handle: DocHandle<T>,
  options: UndoOptions = {}
): Undo {
  return new Binding(element, handle as DocHandle<unknown>, options);
}

/** Tracks the realm's `keydown`, `beforeinput`, `pointerdown` and `focusin`. */
function install(win: Window & typeof globalThis) {
  const state = realm();
  if (state.windows.has(win)) return;
  state.windows.add(win);
  const mac = isMac(win);

  win.addEventListener(
    "keydown",
    (event) => {
      if (event.defaultPrevented) return;
      const action = keyAction(event, mac);
      if (!action) return;
      const binding = target(event);
      if (!binding) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (action === "undo") binding.undo();
      else binding.redo();
    },
    { capture: true }
  );

  // The browser's Edit menu and context menu undo arrive as `beforeinput`
  // in editable content (CodeMirror reacts to them too).
  win.addEventListener(
    "beforeinput",
    (event) => {
      const type = event.inputType;
      if (type !== "historyUndo" && type !== "historyRedo") return;
      const binding = target(event);
      if (!binding) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (type === "historyUndo") binding.undo();
      else binding.redo();
    },
    { capture: true }
  );

  // Canvases and 3D views often take no focus, so the document the user
  // used last is the fallback. Using anything else (a tool that keeps its
  // own history, the host's chrome) ends that, so its keys stay its own.
  const used = (event: Event) => {
    const binding = innermost(event);
    state.lastUsed = binding;
    binding?.markActive();
  };
  win.addEventListener("pointerdown", used, { capture: true });
  win.addEventListener("focusin", used, { capture: true });
}

function isMac(win: { navigator: Navigator }) {
  return /Mac|iPhone|iPad|iPod/.test(win.navigator.platform);
}

function keyAction(
  event: KeyboardEvent,
  mac: boolean
): "undo" | "redo" | undefined {
  if (event.altKey || !(mac ? event.metaKey : event.ctrlKey)) return undefined;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (!mac && key === "y" && !event.shiftKey) return "redo";
  return undefined;
}

/**
 * Whether the realm's key binding takes `event` (an undo or redo key press,
 * or the browser's history input, over a registered element). Editors whose
 * own key handlers run before the realm's use it to leave such presses to
 * the realm instead of undoing twice.
 */
export function takenByRealm(event: Event | undefined): boolean {
  if (!event) return false;
  if (event.type === "keydown") {
    const win = (event.target as Node | null)?.ownerDocument?.defaultView;
    if (!keyAction(event as KeyboardEvent, isMac(win ?? globalThis)))
      return false;
  } else if (event.type === "beforeinput") {
    const type = (event as InputEvent).inputType;
    if (type !== "historyUndo" && type !== "historyRedo") return false;
  } else {
    return false;
  }
  return target(event) !== undefined;
}

/**
 * Which history a key press goes to: the innermost registered element
 * containing the event's target, else the one the user used last. Inputs,
 * textareas, selects and contenteditables not marked with
 * `data-patchwork-undo` keep the browser's own undo of their text.
 */
function target(event: Event): Binding | undefined {
  const origin = event.composedPath()[0];
  if (keepsNativeUndo(origin)) return undefined;
  const binding = innermost(event) ?? realm().lastUsed;
  return binding?.disposed ? undefined : binding;
}

function innermost(event: Event): Binding | undefined {
  const elements = realm().elements;
  for (const node of event.composedPath()) {
    const bindings = elements.get(node as Element);
    if (bindings?.length) return bindings[bindings.length - 1];
  }
  return undefined;
}

const EDITING_HOST = '[contenteditable]:not([contenteditable="false"])';

function keepsNativeUndo(node: EventTarget | undefined): boolean {
  const element = node as HTMLElement | undefined;
  if (!element || element.nodeType !== 1) return false;
  const tag = element.tagName;
  // A form field keeps its own undo unless it is itself marked; a marker
  // on a tool's root mustn't take every field inside it.
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return !element.hasAttribute(UNDO_MARKER);
  }
  if (!element.isContentEditable) return false;
  // An editor that writes to the document is marked (`undoBoundaries` marks
  // CodeMirror's). The marker must be this editor's, not that of an editor
  // around it: a comment draft inside an embed inside the main editor keeps
  // its own undo.
  const host = element.closest(EDITING_HOST);
  const marked = host?.closest(`[${UNDO_MARKER}]`);
  if (!host || !marked) return true;
  const outer = host.parentElement?.closest(EDITING_HOST);
  return !!outer && marked.contains(outer);
}

function acquire(root: DocHandle<unknown>, options: UndoOptions): UndoHistory {
  const histories = realm().histories;
  let shared = histories.get(root);
  if (!shared) {
    shared = { history: new UndoHistory(root, options), refs: 0 };
    histories.set(root, shared);
  }
  shared.refs++;
  return shared.history;
}

function release(root: DocHandle<unknown>) {
  const histories = realm().histories;
  const shared = histories.get(root);
  if (!shared || --shared.refs > 0) return;
  shared.history.dispose();
  histories.delete(root);
}

function rootUrl(handle: DocHandle<unknown>) {
  return stringifyAutomergeUrl({
    documentId: parseAutomergeUrl(handle.url).documentId,
  });
}

class Binding implements Undo {
  readonly #element: HTMLElement | null;
  readonly #handle: DocHandle<unknown>;
  readonly #options: UndoOptions;
  #root!: DocHandle<unknown>;
  #history!: UndoHistory;
  #teardown: Array<() => void> = [];
  readonly #states = new Set<(state: UndoState) => void>();
  readonly #applied = new Set<(event: AppliedEvent) => void>();
  #source: Connection<SourceState> | undefined;
  #state: UndoState = { canUndo: false, canRedo: false };
  #active = 0;
  disposed = false;

  readonly #onChange = (payload: { scopeReplaced?: boolean }) => {
    if (!payload?.scopeReplaced) return;
    // A draft swap: the overlay now writes to a different document.
    if (rootOf(this.#handle, this.#options.repo) === this.#root) return;
    this.#detach();
    this.#attach();
    this.#history.reset();
  };

  constructor(
    element: HTMLElement | null,
    handle: DocHandle<unknown>,
    options: UndoOptions
  ) {
    this.#element = element;
    this.#handle = handle;
    this.#options = options;
    this.#attach();
    handle.on("change", this.#onChange as never);
    if (element) {
      const elements = realm().elements;
      const list = elements.get(element) ?? [];
      list.push(this);
      elements.set(element, list);
      const win = element.ownerDocument.defaultView;
      if (win) install(win as Window & typeof globalThis);
    }
  }

  get history() {
    return this.#history;
  }

  get canUndo() {
    return this.#history.canUndo;
  }

  get canRedo() {
    return this.#history.canRedo;
  }

  undo(options?: PressOptions) {
    this.markActive();
    return this.#history.undo(options);
  }

  redo(options?: PressOptions) {
    this.markActive();
    return this.#history.redo(options);
  }

  checkpoint() {
    this.#history.checkpoint();
  }

  subscribe(listener: (state: UndoState) => void) {
    this.#states.add(listener);
    listener(this.#history.state);
    return () => this.#states.delete(listener);
  }

  onApplied(listener: (event: AppliedEvent) => void) {
    this.#applied.add(listener);
    return () => this.#applied.delete(listener);
  }

  /** @internal The user just used this binding's element. */
  markActive() {
    this.#active = Date.now();
    this.#announce();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.#handle.off("change", this.#onChange as never);
    this.#detach();
    const state = realm();
    if (this.#element) {
      const list = state.elements.get(this.#element) ?? [];
      const rest = list.filter((b) => b !== this);
      if (rest.length) state.elements.set(this.#element, rest);
      else state.elements.delete(this.#element);
    }
    if (state.lastUsed === this) state.lastUsed = undefined;
    this.#states.clear();
    this.#applied.clear();
  }

  #attach() {
    this.#root = rootOf(this.#handle, this.#options.repo);
    this.#history = acquire(this.#root, this.#options);
    const history = this.#history;
    this.#teardown.push(history.configure(this, this.#options));
    this.#teardown.push(
      history.subscribe((state) => {
        this.#state = state;
        for (const listener of this.#states) listener(state);
        this.#announce();
      })
    );
    this.#teardown.push(
      history.onApplied((event) => {
        for (const listener of this.#applied) listener(event);
      })
    );
    if (this.#element) this.#openSource();
    const root = this.#root;
    this.#teardown.push(() => release(root));
  }

  #detach() {
    for (const fn of this.#teardown.splice(0)) fn();
    this.#source?.close();
    this.#source = undefined;
  }

  // Announce this history to the `patchwork:undo` provider: it learns the
  // state from us and sends us the host's undo and redo commands.
  #openSource() {
    const selector: SourceSelector = {
      type: UNDO_SOURCE,
      url: rootUrl(this.#handle),
      backing: rootUrl(this.#root),
    };
    this.#source = connect<SourceCommand, SourceState>(
      this.#element!,
      selector,
      (message) => {
        if (message.command === "undo") this.undo();
        else if (message.command === "redo") this.redo();
      }
    );
    this.#announce();
  }

  #announce() {
    this.#source?.send({ ...this.#state, active: this.#active });
  }
}
