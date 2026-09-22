import {
  type AutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo/slim";

// The origin to resolve service-worker module URLs against. `location.origin`
// is the string "null" inside a srcdoc/sandboxed frame — an invalid URL base —
// whereas `document.baseURI` is the document's proper base URL (the embedder's
// URL for a srcdoc frame, and the page URL for a normal document), so its origin
// is valid in both cases. Reached via `globalThis` so this also works inside a
// worker (where `document`/`window` are undefined but `self.location` is the
// site origin the service worker serves module URLs from).
export function documentBaseOrigin(): string {
  try {
    return new URL(globalThis.document.baseURI).origin;
  } catch {
    return globalThis.location.origin;
  }
}

export function getImportableUrlFromAutomergeUrl(
  automergeUrl: AutomergeUrl,
  subpath?: string
): string {
  const base = `${documentBaseOrigin()}/${encodeURIComponent(automergeUrl)}/`;
  if (!subpath || subpath === ".") return base;
  const clean = subpath.replace(/^\.\//, "");
  return `${base}${clean}`;
}

/**
 * Build a service-worker-resolvable URL from a DocHandle, pinning to the
 * handle's latest heads by default. This ensures the caching system can
 * key on an exact version of the folder document.
 */
export function getImportableUrlFromDocHandle(
  handle: DocHandle<any>,
  subpath?: string
): string {
  const url = handle.view(handle.heads()).url;
  return getImportableUrlFromAutomergeUrl(url, subpath);
}

/** @deprecated Use {@link getImportableUrlFromAutomergeUrl} instead */
export function automergeUrlToServiceWorkerUrl(
  automergeUrl: AutomergeUrl,
  subpath?: string
): string {
  return getImportableUrlFromAutomergeUrl(automergeUrl, subpath);
}

/** @deprecated Use {@link getImportableUrlFromDocHandle} instead */
export function docHandleToServiceWorkerUrl(
  handle: DocHandle<any>,
  subpath?: string
): string {
  return getImportableUrlFromDocHandle(handle, subpath);
}
