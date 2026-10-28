// The automerge worker's answers to the service worker, and how the service worker tells they
// really are its. A BroadcastChannel can't: anything on the origin can listen and answer first.
// Messages on a port carry no sender at all. A fetch() carries its client: the service worker
// looks `clientId` up and checks the client is a SharedWorker running the worker's script.
// That's the only reply path every engine supports; Chromium has no navigator.serviceWorker in
// workers (see the spec's spike results).
import {
  AUTOMERGE_WORKER_PATH,
  INDEX_ANSWER_PATH,
  type IndexAnswer,
} from "./types.js";

const ACCEPTED_HEADER = "x-patchwork-index";

/**
 * True only for the automerge worker: a SharedWorker on this origin running its script, whatever
 * the query. Any page can start a dedicated Worker from the same URL, which reports the same url
 * with type "worker", so the type matters as much as the url.
 */
export function isAutomergeWorker(
  client: Pick<Client, "type" | "url"> | undefined,
  origin: string
): boolean {
  if (client?.type !== "sharedworker") return false;
  try {
    const url = new URL(client.url);
    return url.origin === origin && url.pathname === AUTOMERGE_WORKER_PATH;
  } catch {
    return false;
  }
}

const isAnswer = (value: unknown): value is IndexAnswer =>
  !!value &&
  typeof value === "object" &&
  typeof (value as IndexAnswer).id === "string";

/** The service worker's side of a POST to INDEX_ANSWER_PATH. */
export async function acceptIndexAnswer(
  request: Request,
  client: Pick<Client, "type" | "url"> | undefined,
  origin: string,
  onAnswer: (answer: IndexAnswer) => void
): Promise<Response> {
  if (!isAutomergeWorker(client, origin)) {
    console.warn(
      `refusing an index answer from ${client?.type ?? "an unknown client"} at ${client?.url ?? "?"}`
    );
    return new Response("only the automerge worker answers here", { status: 403 });
  }
  const body: unknown = await request.json().catch(() => undefined);
  if (!isAnswer(body)) return new Response("not an index answer", { status: 400 });
  onAnswer(body);
  return new Response(null, { status: 204, headers: { [ACCEPTED_HEADER]: "accepted" } });
}

const TRIES = 5;
const RETRY_MS = 200;

/**
 * The automerge worker's side: POST an answer. A reply without the accepted header never reached
 * the service worker (Firefox sends a worker's first fetch straight to the network), so try
 * again a few times. False if it never got through.
 */
export async function postIndexAnswer(
  answer: IndexAnswer,
  fetcher: typeof fetch = fetch
): Promise<boolean> {
  const body = JSON.stringify(answer);
  for (let i = 0; i < TRIES; i++) {
    if (i) await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    const response = await fetcher(INDEX_ANSWER_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }).catch(() => undefined);
    if (response?.headers.get(ACCEPTED_HEADER) === "accepted") return true;
  }
  return false;
}
