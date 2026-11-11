/**
 * Providers bridge — relays provider subscriptions from the iframe to
 * host-side providers across the isolation boundary.
 *
 * The iframe forwards ALL unclaimed `patchwork:subscribe` events to the
 * host via RPC. The host checks the subscription type against an allowlist
 * and either answers it (by dispatching a real `patchwork:subscribe` on
 * the host element) or rejects it.
 *
 * This bridge exists because DOM events don't cross iframe boundaries.
 * Provider subscriptions use `patchwork:subscribe` CustomEvents that bubble
 * up the DOM tree — inside the iframe, they can only reach local providers.
 * Subscriptions that no local provider answers (e.g. `patchwork:contact`)
 * are forwarded here so host-side providers (e.g. AccountProvider) can
 * respond.
 *
 * Security: the allowlist is managed on the host side. The iframe cannot
 * influence which subscription types are bridged.
 *
 * Protocol:
 *   iframe → host:  { type: "providers-bridge", id, selector }
 *   host → iframe:  { type: "providers-bridge-change", id, value }
 *   host → iframe:  { type: "providers-bridge-rejected", id }
 *   iframe → host:  { type: "providers-bridge-unsubscribe", id }
 */

import { isValidAutomergeUrl } from "@automerge/automerge-repo/slim";
import { log } from "../log.js";
import { resolveGatedAttribute } from "./gating.js";

/**
 * Provider subscription types that have been analyzed for security
 * implications and are safe to bridge across the isolation boundary.
 *
 * WARNING: Adding new types here requires independent security analysis.
 * Each bridged provider type is a channel through which information flows
 * from the trusted host context into the untrusted iframe. The value
 * filter checks for automerge URL leaks, but other sensitive data
 * (user identity, behavioral signals, etc.) may also be a concern.
 *
 * In the future we hope to have a different security design that will
 * allow us to loosen this requirement and give tool authors more freedom
 * over which providers are bridged.
 */
export const ALLOWED_PROVIDERS = [
  "patchwork:contact",
  "patchwork:selected-doc",
  // The active theme id (a plain string). Carries no automerge URLs or user
  // identity, so it is safe to relay into the iframe; lets isolated tools
  // (e.g. the titlebar theme tool) mirror the host's active theme.
  "patchwork:current-theme",
  // A worker connection. The worker runs on the host and only its
  // `{readable, writable}` pair is transferred in, so its config and secrets
  // stay out here. This allows every worker kind, but each subscription has its
  // own port, so a tool only gets the streams for the worker it asked for.
  "patchwork:worker-channel",
];

/**
 * The streams, ports and buffers at the top level of a relayed value, for
 * `postMessage`'s transfer list. A worker's stream pair can't be cloned, so
 * without this the relay throws DataCloneError. It doesn't recurse, so nothing
 * nested that the sender still holds gets detached.
 */
export function transferablesIn(value: unknown): Transferable[] {
  if (!value || typeof value !== "object") return [];
  const out: Transferable[] = [];
  for (const candidate of Object.values(value as Record<string, unknown>)) {
    if (
      candidate instanceof ReadableStream ||
      candidate instanceof WritableStream ||
      candidate instanceof MessagePort ||
      candidate instanceof ArrayBuffer
    ) {
      out.push(candidate as Transferable);
    }
  }
  return out;
}

/**
 * Resolve the set of provider types to bridge for one isolation instance: the
 * intersection of the element's `shared-providers` attribute (comma-separated,
 * host-set) and `ALLOWED_PROVIDERS`. Types requested but not in the hard
 * allowlist are dropped with a console warning — they need independent security
 * analysis before being added. No providers are bridged unless opted in.
 */
export function resolveBridgedProviders(element: HTMLElement): string[] {
  return resolveGatedAttribute(element, "shared-providers", ALLOWED_PROVIDERS);
}

interface ActiveSubscription {
  port: MessagePort;
  cleanup: () => void;
}

/**
 * Optional async filter applied to values before relaying them to the iframe.
 * Receives the subscription type and value; returns the (possibly modified)
 * value, or `undefined` to suppress the emission entirely.
 *
 * This can be used to check values against the allowlist and prompt the user
 * for access to URLs the iframe doesn't already know about.
 */
export type BridgeValueFilter = (
  selectorType: string,
  value: unknown
) => Promise<unknown | undefined> | unknown | undefined;

