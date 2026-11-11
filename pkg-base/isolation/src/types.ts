/**
 * Shared types for the isolation boundary.
 *
 * These describe the data that crosses between the trusted host and the
 * untrusted iframe (via postMessage), so they must stay in exact agreement on
 * both sides. They live here — rather than in either the host element or the
 * iframe bootstrap — so there is a single source of truth and the two ends
 * cannot drift apart.
 */

/**
 * A plugin registry entry, stripped of non-cloneable fields (functions, loaded
 * implementations) so it can be sent to the iframe via postMessage. `importUrl`
 * has been mapped to an opaque `registry--<name>` marker URL before transfer (see
 * PackagesUrlMapper), so the tool code's real location never crosses the boundary.
 * The index signature carries through any other serializable plugin metadata.
 */
export interface RegistryEntry {
  type: string;
  id: string;
  name: string;
  importUrl?: string;
  [key: string]: unknown;
}
