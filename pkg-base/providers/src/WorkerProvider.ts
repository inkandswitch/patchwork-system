/**
 * The worker provider — the SERVING half of `patchwork:worker-channel`.
 *
 * Mounted in the host realm as a `patchwork:component`, it answers worker-channel
 * subscriptions by running the requested worker HERE and transferring its
 * `{readable, writable}` stream pair back to the consumer. Under isolation the
 * consumer is inside the sandbox and only the streams cross; the worker, and any
 * config or secrets it resolves, never leave the host.
 *
 * It is KIND-AGNOSTIC. Workers are resolved from the `patchwork:worker` plugin
 * registry by the selector's `kind`, so this file imports nothing
 * service-specific — no LLM, no config, no secrets. A package that owns a worker
 * registers it declaratively:
 *
 *   // in a Patchwork package's `plugins` array
 *   {type: "patchwork:worker", id: "llm", name: "LLM",
 *    async load() { return llmWorkerSpec }}
 *
 * and `load()` resolves to a `WorkerSpec` (see @grjte/patchwork-worker/serve.js):
 * `{createWorker, open?, handle, abort?}`. The provider hands the spec to
 * `serveWorkerSpec`, which owns the streams, the worker lifetime, and the id
 * demux; the spec owns only the service's op vocabulary.
 *
 * Package placement: this lives in the host-only `providers` package and imports
 * the transport's serve half from `@grjte/patchwork-worker/serve.js`. The
 * consumer half (`connect.js`, the only file a sandboxed tool loads) never
 * imports this module, so the plugin registry stays out of the sandbox.
 *
 * Three invariants make this reliable rather than racy:
 *
 *   1. DECLINE SYNCHRONOUSLY, CLAIM SYNCHRONOUSLY. `registry.has(kind)` is sync,
 *      so a kind we cannot serve is left to bubble (another provider may answer)
 *      by returning BEFORE `accept()`. `accept()` itself claims with
 *      `stopPropagation()` before running the producer, so a kind we can serve is
 *      claimed before any await — otherwise the event finishes bubbling while we
 *      wait and an ancestor double-answers.
 *   2. ALWAYS SETTLE A CLAIMED REQUEST. Once claimed, the consumer is waiting on
 *      this subscription, so every path must reply — the stream pair on success,
 *      an explicit `null` on failure. Staying silent turns a bad config or a
 *      throwing worker into a hang.
 *   3. LISTEN AT THE DOCUMENT, NOT THE MOUNT ELEMENT. `patchwork:subscribe`
 *      bubbles and is `composed`, so a document-level listener catches every
 *      request regardless of where this provider sits relative to the consumer.
 *      Listening on the mount element instead would make correctness depend on
 *      this component having mounted before any consumer dispatches — and
 *      `patchwork-view` mounting is async twice over (a deferred render, then an
 *      async registry load), so a host would have to gate its whole subtree on
 *      this provider being ready. That gate is a bad trade: `patchwork-view`
 *      emits no event when a component fails to load, so a failed load would
 *      leave the gated subtree blank forever. Listening at the document keeps
 *      this an optional capability that degrades to "no worker available"
 *      instead of taking the frame down with it. (The sibling providers in this
 *      package listen on their mount element; this one deliberately differs.)
 */

import { getRegistry, type PluginDescription, type PluginRegistry } from "@inkandswitch/patchwork-plugins";
import { accept, type SubscribeEvent } from "@inkandswitch/patchwork-providers";
import { CHANNEL_SELECTOR, WORKER_PLUGIN_TYPE } from "@grjte/patchwork-worker/connect.js";
import { serveWorkerSpec, type WorkerSpec } from "@grjte/patchwork-worker/serve.js";

/**
 * How long to wait for a registered worker plugin to LOAD before refusing.
 *
 * `has(kind)` proves the plugin is registered, not that its module can be
 * fetched — an unreachable package or a `load()` that never settles would
 * otherwise leave a claimed port unanswered forever, which is exactly the hang
 * invariant 2 exists to prevent.
 */
const LOAD_TIMEOUT_MS = 10000;