/**
 * Build a {@link BridgeValueFilter} that vets every automerge URL a bridged
 * value carries before it crosses to the iframe.
 *
 * Two per-URL checks, chosen by provider type:
 *  - `isAllowed(url)` — synchronous allowlist membership, no side effects.
 *  - `requestAccess(url)` — may re-scan, prompt the user, and grant access.
 *
 * `patchwork:selected-doc` uses `isAllowed` only: unknown URLs are silently
 * dropped, never prompted. Its semantic is "which of my allowlisted documents
 * is selected" — not "give me access to the selected document" — and prompting
 * on it would fire spuriously as the user navigates (the old iframe is about to
 * be torn down). Every other bridged type uses `requestAccess`.
 *
 * Handles the value shapes a provider can emit: a single automerge-URL string
 * (suppressed entirely if rejected), or an array (each automerge-URL element
 * kept only if allowed; non-URL elements passed through). Any other value is
 * relayed unchanged.
 */
export function makeBridgedValueFilter(checks: {
  isAllowed: (url: string) => boolean;
  requestAccess: (url: string) => Promise<boolean>;
}): BridgeValueFilter {
  return async (selectorType, value) => {
    const silent = selectorType === "patchwork:selected-doc";
    const checkUrl = (url: string): boolean | Promise<boolean> =>
      silent ? checks.isAllowed(url) : checks.requestAccess(url);

    // Single automerge URL value
    if (typeof value === "string" && isValidAutomergeUrl(value)) {
      return (await checkUrl(value)) ? value : undefined;
    }

    // Array of values (may contain automerge URLs)
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const item of value) {
        if (typeof item === "string" && isValidAutomergeUrl(item)) {
          if (await checkUrl(item)) result.push(item);
        } else {
          result.push(item);
        }
      }
      return result;
    }

    return value;
  };
}

/**
 * Start the host-side providers bridge.
 *
 * @param rpcPort - The RPC MessagePort shared with the iframe
 * @param hostElement - The host DOM element to dispatch subscriptions on
 *   (typically the `<patchwork-isolation>` element, whose ancestors include
 *   the providers that should answer bridged subscriptions)
 * @param allowedTypes - Subscription types to bridge for this instance.
 *   Should be the intersection of ALLOWED_PROVIDERS and the per-instance
 *   `shared-providers` attribute, computed by the caller.
 * @param valueFilter - Optional filter applied to values before relaying
 * @returns Cleanup function
 */
export function startHostProvidersBridge(
  rpcPort: MessagePort,
  hostElement: HTMLElement,
  allowedTypes: string[] = [],
  valueFilter?: BridgeValueFilter
): () => void {
  const allowed = new Set(allowedTypes);
  const active = new Map<number, ActiveSubscription>();

  const onMessage = (event: MessageEvent) => {
    const msg = event.data;
    if (!msg) return;

    if (msg.type === "providers-bridge") {
      const { id, selector } = msg as {
        id: number;
        selector: { type: string; [key: string]: unknown };
      };

      if (!allowed.has(selector.type)) {
        log(`providers-bridge rejected: ${selector.type}`);
        rpcPort.postMessage({ type: "providers-bridge-rejected", id });
        return;
      }

      log(`providers-bridge accepted: ${selector.type} (id=${id})`);

      // Create a MessageChannel for the host-side subscription
      const channel = new MessageChannel();
      const hostPort = channel.port2;

      // Listen for values from the host provider
      hostPort.addEventListener("message", async (e: MessageEvent) => {
        if (e.data?.type === "change") {
          const value = valueFilter
            ? await valueFilter(selector.type, e.data.value)
            : e.data.value;
          if (value === undefined) return;
          rpcPort.postMessage(
            {
              type: "providers-bridge-change",
              id,
              value,
            },
            transferablesIn(value)
          );
        }
      });
      hostPort.start();

      // Dispatch a real patchwork:subscribe event on the host element
      // so ancestor providers (e.g. AccountProvider) can answer it
      hostElement.dispatchEvent(
        new CustomEvent("patchwork:subscribe", {
          detail: { selector, port: channel.port1 },
          bubbles: true,
          composed: true,
        })
      );

      const cleanup = () => {
        hostPort.postMessage({ type: "unsubscribe" });
        hostPort.close();
        channel.port1.close();
      };

      active.set(id, { port: hostPort, cleanup });
      return;
    }

    if (msg.type === "providers-bridge-unsubscribe") {
      const { id } = msg as { id: number };
      const sub = active.get(id);
      if (sub) {
        log(`providers-bridge unsubscribe (id=${id})`);
        sub.cleanup();
        active.delete(id);
      }
      return;
    }
  };

  rpcPort.addEventListener("message", onMessage);

  return () => {
    rpcPort.removeEventListener("message", onMessage);
    for (const [, sub] of active) {
      sub.cleanup();
    }
    active.clear();
  };
}
