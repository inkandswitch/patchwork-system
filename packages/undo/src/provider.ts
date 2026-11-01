import {
  accept,
  connect,
  type SubscribeEvent,
} from "@inkandswitch/patchwork-providers";

import {
  UNDO,
  UNDO_SOURCE,
  type SourceCommand,
  type SourceSelector,
  type SourceState,
  type UndoCommand,
  type UndoSelector,
  type UndoStatus,
} from "./protocol.js";

type Source = {
  url: string;
  backing: string;
  state: SourceState;
  order: number;
  send: (command: SourceCommand) => void;
};

type Watcher = { url?: string; respond: (status: UndoStatus) => void };

/**
 * Answer `patchwork:undo` (and the realms' `patchwork:undo-source`) for
 * everything below `element`. Returns a function that stops answering.
 *
 * The provider never touches a history: histories live in the realm that
 * edits the document. Each announces itself over a subscription of its
 * own and reports its state; the provider forwards host commands back over
 * that subscription's port, so it works wherever the port can reach.
 */
export function installUndoProvider(element: HTMLElement): () => void {
  const sources = new Set<Source>();
  const watchers = new Set<Watcher>();
  let order = 0;

  const pick = (url?: string): Source | undefined => {
    let best: Source | undefined;
    for (const source of sources) {
      if (url && source.url !== url && source.backing !== url) continue;
      if (
        !best ||
        source.state.active > best.state.active ||
        (source.state.active === best.state.active && source.order > best.order)
      ) {
        best = source;
      }
    }
    return best;
  };

  const status = (url?: string): UndoStatus => {
    const source = pick(url);
    return {
      url: source?.url ?? url ?? null,
      canUndo: source?.state.canUndo ?? false,
      canRedo: source?.state.canRedo ?? false,
    };
  };

  const notify = () => {
    for (const watcher of watchers) watcher.respond(status(watcher.url));
  };

  const onSubscribe = (event: SubscribeEvent) => {
    const selector = event.detail.selector;
    if (selector.type === UNDO_SOURCE) {
      const { url, backing } = selector as unknown as SourceSelector;
      accept<SourceCommand, SourceState>(event, (respond, { onCommand }) => {
        const source: Source = {
          url,
          backing,
          state: { canUndo: false, canRedo: false, active: 0 },
          order: order++,
          send: respond,
        };
        sources.add(source);
        onCommand((state) => {
          source.state = state;
          notify();
        });
        return () => {
          sources.delete(source);
          notify();
        };
      });
    } else if (selector.type === UNDO) {
      const { url } = selector as unknown as UndoSelector;
      accept<UndoStatus, UndoCommand>(event, (respond, { onCommand }) => {
        const watcher: Watcher = { url, respond };
        watchers.add(watcher);
        respond(status(url));
        onCommand((command) => {
          if (command !== "undo" && command !== "redo") return;
          pick(url)?.send({ command });
        });
        return () => watchers.delete(watcher);
      });
    }
  };

  element.addEventListener("patchwork:subscribe", onSubscribe);
  return () => element.removeEventListener("patchwork:subscribe", onSubscribe);
}

/**
 * Defines `<undo-provider>`, which answers `patchwork:undo` for its subtree.
 * Patchwork's `setup()` mounts one where it mounts `<repo-provider>`.
 */
export function registerUndoProviderElement(name = "undo-provider"): void {
  if (customElements.get(name)) return;
  customElements.define(
    name,
    class extends HTMLElement {
      constructor() {
        super();
        installUndoProvider(this);
      }

      connectedCallback() {
        if (!this.style.display) this.style.display = "contents";
      }
    }
  );
}

export type UndoWatch = {
  undo(): void;
  redo(): void;
  close(): void;
};

/**
 * For host UI: watch the undo state of the document at `url` (or, without
 * one, of the document the user used last) and send it undo and redo.
 */
export function watchUndo(
  element: HTMLElement,
  url: string | undefined,
  listener: (status: UndoStatus) => void
): UndoWatch {
  const selector: UndoSelector = url ? { type: UNDO, url } : { type: UNDO };
  const connection = connect<UndoStatus, UndoCommand>(
    element,
    selector,
    listener
  );
  return {
    undo: () => connection.send("undo"),
    redo: () => connection.send("redo"),
    close: connection.close,
  };
}
