/**
 * The package a plugin came from, whatever version of it: an Automerge url, or
 * a service-worker url that carries one, without its heads. Any other url is
 * its own source.
 */
export function sourceOf(url: string | undefined): string | undefined {
  return url?.replace(/(automerge(?::|%3A)[^/?#%]+)(?:#|%23)[^/?]*/i, "$1");
}
