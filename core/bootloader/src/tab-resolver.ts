// Answering the service worker's requests with this tab's own Repo. The
// service worker asks the tab that made a request first, then any other tab,
// and only broadcasts to the automerge worker when none of them can; a tab
// that hasn't been handed its Repo yet says so straight away.
import type { Repo } from "@automerge/automerge-repo/slim";

import { createResolver, type Resolver } from "./resolver.js";
import type {
  HandoffReplyMessage,
  ResolveAcceptedMessage,
  ResolveRequestMessage,
  ResolveUnavailableMessage,
} from "./types.js";

let resolver: Resolver | undefined;

/**
 * Resolve the service worker's `automerge:` requests with `repo` from now on,
 * rather than leaving them to the automerge worker. What they load stays in
 * `repo`.
 */
export function resolveHandoffsWith(repo: Repo): void {
  resolver = createResolver(() => Promise.resolve(repo));
}

/** Answer a ResolveRequestMessage; false if `event` isn't one. */
export function handleResolveRequest(event: MessageEvent): boolean {
  if (event.data?.type !== "resolve") return false;
  const [port] = event.ports;
  if (!port) return true;
  const message = event.data as ResolveRequestMessage;
  const current = resolver;
  if (!current) {
    port.postMessage({ type: "unavailable" } satisfies ResolveUnavailableMessage);
    return true;
  }

  const answer = () =>
    current
      .answer({ ...message, type: "request" })
      .catch(
        (error): HandoffReplyMessage => ({
          id: message.id,
          type: "response",
          response: { status: 557, body: String(error) },
        })
      )
      .then((reply) =>
        port.postMessage(
          reply ?? ({ type: "unavailable" } satisfies ResolveUnavailableMessage)
        )
      );

  if (!navigator.locks) {
    port.postMessage({ type: "accepted" } satisfies ResolveAcceptedMessage);
    void answer();
    return true;
  }
  // Released once the reply is posted, or when this tab goes.
  const lock = `@patchwork/resolve/${message.id}/${crypto.randomUUID()}`;
  void navigator.locks.request(lock, () => {
    port.postMessage({ type: "accepted", lock } satisfies ResolveAcceptedMessage);
    return answer();
  });
  return true;
}
