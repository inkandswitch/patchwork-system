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
 * What a subscription asks for: a JSON object with a `type`, plus whatever
 * arguments that type takes (`{ type: "patchwork:comments", url }`). It's JSON
 * so it survives the structured clone.
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
 * Push a value. Anything named in `transfer` is moved to the consumer, not
 * copied.
 */
type Respond<T> = (value: T, transfer?: Transferable[]) => void;
type Producer<T> = (respond: Respond<T>) => Unsubscribe | void;

type ChangeMessage<T> = { type: "change"; value: T };
type UnsubscribeMessage = { type: "unsubscribe" };

declare global {
  interface ElementEventMap {
    "patchwork:subscribe": SubscribeEvent;
  }
  // Set once by the host (the bootloader), so live `DocHandle`s can be found
  // without sending them across the channel.
  // eslint-disable-next-line no-var
  var repo: Repo | undefined;
}

const viewTags = new Set(["patchwork-view"]);

export function registerPatchworkViewTag(tagName: string) {
  viewTags.add(tagName.toLowerCase());
}

/**
 * Open a streaming subscription: dispatch `patchwork:subscribe` for
 * `selector` with a fresh `MessageChannel` port, and call `listener` with each
 * value the answering provider sends back (never synchronously). The event
 * starts at the nearest enclosing view element (see
 * {@link registerPatchworkViewTag}), or at `element` if there isn't one. If no
 * provider answers, `listener` never fires.
 *
 * Returns an unsubscribe, which tells the provider to tear down; anything it
 * sends after that is dropped.
 */
export function subscribe<T extends JSONValue = JSONValue>(
  element: HTMLElement,
  selector: Selector,
  listener: Listener<T>
): Unsubscribe {
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
  // addEventListener, unlike onmessage, doesn't start the port.
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

  return () => {
    if (signal.aborted) return;
    controller.abort();
    port.postMessage({ type: "unsubscribe" });
    port.close();
  };
}

/**
 * Answer a `patchwork:subscribe`. `producer` gets a `respond` it may call any
 * number of times, and may return a teardown for when the consumer
 * unsubscribes. Stops propagation, so providers further up don't answer too.
 *
 * `respond` takes a list of `Transferable`s as its second argument, moved
 * rather than copied: for values that can't be structured-cloned, or are
 * costly to, like a `MessagePort` or a large `ArrayBuffer`. That's why `T` is
 * unconstrained: once you transfer, the value isn't plain JSON.
 */
export function accept<T = JSONValue>(
  event: SubscribeEvent,
  producer: Producer<T>
): void {
  event.stopPropagation();
  const port = event.detail.port;

  let alive = true;
  const respond: Respond<T> = (value, transfer) => {
    if (!alive) return;
    port.postMessage({ type: "change", value }, transfer ?? []);
  };

  let teardown: Unsubscribe | void;
  try {
    teardown = producer(respond);
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

  port.onmessage = (event: MessageEvent<UnsubscribeMessage>) => {
    if (event.data?.type === "unsubscribe") stop();
  };
}

/**
 * Resolve with the first value a provider sends for `selector`, then
 * unsubscribe. Never resolves if no provider answers.
 */
export function request<T extends JSONValue = JSONValue>(
  element: HTMLElement,
  selector: Selector
): Promise<T> {
  return new Promise<T>((resolve) => {
    const unsubscribe = subscribe<T>(element, selector, (value) => {
      // Never called synchronously, so `unsubscribe` is assigned by now.
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
export { getScratchRepo } from "./scratch-repo.js";
