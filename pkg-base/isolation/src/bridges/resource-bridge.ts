/**
 * Resource bridge — owns *resources*: the host-side `fetch-package` /
 * `fetch-resource` RPC and the allowlist that gates it. The sandboxed iframe's
 * opaque origin can't reach the host service worker, so this bridge re-opens that
 * channel over RPC — the iframe asks for a URL, the host classifies, resolves,
 * fetches, and returns it (source + resolved URL for `fetch-package`; bytes +
 * content type for `fetch-resource`).
 *
 * `classify` gates every request: only `platform` (import-map runtime) and
 * `registry` (tool code behind a `registry--` marker) are served, so a tool can't
 * smuggle a raw automerge ID through the proxy. Anything package-specific (marker
 * resolution, source rewriting) is delegated to the registry bridge.
 */

import { log } from "../log.js";
import {
  type PackagesUrlMapper,
  REGISTRY_MARKER_PREFIX,
  resolvePackageRequest,
  rewriteServedSource,
  splitFirstSegment,
} from "./registry-bridge.js";

export interface ResourceBridgeOptions {
  port: MessagePort;
  mapper: PackagesUrlMapper;
}

// ---------------------------------------------------------------------------
// Request classification (allowlist)
// ---------------------------------------------------------------------------

/**
 * First path segments of the platform (import-map) build's runtime code: the
 * bootloader emits externals to `/packages/<name>.js` and Vite hoists their
 * chunks to `/assets/`. Same files for every user, no user data — served freely.
 *
 * Safe as a fixed allowlist because the service worker only loads a *document*
 * when the whole decoded pathname parses as an absolute URL (the encoded automerge
 * URL as the first segment); a `packages`/`assets` first segment is a non-scheme
 * word, so it can never resolve to one.
 */
const PLATFORM_FIRST_SEGMENTS = new Set(["packages", "assets"]);

/**
 * How a served-resource request is handled at the isolation boundary:
 *  - `platform` — import-map runtime code; served straight through.
 *  - `registry` — registry tool code (a `registry--` marker URL); resolved via
 *    the registry bridge and served with its automerge deps rewritten.
 *  - `blocked`  — anything else; rejected before resolution or fetch.
 */
export type RequestClass = "platform" | "registry" | "blocked";

/**
 * Classify a served-resource request — the allowlist gating the fetch proxy.
 * Decided entirely by the FIRST path segment (via `splitFirstSegment`, which
 * normalizes `..`/`.` first, so a traversal like `<origin>/assets/../automerge:<id>/x`
 * presents the smuggled ID as `first` and is blocked). `registry--` and the
 * platform prefixes are ordinary segments the SW can't mistake for a document, so
 * there is no ordering subtlety.
 */
export function classify(url: string): RequestClass {
  // Non-host-origin: an external importUrl (registration-time input), already
  // mapped to a marker before any request — registry code. Inbound requests never
  // legitimately arrive in this form.
  if (!url.startsWith(window.location.origin + "/")) return "registry";

  const { first } = splitFirstSegment(url);

  // Registry: a `registry--` marker. It must have no internal `/` — a decoded
  // segment containing one is an encoded-slash traversal
  // (`registry--x%2F..%2Fautomerge:…`), rejected.
  if (first.startsWith(REGISTRY_MARKER_PREFIX) && !first.includes("/")) {
    return "registry";
  }

  if (PLATFORM_FIRST_SEGMENTS.has(first)) return "platform";

  // Anything else (incl. `<origin>/automerge:…`, a normalized traversal escape).
  return "blocked";
}

/**
 * Shared skeleton for both fetch-proxy handlers: classify once, reject `blocked`,
 * resolve + fetch, post an error on failure. Success handling differs per type, so
 * it's passed as `onResponse` (given the `RequestClass` and responsible for posting
 * the success message — the resource handler transfers its ArrayBuffer).
 */
async function handleFetchRpc(
  msg: { id: number; url: string },
  type: "fetch-package" | "fetch-resource",
  port: MessagePort,
  mapper: PackagesUrlMapper,
  onResponse: (
    response: Response,
    requestClass: RequestClass,
    id: number
  ) => Promise<void> | void
): Promise<void> {
  const errorType = `${type}-error` as const;
  const { id, url } = msg;

  // Classify once; reject `blocked` before any resolution/fetch, pass the verdict on.
  const requestClass = classify(url);
  if (requestClass === "blocked") {
    const error = `blocked: request not allowed by the isolation allowlist (${url})`;
    log(`${type} blocked ${url}`);
    port.postMessage({ type: errorType, id, error });
    return;
  }

  try {
    const fetchUrl = resolvePackageRequest(url, mapper);
    log(fetchUrl !== url ? `${type} ${url} → ${fetchUrl}` : `${type} ${url}`);

    const response = await fetch(fetchUrl);
    if (!response.ok) {
      const error = `HTTP ${response.status}: ${response.statusText} (${fetchUrl})`;
      log(`${type} error ${url}: ${error}`);
      port.postMessage({ type: errorType, id, error });
      return;
    }
    // Awaited so a failure reading the body is caught by the catch below.
    await onResponse(response, requestClass, id);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`${type} error ${url}: ${error}`);
    port.postMessage({ type: errorType, id, error });
  }
}

/**
 * Start the host-side resource bridge — the RPC handler for module and resource
 * loading.
 *
 * Handles two message types:
 *  - `fetch-package`: returns source text + resolved URL (for es-module-shims)
 *  - `fetch-resource`: returns ArrayBuffer + content type (for fetch proxy)
 */
export function startResourceBridge(options: ResourceBridgeOptions): () => void {
  const { port, mapper } = options;

  const onMessage = async (event: MessageEvent) => {
    const msg = event.data;
    if (!msg) return;

    if (msg.type === "fetch-package") {
      await handleFetchRpc(msg, "fetch-package", port, mapper, async (response, requestClass, id) => {
        const rawSource = await response.text();

        // Rewrite baked automerge dep URLs to markers before the source crosses
        // in (a no-op for platform code and for registry packages without deps).
        const source =
          requestClass === "registry"
            ? rewriteServedSource(rawSource, msg.url, mapper)
            : rawSource;

        // Return the requested URL (`msg.url`) as the resolved URL, so esms
        // resolves relative chunk imports against the marker/path — never the real
        // location. Deliberately NOT `response.url`: a fetch redirect must not move
        // the iframe onto a real (location-leaking) URL.
        port.postMessage({
          type: "fetch-package-response",
          id,
          source,
          resolvedUrl: msg.url,
        });
      });
      return;
    }

    if (msg.type === "fetch-resource") {
      await handleFetchRpc(msg, "fetch-resource", port, mapper, async (response, _requestClass, id) => {
        const body = await response.arrayBuffer();
        const contentType =
          response.headers.get("content-type") || "application/octet-stream";
        // Transfer (not copy) the ArrayBuffer for efficiency.
        port.postMessage(
          { type: "fetch-resource-response", id, body, contentType },
          [body]
        );
      });
      return;
    }
  };

  port.addEventListener("message", onMessage);
  port.start();

  return () => {
    port.removeEventListener("message", onMessage);
  };
}
