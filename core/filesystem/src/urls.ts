import {
  type AutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo/slim";

// The origin service-worker module URLs resolve against. `location.origin` is
// "null" in a srcdoc or sandboxed frame, an invalid base, but
// `document.baseURI`'s origin is valid there too (the embedder's). In a worker
// there's no `document`, so it's `location`: the origin the service worker
// serves module URLs from.
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
 * A service-worker URL for a DocHandle, pinned to its latest heads by default,
 * so caches key on an exact version of the folder doc.
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
