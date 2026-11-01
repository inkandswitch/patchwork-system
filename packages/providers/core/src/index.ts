import type { Repo } from "@automerge/automerge-repo/slim";

export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONArray
  | JSONObject;

export type JSONArray = JSONValue[];
export type JSONObject = { [key: string]: JSONValue };

/**
 * What a subscription is keyed on. A plain JSON object that always carries a
 * `type` discriminant; any other fields are subscription-specific arguments
 * (e.g. `{ type: "patchwork:comments", url }`). Being JSON means it survives
 * the structured clone across the `patchwork:subscribe` event boundary.
 */
export type Selector = { type: string } & { [key: string]: JSONValue };

export type SubscribeEventDetail = {
  selector: Selector;
  port: MessagePort;
};

export type SubscribeEvent = CustomEvent<SubscribeEventDetail>;

type Listener<T extends JSONValue> = (value: T) => void;
type Unsubscribe = () => void;

/**
 * What a producer calls to push a value. The optional `transfer` list is
 * forwarded straight to the underlying `MessagePort.postMessage`, so every
 * `Transferable` it names (an `ArrayBuffer`, `MessagePort`, `ImageBitmap`, …)
 * is *moved* to the consumer rather than structured-cloned. Each transferable
 * must be reachable from `value`, and is neutered on this side once sent.
 */
type Respond<T> = (value: T, transfer?: Transferable[]) => void;

/**
 * What a producer gets besides `respond`: `onCommand` registers a handler for
 * the commands the consumer sends with {@link Connection.send}.
 */
export type AcceptContext<C = JSONValue> = {
  onCommand(handler: (command: C) => void): void;
};

type Producer<T, C = JSONValue> = (
  respond: Respond<T>,
  context: AcceptContext<C>
) => Unsubscribe | void;

type ChangeMessage<T> = { type: "change"; value: T };
type UnsubscribeMessage = { type: "unsubscribe" };
type CommandMessage<C> = { type: "command"; value: C };

/**
 * A subscription the consumer can also talk back on: `send` posts a command
 * to the answering provider over the subscription's own port, `close`
 * unsubscribes. Commands sent before a provider answers are queued by the
 * port and delivered once it does; with no provider they go nowhere.
 */
export type Connection<C = JSONValue> = {
  send(command: C): void;
  close(): void;
};

declare global {
  interface ElementEventMap {
    "patchwork:subscribe": SubscribeEvent;
  }
  // Set once by the host (the bootloader) so providers and consumers can
  // recover live `DocHandle`s without serializing them across the channel.
  // eslint-disable-next-line no-var
  var repo: Repo | undefined;
}

const viewTags = new Set(["patchwork-view"]);

export function registerPatchworkViewTag(tagName: string) {
  viewTags.add(tagName.toLowerCase());
}

/**
 * Open a streaming subscription. Dispatches a `patchwork:subscribe` for the
 * given `selector` carrying a fresh `MessageChannel` port; the answering
 * provider pushes values back over that channel for as long as the
 * subscription is live. `listener` is invoked once per emission (the first
 * delivery is always async because `MessagePort.postMessage` queues a task).
 *
 * The event is dispatched from the nearest enclosing `<patchwork-view>` so
 * callers can pass any node inside a provider subtree. An unclaimed
 * subscription is never settled: if no provider answers, `listener` simply
 * never fires.
 *
 * Returns an unsubscribe function. Calling it tells the provider to tear down
 * (via an `unsubscribe` message) and closes the consumer's port; any values
 * the provider emits after that are dropped.
 */
export function subscribe<T extends JSONValue = JSONValue>(
  element: HTMLElement,
  selector: Selector,
  listener: Listener<T>
): Unsubscribe {
  return connect<T>(element, selector, listener).close;
}

/**
 * {@link subscribe}, plus a way back: the returned connection's `send` posts
 * a command to the answering provider, which receives it through the
 * `onCommand` of its {@link accept} producer. Commands travel on the
 * subscription's own port, so they reach exactly the provider that answered,
 * in whatever realm it lives, and stop with the subscription.
 */
