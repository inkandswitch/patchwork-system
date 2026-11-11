# @grjte/patchwork-worker

Run a worker in the host realm and hand any consumer a transferable stream pair,
so a plugin that needs a worker is written once and works the same whether or not
it runs behind an isolation boundary.

```js
// consumer — the same code in any realm
import { connectWorkerClient } from "@grjte/patchwork-worker/client";
const search = await connectWorkerClient("search-index");
const hits = await search.query("patchwork", { element });
```

```js
// a package that owns a worker — declarative, nothing imported until first use
export const plugins = [
  {
    type: "patchwork:worker", // serve half: how to run the worker
    id: "search-index",
    name: "Search Index",
    async load() {
      return makeWorkerSpec(); // -> WorkerSpec {createWorker, open?, handle, abort?}
    },
  },
  {
    type: "patchwork:worker-client", // consume half: the typed client
    id: "search-index",
    name: "Search Index client",
    async load() {
      return makeSearchClient; // -> (session) => {query, ...}
    },
  },
];
```

The package is service-agnostic: it knows how to run _a_ worker in the host and
stream to _a_ consumer, and nothing about what any particular worker computes. A
concrete service (an LLM, a transcription engine, a search indexer) plugs in
through the **plugin registry**: it registers a plugin of type `patchwork:worker`
whose `id` names the worker `kind` and whose `load()` resolves to a **WorkerSpec**,
and usually a paired `patchwork:worker-client` plugin with the same `id`. That
registration is the whole coupling. The host provider (the
`patchwork-worker-provider` component, shipped by the `providers` package)
discovers workers by looking them up in the `patchwork:worker` registry by `kind`,
so a consumer that connects to `"search-index"` reaches whatever package
registered under that id. Nothing is imported until a consumer actually connects.

This package is a plain library: it registers no plugins and is consumed as a
dependency, never installed as a module.

Concrete service integrations, including the LLM architecture, are outside this library and are documented by their owning packages.

## Why this exists

A Web Worker normally runs in the realm of the code that constructed it. When a
plugin runs in a sandboxed realm, that realm may lack things a worker needs: a
warm cache, a GPU device the host already set up, or host-only state such as a
settings document or a credential that must never enter the sandbox.

So instead of constructing the worker in the consumer's realm, this package runs
it in the **host realm** and transfers only its `{readable, writable}` stream pair
to the consumer. The worker, and anything host-only it resolves, never leaves the
host; only structured-cloneable frames cross. Because the consumer's code is just
"open a connection, write request frames, read event frames," it is **identical
in and out of isolation**. The only difference is who answers the connection
request and whether the streams are handed over within one realm or transferred
across a boundary. How a given isolation mechanism relays the request and
transfers the streams is that mechanism's concern, not this package's.

## The three roles

```
  worker owner (host realm)                     consumer (any realm)
  -------------------------                     --------------------
  {type:"patchwork:worker",                     const {readable, writable, disconnect}
   id:"kind", load: () => spec}                   = await connectWorker("kind", {element})
    spec = {createWorker, open?, handle, abort?}
      → serveWorkerSpec(spec, {element})
         -> {readable, writable}

                     writable  <--- request frames {id, op, ...} ----   (consumer writes)
                     readable  ---- event frames {id, type, ...} --->   (consumer reads)
```

- **The consumer** calls `connectWorker(kind, {element})`, or the higher-level
  `openSession(kind)` for request/response multiplexing, or (usually)
  `connectWorkerClient(kind)` for the service's typed client, and gets a stream
  pair. This is the only part that runs in the consumer's realm; it loads
  `connect.js` and `client.js`, never `serve.js`.
- **The provider** (`patchwork-worker-provider`, a `patchwork:component` shipped
  by the sibling `providers` package and mounted by the host frame) answers the
  connection request: it looks up `kind` in the `patchwork:worker` plugin
  registry, loads its `WorkerSpec`, and hands that to `serveWorkerSpec`, which it
  imports from `@grjte/patchwork-worker/serve`.
