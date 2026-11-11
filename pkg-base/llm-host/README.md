# @grjte/llm-host

The Patchwork side of [`@chee/patchwork-llm`](../libraries/llm): everything that
has to run in the host realm because it touches the LLM settings doc, which holds
the API key. A consumer tool like chat only holds a stream pair, and runs the
same code whether or not it's inside an isolation sandbox.

The transport underneath (`connectWorker`, `serveWorkerSpec`, discovery, the
stream handoff) is generic and documented in
[`@grjte/patchwork-worker`](../libraries/patchwork-worker/README.md). This
package adds the LLM protocol on top of it, and the config tray.

## Plugins

| id                | type                      | what                                                     |
| ----------------- | ------------------------- | -------------------------------------------------------- |
| `llm-config-tray` | `patchwork:component`     | system-tray icon + popover for the model/config picker   |
| `llm`             | `patchwork:worker`        | the serve half: `makeLLMWorkerSpec` (`src/worker-spec.js`) |
| `llm`             | `patchwork:worker-client` | the consume half: `makeLLMClient` (`src/client.js`)      |

All three are behind `load()`, so importing the package registers descriptors and
nothing else. Both protocol halves ship together, so they can't drift.

## Using it from a tool

A tool never imports this package. It asks the registry for the client:

```js
import {connectWorkerClient} from "@grjte/patchwork-worker/client.js"

const llm = await connectWorkerClient("llm", {sessionOpts: {element}})

const {text, toolCalls} = await llm.generate(messages, {
	scope: {toolId: "my-tool", docId: handle.url},
	system: "…", // or {default, local, openrouter, …}
	tools: [{name, description, parameters, defaultOff}],
	onToken: (delta, full) => {},
	signal,
})
```

`scope` is all a tool says about config. The host resolves the provider, model,
prompts and toggles for that scope from the settings doc.

To change config, a tool dispatches
`new CustomEvent("patchwork:open-tool", {detail: {component: "llm-config-tray", scope, toolPrompt, toolTools}, bubbles: true, composed: true})`.
The tray opens the picker for that scope, listing `toolTools` with their toggles
(`defaultOff` ones start unchecked). From inside a sandbox the isolation
open-tool bridge relays the event to the host.

### Tools

`generate` returns `toolCalls` (or `null`) for every provider. Calls are either
structured, from native function calling (OpenRouter, Ollama, WebLLM), or parsed
on the host from `<tool_call>` text (local, Chrome built-in). Only calls to
offered tools are returned, so JSON in a normal answer isn't mistaken for a call.
Names are the ones you declared, even when a provider needed them sanitized.
`toolMode` (`"native"`, `"template"` or `"text"`) says how results should be fed
back.

Before offering tools, the host drops the ones the user toggled off in the picker
and keeps `defaultOff` ones out until toggled on. If a model rejects native tools,
it retries once with the tools described in the system prompt, and remembers that
for the model.

`generateWithTools` runs the whole loop: generate, run each call, thread the
results back in the right shape, and repeat until the model stops calling tools
or `maxRounds` (6) runs out.

```js
const {text, messages} = await llm.generateWithTools(messages, {
	scope,
	tools: [{name: "add", description, parameters, handler: ({a, b}) => a + b}],
	onToolCall: ({name, args, result, error}) => {},
})
```

Handlers run in the tool's own realm; only descriptors cross to the host.

The user's own tools (the `llm:tool` docs added in the picker) are offered too.
Only the host can read them, so their calls come back tagged `host: true` and run
on the host via `op:"run-tool"`, always in a sandboxed Worker. A tool running its
own loop over `generate` can opt in with `userTools: true` and run those calls
with `llm.runTool(call, {scope})`.

## Protocol

The transport only reads `id` and the reserved `op:"abort"`. Everything else is
defined here, in `src/worker-spec.js` and `src/client.js`, which must stay in step:

```
generate   {op, scope, system, tools, userTools, messages|text, sessionKey, temperature, topP, topk, maxNewTokens}
           -> model, token, status, stats, prediction ... result {text, toolCalls, toolMode} | error
run-tool   {op, scope, name, args} -> tool-result {result} | error
predict, score-tokens, compute-importance, compute-attention-weights,
extract-features, extract-cut-features, decode-tokens, probe-attention, preload
```

## Trust boundary

- Config comes from the frame's `scope` only. A `frame.config` is ignored, and
  only sampling knobs are passed through as overrides. `callConfig` also honours
  provider, apiKey, model and url, so passing more would let a tool point
  generation at its own endpoint with its own key.
- The API key is applied host-side in `callConfig` and never appears in any frame.
- The settings doc is denylisted from the sandbox, so the tray and the worker spec
  only run on the host.
- `src/client.js` imports nothing. It's the only code of this package a
  sandboxed tool loads; `@chee/patchwork-llm` and `worker-spec.js` stay host-side.
- The user's own tools always run sandboxed when a consumer asks for them, so a
  sandboxed tool can't get page access through them.

Under isolation the host answers the worker subscription and the stream pair is
transferred across the boundary. That needs `patchwork:worker-channel` in the
isolation element's `shared-providers`, and opening the picker needs
`llm-config-tray` in `shared-tools`. See ISOLATION.md for the bridges.

## Build

```sh
pnpm build   # vite; rewrites the automerge: @chee/patchwork-llm dep to a cross-origin URL
pnpm test
pnpm push    # build + pushwork sync
```
