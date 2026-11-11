# @patchwork/llm

An LLM toolkit for Patchwork tools, extracted from `chat` and enriched with
`rlm`'s teaching telemetry. It gives you:

- **`popup()` / `dom()`** — a `<div popover>` model picker (Browser / OpenRouter
  / Ollama + sampling parameters, prompts, and tools). `popup()` is framed
  (header + Cancel/Done); `dom()` is the bare panel to embed. Writes the choice
  to the user's **account settings doc**, so the model + API key are shared
  across every tool and synced across devices.
- **A refresh-surviving `SharedWorker`** that runs all three providers off the
  main thread (cross-tab, survives reload — keyed by an optional `sessionKey`).
- **A streaming API** (`generate` callback-style, `stream` async-iterator-style)
  that carries **rich telemetry alongside the text** so you can build UIs that
  show *how the model thinks*:
  - **`prediction`** events — the model's top-k next-token distribution at each
    step (`[{token, p}]`). Works for **local** (via a transformers.js
    `logits_processor`) **and OpenRouter** (via `logprobs`/`top_logprobs`).
  - **`stats`** events — prompt/gen token counts, time-to-first-token,
    tokens/sec, and the exact decode settings used (`temperature`, `top_p`,
    greedy, …).

Plain vanilla JS, no build step. Its only npm dependency is
`@inkandswitch/patchwork-providers` (the request/provide config plumbing);
transformers.js — the model runtime — is imported from a CDN inside the worker,
only when the local provider is used.

## Install / consume

The package lives at `libraries/llm` and is named `@patchwork/llm`.

- **Bundled tools (vite):** add a resolve alias and the bundler inlines it,
  worker included (vite understands `new URL("./worker.js", import.meta.url)`):

  ```js
  // vite.config.js
  resolve: {
    alias: {
      "@patchwork/llm": fileURLToPath(new URL("../libraries/llm/index.js", import.meta.url)),
    },
  }
  ```

- **Bundleless tools:** import by relative path, or add `@patchwork/llm` to the
  host importmap to share one copy across tools.

## Usage

```js
import { popup, stream, generate, readConfig } from "@patchwork/llm"

// 1. Let the user choose a model / paste their OpenRouter key.
const el = popup()
document.body.append(el)
el.showPopover()
await el.result            // resolves to the config on close (null if cancelled)

// 2a. Stream with telemetry (async iterator):
let text = ""
for await (const ev of stream(messages, { topk: 5 })) {
  switch (ev.type) {
    case "status":     setStatus(ev.message); break        // model loading…
    case "token":      text += ev.delta; render(text); break
    case "prediction": renderCandidates(ev.step, ev.candidates); break
    case "stats":      renderStats(ev); break              // ttftMs, tokPerSec, decode…
    case "done":       finish(ev.text); break
  }
}

// 2b. …or callback style:
const { text, stats } = await generate(messages, {
  topk: 5,
  temperature: 0.7,
  onToken:      (delta, full) => render(full),
  onPrediction: (candidates, step) => renderCandidates(step, candidates),
  onStats:      (s) => renderStats(s),
  onStatus:     (m) => setStatus(m),
  signal,                       // AbortSignal
})
```

### Config (on the account doc)

Everything lives under `accountDoc.llm`:

```js
{
  provider: "local" | "openrouter" | "ollama",
  temperature: 0.7,
  local:      { model },
  openrouter: { apiKey, model, contextLength, maxCompletionTokens },
  ollama:     { url, model },
}
```

`readConfig()` / `writeConfig(patch)` read/write it (defaulting missing fields);
`popup()` / `dom()` are the UI over them.

### Resume after refresh

Pass a stable `sessionKey` (e.g. a doc URL) to `generate`/`stream`; after a
reload, `resume(sessionKey, { onToken, onDone })` re-attaches to the still-running
stream in the worker.

### Request preparation (`request.js`)

`generate()` is two halves: preparing the request and posting it to the worker.
The first half is exported so a host-side worker spec (one that serves this
library over a stream to sandboxed tools) prepares requests exactly the way
`generate()` does:

```js
import { prepareGenerate, buildGeneratePayload } from "@patchwork/llm"

const { cfg, config, extraSystem, builtin, input } = await prepareGenerate(cfg0, {
  messages,          // chat messages or a string
  system,            // extra system prompt, already provider-resolved
  tools,             // tool descriptors, already filtered
  continuation,      // treat a string as a raw continuation
  overrides,         // passed to callConfig verbatim
})
if (builtin) { /* run builtinGenerate(input, { system: effectiveSystem(cfg, extraSystem), … }) */ }
else worker.postMessage(buildGeneratePayload(config, input, { id, sessionKey }))
```

Resolving a provider-conditional `system` map, filtering tools by the user's
`toolToggles`, and choosing which `overrides` to forward are the caller's job:
`callConfig` honours provider / apiKey / model / url overrides, so a host serving
untrusted tools passes only sampling knobs.

## Events reference

| event        | fields                                                            | local | openrouter | ollama |
|--------------|------------------------------------------------------------------|:-----:|:----------:|:------:|
| `token`      | `delta`, `text`                                                  |  ✓    |     ✓      |   ✓    |
| `prediction` | `step`, `candidates: [{token, p}]`                               |  ✓    |     ✓      |   —    |
| `stats`      | `promptTokens`, `genTokens`, `ttftMs`, `totalMs`, `tokPerSec`, `decode` | ✓ | ✓ |  ✓*    |
| `status`     | `message` (model download / shader compile)                     |  ✓    |     —      |   —    |
| `done`       | `text`, `stats`                                                  |  ✓    |     ✓      |   ✓    |

\* Ollama stats come from its final `done` chunk (`eval_count`, `eval_duration`).
OpenRouter needs a model that supports `logprobs` for `prediction` events.