- **`serveWorkerSpec`** owns everything kind-agnostic: the stream pair and its
  controller lifecycle, **one dedicated worker per connection** (terminated on
  teardown; no sharing, no reuse), request-id demux, the reserved `op:"abort"`,
  and a bounded `open` warm-up. The spec supplies only the service's op vocabulary.

### The paired client plugin

A service package usually also owns the *consume* half of its protocol: the code
that turns a method call into request frames and reads the events back. Rather
than have every consumer import that code from the service package (a build-time
dependency on a registry package, which the repo rules forbid), the package
registers it as a second plugin with the **same id** as its worker, whose `load()`
resolves to a factory `(session) => clientApi`.

A consumer then calls, from `@grjte/patchwork-worker/client`:

```js
const api = await connectWorkerClient("kind", { sessionOpts: { idPrefix: "mytool" } });
```

`connectWorkerClient` resolves the `patchwork:worker-client` plugin for the kind
from the registry (bounded wait, so a missing service rejects instead of hanging),
opens a session for the same kind, and returns `factory(session)`. Both halves of
the protocol ship in one package and cannot drift; the consumer's only tie to the
service is the kind string. The lookup is an ordinary registry lookup, so it works
in whatever realm the consumer runs in, provided that realm has a plugin registry
that knows about the service.

## The WorkerSpec contract

A service implements this; `serveWorkerSpec` drives it.

```
  createWorker()          construct the compute Worker. Typically stays in the
                          service's own library, because
                          new URL("./worker.js", import.meta.url) must resolve
                          against that module's URL. Called at most once per
                          connection, lazily, on the first frame that needs it.

  open(ctx)?              per-connection warm-up (e.g. resolving host-side config).
                          ctx = {element} — the provider's mount point, so the
                          worker can reach host-realm context without the transport
                          knowing about it. BOUNDED by the transport (a 5s race):
                          a never-settling open can't wedge frames forever, so the
                          spec must make falling-through safe. Its resolved value
                          reaches handle as `io.state`.

  handle(frame, io)       turn ONE consumer request frame into worker traffic.
                          Everything service-specific lives here. May return an
                          opaque abort token, stored per request.
                          io = {post, emit, on, workerId, state, ctx}
                            post(msg, transfer?)  send to the worker
                            emit(frame)           enqueue a frame onto the consumer's
                                                  readable (auto-tagged with the
                                                  caller id)
                            on(fn)                handle worker messages for this
                                                  request; return truthy from fn when
                                                  the request is complete. A handle
                                                  that never calls on() is
                                                  fire-and-forget: nothing is tracked
                                                  for it and it cannot be aborted.
                            workerId              the id to tag worker payloads with
                            state                 whatever open() resolved (or null)

  abort(token, post)?     cancel one in-flight request — the spec sends whatever
                          worker-specific payload stops it. Reached via the reserved
                          transport op {id, op:"abort"}, which session.js sends.
```

`serveWorkerSpec` owns the id lifecycle so an `op:"abort"` that races in while a
request is still being set up is honoured once its token lands, rather than being
dropped.

## Frames

Frames are **opaque to this package**: any structured-cloneable object. The
transport only reads `frame.id` (to demux) and `frame.op === "abort"` (the one
reserved op). Everything else is the service's own vocabulary. A connection is
multiplexed by `id`, so one stream pair can carry many overlapping requests:

```
  request  (consumer -> worker):  {id, op, ...service-specific...}
  events   (worker -> consumer):  {id, type, ...service-specific...}
                                  a service marks its own terminal frame types;
                                  abort is {id, op:"abort"} (reserved)
```

## Discovery and handoff go through patchwork-providers

