// Loaded twice by the page: as the module SharedWorker the spike is about, and
// as a dedicated Worker from the same URL, the impostor any page on the origin
// can start. The service worker should be able to tell them apart.

const isShared =
  typeof SharedWorkerGlobalScope !== "undefined" &&
  self instanceof SharedWorkerGlobalScope;
const kind = isShared ? "shared" : "dedicated";
const sw = self.navigator?.serviceWorker;

const env = {
  kind,
  hasNavigatorServiceWorker: !!sw,
  hasController: !!sw?.controller,
  pingsReceived: [],
};

function onPing(event, via) {
  const data = event.data;
  if (data?.type !== "ping") return;
  env.pingsReceived.push(via);
  sw?.controller?.postMessage({ type: "pong", nonce: data.nonce });
  event.ports?.[0]?.postMessage({ type: "pong", nonce: data.nonce });
  fetch(`/__spike/pong?nonce=${data.nonce}`).catch(() => {});
}

if (sw) {
  sw.addEventListener("message", (event) => onPing(event, "navigator.serviceWorker"));
  sw.startMessages?.();
}
// Not expected to fire for a service worker's postMessage; recorded in case.
self.addEventListener("message", (event) => onPing(event, "self"));

// Worker-initiated: hand the service worker a port to call us on.
const { port1, port2 } = new MessageChannel();
port1.onmessage = (event) => {
  if (event.data?.type === "ping-on-hello-port") {
    port1.postMessage({ type: "pong-on-hello-port", nonce: event.data.nonce });
  }
};
try {
  sw?.controller?.postMessage({ type: "hello", kind }, [port2]);
  env.helloPosted = !!sw?.controller;
} catch (error) {
  env.helloPosted = `threw: ${error}`;
}

const ready = (async () => {
  env.probe = await fetch("/__spike/probe")
    .then((response) => response.text())
    .catch((error) => `error: ${error}`);
  env.fetchesReachServiceWorker = env.probe === "sw";
  await fetch(`/__spike/hello?kind=${kind}`).catch(() => {});
  return env;
})();

if (isShared) {
  self.addEventListener("connect", (event) => {
    const port = event.ports[0];
    ready.then((env) => port.postMessage({ type: "env", env }));
  });
} else {
  ready.then((env) => self.postMessage({ type: "env", env }));
}