export function connect<T extends JSONValue = JSONValue, C = JSONValue>(
  element: HTMLElement,
  selector: Selector,
  listener: Listener<T>
): Connection<C> {
  const view = element.closest<HTMLElement>([...viewTags].join(","));
  const dispatchEl = view ?? element;

  const channel = new MessageChannel();
  const port = channel.port2;

  const controller = new AbortController();
  const { signal } = controller;
  port.addEventListener(
    "message",
    (event: MessageEvent<ChangeMessage<T>>) => {
      if (event.data?.type === "change") listener(event.data.value);
    },
    { signal }
  );
  // addEventListener (unlike assigning onmessage) does not implicitly start
  // the port, so message delivery has to be kicked off explicitly.
  port.start();

  const detail: SubscribeEventDetail = {
    selector,
    port: channel.port1,
  };

  dispatchEl.dispatchEvent(
    new CustomEvent<SubscribeEventDetail>("patchwork:subscribe", {
      detail,
      bubbles: true,
      composed: true,
    })
  );

  return {
    send(command) {
      if (signal.aborted) return;
      port.postMessage({ type: "command", value: command });
    },
    close() {
      if (signal.aborted) return;
      controller.abort();
      port.postMessage({ type: "unsubscribe" });
      port.close();
    },
  };
}

/**
 * Answer a `patchwork:subscribe`. The `producer` receives a `respond`
 * callback it can call any number of times to push values to the consumer,
 * and may return a teardown that runs when the consumer unsubscribes. Stops
 * propagation so ancestor providers don't double-answer. Values emitted after
 * the consumer unsubscribes are dropped.
 *
 * `respond` takes an optional list of `Transferable`s as a second argument;
 * they are handed to `MessagePort.postMessage` so the named objects are moved
 * to the consumer instead of copied. Use this when the value carries something
 * that can't be (or is expensive to) structured-clone, e.g. a `MessagePort`
 * or a large `ArrayBuffer`. `T` is left unconstrained for this reason — once
 * you transfer, the value is no longer plain JSON.
 *
 * The producer's second argument, `context`, carries `onCommand`: handlers
 * registered there receive what a consumer opened with {@link connect}
 * sends. Commands arriving after the subscription ended are dropped.
 */
export function accept<T = JSONValue, C = JSONValue>(
  event: SubscribeEvent,
  producer: Producer<T, C>
): void {
  event.stopPropagation();
  const port = event.detail.port;

  let alive = true;
  const respond: Respond<T> = (value, transfer) => {
    if (!alive) return;
    port.postMessage({ type: "change", value }, transfer ?? []);
  };

  const commandHandlers: Array<(command: C) => void> = [];
  const context: AcceptContext<C> = {
    onCommand(handler) {
      commandHandlers.push(handler);
    },
  };

  let teardown: Unsubscribe | void;
  try {
    teardown = producer(respond, context);
  } catch (err) {
    console.error("[patchwork-providers] subscribe producer threw:", err);
  }

  const stop = () => {
    if (!alive) return;
    alive = false;
    try {
      teardown?.();
    } catch (err) {
      console.error("[patchwork-providers] subscribe teardown threw:", err);
    }
    port.close();
  };

  port.onmessage = (
    event: MessageEvent<UnsubscribeMessage | CommandMessage<C>>
  ) => {
    if (event.data?.type === "unsubscribe") stop();
    else if (event.data?.type === "command" && alive) {
      for (const handler of commandHandlers) {
        try {
          handler(event.data.value);
        } catch (err) {
          console.error("[patchwork-providers] command handler threw:", err);
        }
      }
    }
  };
}

/**
 * One-shot convenience wrapper over {@link subscribe}: opens a subscription
 * for `selector`, resolves with the first value a provider emits, then
 * immediately unsubscribes. Because there is no fallback provider, an
 * unclaimed selector never resolves — use `subscribe` directly if you need to
 * handle the "no provider" case.
 */
export function request<T extends JSONValue = JSONValue>(
  element: HTMLElement,
  selector: Selector
): Promise<T> {
  return new Promise<T>((resolve) => {
    const unsubscribe = subscribe<T>(element, selector, (value) => {
      // The first emission is always async (postMessage queues a task), so
      // `unsubscribe` is assigned by the time this fires.
      unsubscribe();
      resolve(value);
    });
  });
}

export {
  registerRepoProviderElement,
  type RepoProviderElement,
} from "./repo-provider.js";
export type { RepoLike } from "./types.js";
export { OverlayHandle, type OverlayHandleOpts } from "./overlay-handle.js";
export { OverlayRepo, type DocHandleDescriptor } from "./overlay-repo.js";
