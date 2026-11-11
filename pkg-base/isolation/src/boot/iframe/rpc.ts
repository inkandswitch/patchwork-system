/**
 * The iframe side of the host RPC — request/reply for module source and static
 * resources. Runs inside the sandbox: like the other iframe helpers it's defined
 * at module scope (so tsc checks it) but serialized into the srcdoc by
 * ../host/srcdoc.ts and called from `boot()`.
 *
 * `createRpcClient` owns the reply-matching maps and the request counter, and
 * exposes the two senders plus `handle()`. `boot()` owns the RPC `MessagePort`
 * itself — because that one port also carries messages for other features
 * (live plugin registrations, the providers bridge) — so `boot()` registers the
 * port listener and calls `handle()` first, falling through to its own cases for
 * anything the client doesn't consume.
 */

export interface FetchModuleResult {
  source: string;
  resolvedUrl: string;
}

export interface FetchResourceResult {
  body: ArrayBuffer;
  contentType: string;
}

export interface RpcClient {
  /** Request a module's source + resolved URL (for the es-module-shims hook). */
  fetchModule(url: string): Promise<FetchModuleResult>;
  /** Request a static resource's bytes + content type (for the fetch proxy). */
  fetchResource(url: string): Promise<FetchResourceResult>;
  /**
   * Handle an inbound RPC message. Returns true if it was one of this client's
   * replies (and was consumed), false otherwise — letting the caller route the
   * message to another handler.
   */
  handle(event: MessageEvent): boolean;
}

/**
 * Create the iframe's RPC client over `port`. The port is owned by the caller
 * (`boot()`); this only sends requests and resolves the replies it recognizes.
 */
export function createRpcClient(port: MessagePort): RpcClient {
  const pendingModuleFetches = new Map<
    number,
    { resolve: (r: FetchModuleResult) => void; reject: (e: Error) => void }
  >();
  const pendingResourceFetches = new Map<
    number,
    { resolve: (r: FetchResourceResult) => void; reject: (e: Error) => void }
  >();
  let fetchId = 0;

  function fetchModule(url: string): Promise<FetchModuleResult> {
    return new Promise((resolve, reject) => {
      const id = ++fetchId;
      pendingModuleFetches.set(id, { resolve, reject });
      port.postMessage({ type: "fetch-package", id, url });
    });
  }

  function fetchResource(url: string): Promise<FetchResourceResult> {
    return new Promise((resolve, reject) => {
      const id = ++fetchId;
      pendingResourceFetches.set(id, { resolve, reject });
      port.postMessage({ type: "fetch-resource", id, url });
    });
  }

  function handle(event: MessageEvent): boolean {
    const msg = event.data;
    if (!msg) return false;

    if (msg.type === "fetch-package-response") {
      const pending = pendingModuleFetches.get(msg.id);
      if (pending) {
        pendingModuleFetches.delete(msg.id);
        pending.resolve({ source: msg.source, resolvedUrl: msg.resolvedUrl });
      }
      return true;
    }
    if (msg.type === "fetch-package-error") {
      const pending = pendingModuleFetches.get(msg.id);
      if (pending) {
        pendingModuleFetches.delete(msg.id);
        pending.reject(new Error(msg.error));
      }
      return true;
    }
    if (msg.type === "fetch-resource-response") {
      const pending = pendingResourceFetches.get(msg.id);
      if (pending) {
        pendingResourceFetches.delete(msg.id);
        pending.resolve({ body: msg.body, contentType: msg.contentType });
      }
      return true;
    }
    if (msg.type === "fetch-resource-error") {
      const pending = pendingResourceFetches.get(msg.id);
      if (pending) {
        pendingResourceFetches.delete(msg.id);
        pending.reject(new Error(msg.error));
      }
      return true;
    }

    return false;
  }

  return { fetchModule, fetchResource, handle };
}