The worker channel is an ordinary `patchwork:subscribe` whose `kind` is the `id` of
a registered `patchwork:worker` plugin. The consumer calls `subscribe()`; the
provider answers with `accept()`; the stream pair rides back in the value with the
streams named in the transfer list (**moved, not cloned**, since a `ReadableStream`
can't be structured-cloned). It is the same relay as any other provider: a worker
connection is just a subscription whose value happens to carry transferred streams.

```
  consumer                                                    answering side
  --------                                                    --------------
  subscribe(el, {type:"patchwork:worker-channel",  ────────►  (mounted provider element
                 kind})                                        answers via accept())
                                                              serveWorkerSpec(spec) -> streams
  listener({readable, writable})                  ◄─────────  respond({readable,writable},
    (streams TRANSFERRED, not cloned)                           [readable,writable])  // TRANSFER
```

Because it is an ordinary provider subscription and the streams are transferable,
a consumer's code is the same whether the provider that answers is in its own
realm or on the far side of an isolation boundary. The transport doesn't know or
care which. An isolation mechanism that wants to support workers needs to do two
things: relay this subscription to a realm where the provider is mounted, and
transfer the answered stream pair back. Everything else is unchanged.

If nothing answers, `connectWorker` **rejects**: either a provider claimed the
subscription and answered a `null` value (an explicit refusal, immediate), or the
bounded discovery wait expired unclaimed. There is deliberately **no local-worker
fallback**: if a consumer could construct its own worker when discovery failed, a
consumer that imports a service package would register that package's worker as
an import side-effect and silently serve itself, defeating the point of running
the worker in the host. A consumer treats the rejection as "worker unavailable"
and degrades.

## Sessions, broadcasts, and failure

`openSession(kind)` opens the connection lazily on the first `request()`, shares
it across requests, and drops it whenever it fails or ends so the next request
reconnects. `session.close()` drops it on purpose: the serve half sees its
streams end and terminates the dedicated worker.

Frames the worker posts **without an `id`** (progress, a status line, its own
error events) are connection-wide broadcasts. The serve half puts them on the
readable once; the session delivers each to every in-flight request's `onFrame`,
so a caller sees the worker's status exactly as it would from a same-realm worker.

A request never hangs on a dead worker: if the connection ends, the worker
crashes, or the worker cannot be constructed, the serve half tears down, the
readable closes, and every in-flight request rejects. Aborting a request
(`abort()` or an `AbortSignal`) sends the reserved `op:"abort"` frame so the
service can cancel the matching worker work.

## Files

- `connect.js` — the consumer transport: `connectWorker` (discovery + handoff),
  `openSession` (request/response multiplexing over the pair), and the protocol
  constants (`CHANNEL_SELECTOR`, `WORKER_PLUGIN_TYPE`, `WORKER_CLIENT_PLUGIN_TYPE`).
- `session.js` — `openSession` internals: id tagging, demux, broadcast fan-out,
  abort, reconnect, `close()`.
- `serve.js` — `serveWorkerSpec`: streams, per-connection worker, id demux, abort.
  The serve half, imported by the host provider as
  `@grjte/patchwork-worker/serve`.
- `client.js` — `connectWorkerClient`: resolves the paired
  `patchwork:worker-client` plugin from the registry and binds its factory to
  `openSession(kind)`. The one file here that touches the plugin registry.
- `index.js` — barrel over connect.js and client.js. No `plugins` array: this
  package is a library, not a module.

Layering, by convention rather than test: `connect.js`/`session.js` stay free of
the plugin registry; `client.js` never imports `serve.js`; `serve.js` is
host-only and imports nothing from the consumer side.

## ⚠ Nothing in this package may hold host-only state or secrets

The consumer half (`connect.js`, `client.js`) is loaded into whatever realm the
consumer runs in, including a sandboxed one, and a consumer that can load one
file of a package should be assumed able to load any of them. So nothing here may
hold state or secrets that a sandboxed consumer must not see. Any host-only state
or credential a worker needs lives in that worker's own service package, resolved
by its `WorkerSpec` in the host realm, and the host-realm provider that runs
workers lives in the `providers` package. This package holds no state and imports
nothing service-specific. `client.js` touches only the plugin registry
(descriptors and lazy loaders); the factory it returns is the *service package's*
code, fetched by the same loader that fetches any plugin.
