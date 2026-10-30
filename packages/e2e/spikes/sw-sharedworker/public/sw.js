// Spike: can the service worker talk to a SharedWorker client and tell, from
// what the platform reports, that an answer came from that worker?
//
// Three reply paths are measured for a service-worker-initiated ping:
//   controller: the worker posts to navigator.serviceWorker.controller, and
//               we read event.source (a Client: url, type)
//   port:       the worker answers on a MessagePort we sent with the ping
//   fetch:      the worker fetch()es /__spike/pong, and we look its clientId up
// and one worker-initiated path:
//   hello:      the worker posts a MessagePort to the controller at startup;
//               we check event.source, keep the port, and ping over it.

const WORKER_PATH = "/shared.js?v=spike";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim())
);

const describe = (source) => {
  if (!source) return null;
  if (typeof Client !== "undefined" && source instanceof Client) {
    return { kind: "Client", url: source.url, type: source.type, id: source.id };
  }
  if (typeof MessagePort !== "undefined" && source instanceof MessagePort) {
    return { kind: "MessagePort" };
  }
  return { kind: Object.prototype.toString.call(source) };
};

const replies = new Map(); // nonce -> { via -> observation }
const record = (nonce, via, observation) => {
  if (!replies.has(nonce)) replies.set(nonce, {});
  replies.get(nonce)[via] = { at: Date.now(), ...observation };
};
const collect = (nonce, ms) =>
  new Promise((resolve) => setTimeout(() => resolve(replies.get(nonce) ?? {}), ms));

const hellos = []; // { source, port }
const helloFetches = [];
const forged = [];

self.addEventListener("message", (event) => {
  const data = event.data ?? {};
  switch (data.type) {
    case "run":
      event.waitUntil(run(event.ports[0]));
      break;
    case "hello":
      hellos.push({
        kind: data.kind,
        source: describe(event.source),
        hasPort: !!event.ports[0],
        port: event.ports[0],
      });
      break;
    case "pong":
      record(data.nonce, "controller", { source: describe(event.source) });
      break;
    case "forged-pong":
      forged.push({ source: describe(event.source) });
      break;
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith("/__spike/")) return;
  event.respondWith(
    (async () => {
      const client = event.clientId
        ? await self.clients.get(event.clientId)
        : undefined;
      const observation = {
        clientId: event.clientId,
        client: describe(client),
      };
      if (url.pathname === "/__spike/pong") {
        record(url.searchParams.get("nonce"), "fetch", observation);
      } else if (url.pathname === "/__spike/hello") {
        helloFetches.push({ kind: url.searchParams.get("kind"), ...observation });
      }
      // The worker compares this with what the server says, to tell whether
      // its fetches reach us at all.
      return new Response("sw", { headers: { "cache-control": "no-store" } });
    })()
  );
});

async function pingOverHelloPort(hello) {
  const nonce = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    hello.port.onmessage = (event) => {
      if (event.data?.nonce !== nonce) return;
      clearTimeout(timer);
      resolve(true);
    };
    hello.port.postMessage({ type: "ping-on-hello-port", nonce });
  });
}

async function run(reply) {
  const results = { workerHref: new URL(WORKER_PATH, self.location).href };

  const all = await self.clients.matchAll({ type: "all", includeUncontrolled: true });
  results.allClients = all.map(describe);
  results.controlledSharedWorkers = (
    await self.clients.matchAll({ type: "sharedworker" })
  ).map(describe);
  results.allSharedWorkers = (
    await self.clients.matchAll({ type: "sharedworker", includeUncontrolled: true })
  ).map(describe);

  const target = all.find((client) => client.type === "sharedworker");
  results.sharedWorkerFound = !!target;
  results.sharedWorkerUrlMatches = target?.url === results.workerHref;

  if (target) {
    const nonce = crypto.randomUUID();
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = (event) => {
      if (event.data?.nonce === nonce) {
        record(nonce, "port", { source: describe(event.source) });
      }
    };
    try {
      target.postMessage({ type: "ping", nonce }, [port2]);
      results.swToWorkerPostMessage = "sent";
    } catch (error) {
      results.swToWorkerPostMessage = `threw: ${error}`;
    }
    results.swToWorkerReplies = await collect(nonce, 3000);
  }

  results.hellos = hellos.map(({ port, ...rest }) => rest);
  results.helloFetches = helloFetches;
  const sharedHello = hellos.find((hello) => hello.source?.type === "sharedworker");
  results.helloPortRoundTrip = sharedHello?.port
    ? await pingOverHelloPort(sharedHello)
    : null;
  results.forgedFromWindow = forged;

  reply.postMessage(results);
}
