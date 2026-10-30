// Runs the real service worker module in node against a fake global scope:
// `self` (listeners, clients, location), `caches` as in-memory maps, and node's
// own BroadcastChannel and navigator.locks. Tabs and the automerge worker are
// fake clients; give them real resolvers to test the whole round trip.
import { vi } from "vitest";

export const ORIGIN = "https://p.test";

/** Enough of Cache: put, match and delete, keyed by url. */
export class FakeCache {
  entries = new Map<string, Response>();
  async put(request: RequestInfo | URL, response: Response) {
    this.entries.set(new Request(request).url, response.clone());
  }
  async match(request: RequestInfo | URL) {
    return this.entries.get(new Request(request).url)?.clone();
  }
  async delete(request: RequestInfo | URL) {
    return this.entries.delete(new Request(request).url);
  }
  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

export class FakeCaches {
  named = new Map<string, FakeCache>();
  async open(name: string) {
    let cache = this.named.get(name);
    if (!cache) this.named.set(name, (cache = new FakeCache()));
    return cache as unknown as Cache;
  }
  async has(name: string) {
    return this.named.has(name);
  }
  async delete(name: string) {
    return this.named.delete(name);
  }
  async keys() {
    return [...this.named.keys()];
  }
  async match(request: RequestInfo | URL) {
    for (const cache of this.named.values()) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }
    return undefined;
  }
}

export type FakeClient = {
  id: string;
  type: "window" | "worker" | "sharedworker";
  url: string;
  focused?: boolean;
  visibilityState?: "visible" | "hidden";
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

/** A fetch event the test can await: what `respondWith` was given, and every `waitUntil`. */
export type FakeFetchEvent = {
  request: Request;
  clientId: string;
  respondWith(response: Response | Promise<Response>): void;
  waitUntil(work: Promise<unknown>): void;
  /** The response, or undefined if the worker let the request through. */
  response(): Promise<Response> | undefined;
  /** Every waitUntil, settled. */
  settled(): Promise<unknown>;
};

export type ServiceWorkerHarness = {
  caches: FakeCaches;
  clients: Map<string, FakeClient>;
  /** Dispatch a fetch event to the worker. */
  fetch(request: Request, clientId?: string): FakeFetchEvent;
  /** Dispatch a lifecycle event (install, activate) and wait for its waitUntil. */
  lifecycle(type: "install" | "activate"): Promise<void>;
  close(): void;
};

/**
 * A request the platform builds but scripts can't: a navigation. `mode` and
 * `destination` are read-only getters on Request.prototype, so shadow them.
 */
export function navigation(url: string): Request {
  const request = new Request(url);
  Object.defineProperty(request, "mode", { value: "navigate" });
  Object.defineProperty(request, "destination", { value: "document" });
  return request;
}

/** Install the fake scope and import a fresh copy of the service worker module. */
export async function startServiceWorker(): Promise<ServiceWorkerHarness> {
  const listeners = new Map<string, Array<(event: any) => void>>();
  const clients = new Map<string, FakeClient>();
  const caches = new FakeCaches();

  // Every channel the module opens, so a test's service worker doesn't hear
  // the next test's traffic.
  const channels: BroadcastChannel[] = [];
  const RealBroadcastChannel = globalThis.BroadcastChannel;
  class TrackedBroadcastChannel extends RealBroadcastChannel {
    constructor(name: string) {
      super(name);
      channels.push(this);
    }
  }

  const scope = {
    location: new URL(`${ORIGIN}/service-worker.js`),
    registration: { scope: `${ORIGIN}/` },
    addEventListener(type: string, listener: (event: any) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    skipWaiting: async () => {},
    clients: {
      async get(id: string) {
        return clients.get(id);
      },
      async matchAll(options: { type?: string } = {}) {
        return [...clients.values()].filter(
          (client) => !options.type || options.type === "all" || client.type === options.type
        );
      },
      async claim() {},
    },
  };

  vi.stubGlobal("self", scope);
  vi.stubGlobal("caches", caches);
  vi.stubGlobal("BroadcastChannel", TrackedBroadcastChannel);
  vi.resetModules();
  // A fake tab shares this event loop, so its "accepted" can queue behind its
  // own resolving; under load that passes 250ms, the tab counts as silent, and
  // the request waits out a broadcast nothing here answers. Tests that want a
  // tab declined have it say so.
  vi.doMock("../src/handoff-timing.js", () => ({ ACCEPT_TIMEOUT_MS: 10_000 }));
  await import("../src/service-worker.js");
  // The module's own channels are open; the test's are the real class again.
  vi.stubGlobal("BroadcastChannel", RealBroadcastChannel);

  const dispatch = (type: string, event: unknown) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };

  return {
    caches,
    clients,
    fetch(request, clientId = "") {
      let responded: Promise<Response> | undefined;
      const waits: Promise<unknown>[] = [];
      const event: FakeFetchEvent = {
        request,
        clientId,
        respondWith: (response) => void (responded = Promise.resolve(response)),
        waitUntil: (work) => void waits.push(work),
        response: () => responded,
        settled: () => Promise.allSettled(waits),
      };
      dispatch("fetch", event);
      return event;
    },
    async lifecycle(type) {
      const waits: Promise<unknown>[] = [];
      dispatch(type, { waitUntil: (work: Promise<unknown>) => waits.push(work) });
      await Promise.all(waits);
    },
    close() {
      for (const channel of channels) channel.close();
      vi.unstubAllGlobals();
    },
  };
}