/** The value a worker-channel subscription settles with: the pair, or a refusal. */
type WorkerChannelValue = { readable: ReadableStream; writable: WritableStream } | null;

/** The selector a consumer dispatches (see connect.js `CHANNEL_SELECTOR`). */
type WorkerChannelSelector = { type: string; kind?: string };

/**
 * Mount the worker provider on `element`. Returns a cleanup function
 * (the `patchwork:component` render contract).
 *
 * `element` is never read for `repo` or attributes; it is only the host-realm
 * context handed to a spec's `open(ctx)`, so a worker can resolve things that
 * need a mounted view (a settings doc, say). Hence `HTMLElement`, not
 * `PatchworkViewElement`.
 */
export const WorkerProvider = (element: HTMLElement): (() => void) => {
  const workers: PluginRegistry<PluginDescription, WorkerSpec> = getRegistry(WORKER_PLUGIN_TYPE);

  const onSubscribe = (event: Event) => {
    const detail = (event as SubscribeEvent).detail;
    const selector = detail?.selector as WorkerChannelSelector | undefined;
    if (!selector || selector.type !== CHANNEL_SELECTOR) return;
    if (!detail.port) return;

    const kind = selector.kind;

    // Decline what we cannot serve, SYNCHRONOUSLY and without claiming, so the
    // event keeps bubbling and something else may answer. Must come BEFORE
    // `accept()`, which claims via stopPropagation() the moment it is called.
    if (!kind || !workers.has(kind)) return;

    // `accept()` claims the event and owns the port from here: its lifetime,
    // its teardown, and the `{type:"change", value}` envelope. We only choose
    // the value.
    accept<WorkerChannelValue>(event as SubscribeEvent, (respond) => {
      void serve(kind, respond);
    });
  };

  /**
   * Run the worker for `kind` and hand its streams back. Always settles: the
   * stream pair on success, `null` on any failure — a claimed subscription that
   * stays silent hangs the consumer forever.
   */
  async function serve(
    kind: string,
    respond: (value: WorkerChannelValue, transfer?: Transferable[]) => void
  ) {
    try {
      // `loadWhenReady` (not `load`) waits for the `registered` event, so a
      // worker registered-but-not-yet-loaded still resolves instead of being
      // reported missing. Bounded: a claimed subscription must always settle,
      // and `accept()` does not bound the producer for us.
      const plugin = await Promise.race([
        workers.loadWhenReady(kind),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`timed out loading worker plugin "${kind}"`)),
            LOAD_TIMEOUT_MS
          )
        ),
      ]);
      const spec = plugin?.module as WorkerSpec | undefined;
      if (!spec || typeof spec.handle !== "function" || typeof spec.createWorker !== "function") {
        throw new Error(`worker plugin "${kind}" did not resolve to a WorkerSpec`);
      }

      // The element is what lets a worker resolve host-realm context it needs
      // (e.g. a settings doc via the patchwork:tool-storage provider) without
      // this provider knowing anything about that service. serveWorkerSpec owns
      // the streams, the per-connection worker, and the id demux; the spec owns
      // the service vocabulary.
      const streams = serveWorkerSpec(spec, { element });

      // The streams ride IN the value; naming them in the transfer list only
      // upgrades the structured clone to a move. Both are required — a
      // transferable named in the list but absent from the value is detached
      // here and never arrives there.
      respond({ readable: streams.readable, writable: streams.writable }, [
        streams.readable,
        streams.writable,
      ]);
    } catch (err) {
      // The reason no longer rides the wire (the envelope is `accept()`'s), so
      // log it here — this is the only place it was ever surfaced anyway.
      console.error(`[worker-provider] failed to serve "${kind}":`, err);
      respond(null);
    }
  }

  // Document-level: see invariant 3. `element` is still used as the host-realm
  // context handed to `open(ctx)`, so a worker can resolve things that need a
  // mounted view (a settings doc, say) — the provider's POSITION matters for
  // that, but not for whether it hears the request.
  document.addEventListener("patchwork:subscribe", onSubscribe);
  return () => {
    document.removeEventListener("patchwork:subscribe", onSubscribe);
  };
};
