import type {
  ManagedTransport,
  WebSocketEndpointInterface,
} from "@automerge/automerge-repo/slim";

// Subduction derives a service name from the endpoint url's host, and both
// ends have to name the same one, so the url is a fiction with a meaningful
// host rather than a real socket address.
export const WORKER_SUBDUCTION_URL = "ws://bench-subduction-worker";
export const WORKER_SUBDUCTION_SERVICE = new URL(WORKER_SUBDUCTION_URL).host;

const BYE = "bye";

/**
 * A Subduction transport over a MessagePort. Frames are raw ArrayBuffers, so
 * the far side needs no protocol beyond this one.
 */
export class MessagePortTransport implements ManagedTransport {
  #port: MessagePort;
  #queue: Uint8Array[] = [];
  #waiters: Array<{
    resolve: (bytes: Uint8Array) => void;
    reject: (error: Error) => void;
  }> = [];
  #closed = false;
  #closedResolvers = Promise.withResolvers<void>();
  #onDisconnect: (() => void) | null = null;

  constructor(port: MessagePort) {
    this.#port = port;
    port.addEventListener("message", (event: MessageEvent) => {
      if (this.#closed) return;
      if (event.data === BYE) return this.#teardown(true);
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      const waiter = this.#waiters.shift();
      if (waiter) waiter.resolve(bytes);
      else this.#queue.push(bytes);
    });
    port.addEventListener("close", () => this.#teardown(true));
    port.start();
  }

  async sendBytes(bytes: Uint8Array): Promise<void> {
    if (this.#closed) throw new Error("worker link closed");
    const buffer = bytes.slice().buffer;
    this.#port.postMessage(buffer, [buffer]);
  }

  recvBytes(): Promise<Uint8Array> {
    const queued = this.#queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.#closed) return Promise.reject(new Error("worker link closed"));
    return new Promise((resolve, reject) =>
      this.#waiters.push({ resolve, reject })
    );
  }

  onDisconnect(callback: () => void): void {
    this.#onDisconnect = callback;
  }

  async disconnect(): Promise<void> {
    if (this.#closed) return;
    try {
      this.#port.postMessage(BYE);
    } catch {}
    this.#teardown(false);
  }

  closed(): Promise<void> {
    return this.#closedResolvers.promise;
  }

  #teardown(remote: boolean): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue = [];
    const error = new Error("worker link closed");
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
    this.#closedResolvers.resolve();
    try {
      this.#port.close();
    } catch {}
    if (remote) this.#onDisconnect?.();
  }
}

/**
 * The tab's Subduction endpoint for a worker-hosted node. `openPort` is called
 * for every (re)connection, so automerge-repo's reconnect loop drives it like
 * a socket.
 */
export class WorkerSubductionEndpoint implements WebSocketEndpointInterface {
  readonly url = WORKER_SUBDUCTION_URL;
  #openPort: () => Promise<MessagePort>;

  constructor(openPort: () => Promise<MessagePort>) {
    this.#openPort = openPort;
  }

  async connect(): Promise<ManagedTransport> {
    return new MessagePortTransport(await this.#openPort());
  }
}
