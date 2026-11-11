/**
 * Host-origin fetch proxy for the sandboxed iframe. Injected into `boot()` and
 * serialized into the srcdoc by ../host/srcdoc.ts (see ./main.ts).
 */

import type { IframeLog } from "./types.js";
import type { FetchResourceResult } from "./rpc.js";

/**
 * Install the host-origin fetch proxy. The sandboxed iframe can't reach the
 * host's service worker, so any fetch to a host-origin URL (package resources,
 * CSS @imports, etc.) is routed through the RPC `fetchResource` sender instead;
 * everything else falls through to the real `fetch`. Installed after WASM init
 * so `initializeWasm`/`initSync` aren't affected.
 */
export function installFetchProxy(
  hostOrigin: string,
  fetchResource: (url: string) => Promise<FetchResourceResult>,
  log: IframeLog
): void {
  const originalFetch = self.fetch;
  (self as any).fetch = async (
    input: RequestInfo | URL,
    requestInit?: RequestInit
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith(hostOrigin)) {
      const result = await fetchResource(url);
      return new Response(result.body, {
        status: 200,
        headers: { "Content-Type": result.contentType },
      });
    }
    return originalFetch(input, requestInit);
  };
  log("fetch proxy installed");
}
