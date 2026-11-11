/**
 * Main-thread client for the @patchwork/llm worker.
 *
 * Connects to a dedicated Worker (one per page), routes
 * messages back to the right in-flight generation, and exposes two call styles:
 *
 *   const { text, stats } = await generate(messages, { onToken, onPrediction, onStats })
 *   for await (const ev of stream(messages, { topk: 5 })) { ... }
 *
 * Provider / model / key / temperature come from the account-doc config
 * (see config.js) unless overridden via opts.
 */

import {readConfig, ensureConfig, callConfig, applyPrompts, effectiveSystem} from "./config.js"
import {builtinGenerate} from "./builtin.js"
import {resolveTools, buildToolsSystem, parseToolCalls, runTool, resolveCfgPrompts, sanitizeToolName} from "./tools.js"
import {prepareGenerate, buildGeneratePayload, NATIVE_TOOL_PROVIDERS, TEMPLATE_TOOL_PROVIDERS} from "./request.js"
import {CrossOriginWorker as Worker} from "./cross-origin-worker.js"

/**
 * Per-call options. A superset of every option any exported function accepts;
 * individual functions document the subset they use. Open-ended on purpose.
 * @typedef {Object} GenOpts
 * @property {import("./config.js").LLMConfig} [config]
 * @property {import("./config.js").Scope} [scope]
 * @property {boolean} [continuation]
 * @property {number} [topk]
 * @property {number} [temperature]
 * @property {string} [model]
 * @property {string} [provider]
 * @property {number} [maxNewTokens]
 * @property {string} [sessionKey]
 * @property {string} [system]
 * @property {any[]} [tools]
 * @property {boolean} [sandbox]
 * @property {number} [maxRounds]
 * @property {AbortSignal} [signal]
 * @property {(delta:string, full:string, round?:number)=>void} [onToken]
 * @property {(candidates:{token:string,p:number}[], step:number)=>void} [onPrediction]
 * @property {(stats:any)=>void} [onStats]
 * @property {(message:string)=>void} [onStatus]
 * @property {(info:{name?:string,tool?:string,args?:any,result?:any,error?:any})=>void} [onToolCall]
 */

/**
 * A message coming back from the worker (or built locally). Open-ended:
 * the discriminant is `type` and the rest depends on it. Routing fields are
 * typed non-optional because the dispatch guards (`msg.id != null`, etc.)
 * already ensure they're present before use.
 * @typedef {Object} WorkerMsg
 * @property {string} type
 * @property {string} id
 * @property {string|number} sessionKey
 * @property {string} text
 * @property {string} delta
 * @property {string} message
 * @property {any[]} args
 * @property {any} candidates
 * @property {number} step
 * @property {any} scores
 * @property {any} spans
 * @property {any} decoded
 * @property {number} total
 * @property {any} strings
 * @property {any[]|null} toolCalls
 * @property {string} [toolMode]
 */

/** @typedef {{post: (m:any)=>void}} Connection */

/** @typedef {import("./request.js").CallConfigExt} CallConfigExt */

/** @type {Connection|null} */
let connection = null
let idSeq = 0
/** @type {Map<string, (msg:WorkerMsg)=>void>} */
const handlers = new Map() // generation id -> (msg) => void
/** @type {Map<string|number, {onToken?:(t?:string)=>void, onDone?:(t?:string)=>void, onError?:(m?:string)=>void, onNone?:()=>void}>} */
const resumeHandlers = new Map() // sessionKey -> { onToken, onDone, onError, onNone }
/** @type {Set<(message:string)=>void>} */
const statusListeners = new Set() // (message) => void

function nextId() {
	return "llm-" + ++idSeq + "-" + (performance.now() | 0)
}

// Main-thread diagnostics. The worker forwards its own logs via {type:"log"}
// (see dispatch); this is for client-side events — aborts and worker errors —
// so a caller (e.g. loom) that only surfaces a generic AbortError still leaves a
// trail in the console explaining what actually happened.
/** @param {...any} args */
function clog(...args) {
	try {
		console.log("[llm]", ...args)
	} catch {}
}

/** @param {WorkerMsg} msg */
function dispatch(msg) {
	if (!msg) return
	// Worker diagnostics: the Worker's own console is separate, so re-print its
	// logs here on the main thread where the tool's devtools can see them.
	if (msg.type === "log") {
		try {
			// Stringify object args inline so the console shows the actual values
			// (a bare object logs as a collapsed "Object" and hides what we need).
			console.log(
				"[llm worker]",
				...(msg.args || []).map((a) =>
					a && typeof a === "object" ? JSON.stringify(a) : a
				)
			)
		} catch {}
		return
	}
	if (msg.type === "status") {
		for (const f of statusListeners) f(msg.message)
		return
	}
	// Resume replies are keyed by sessionKey (the reconnecting tab never knew the
	// original generation id) and tell us the live id to adopt for what follows.
	if (
		msg.type === "resumed" ||
		msg.type === "resume-result" ||
		msg.type === "no-active-generation"
	) {
		const rh = msg.sessionKey != null && resumeHandlers.get(msg.sessionKey)
		if (!rh) return
		if (msg.type === "no-active-generation") {
			resumeHandlers.delete(msg.sessionKey)
			rh.onNone?.()
		} else if (msg.type === "resume-result") {
			resumeHandlers.delete(msg.sessionKey)
			rh.onToken?.(msg.text)
			rh.onDone?.(msg.text)
		} else {
			rh.onToken?.(msg.text)
			handlers.set(msg.id, (/** @type {WorkerMsg} */ m) => {
				if (m.type === "token") rh.onToken?.(m.text)
				else if (m.type === "result") {
					handlers.delete(msg.id)
					resumeHandlers.delete(msg.sessionKey)
					rh.onDone?.(m.text)
				} else if (m.type === "error") {
					handlers.delete(msg.id)
					resumeHandlers.delete(msg.sessionKey)
					rh.onError?.(m.message)
				}
			})
		}
		return
	}
	const h = msg.id != null && handlers.get(msg.id)
	if (h) h(msg)
}

function getConnection() {
	if (connection) return connection
	// A dedicated Worker (one per page), NOT a SharedWorker. A SharedWorker is a
	// single instance shared across every tab/tool on the origin — which serialises
	// all generation through one model and keeps running stale code until every
	// page closes. A per-page Worker reloads with the page, is isolated, and dies
	// with it; a page that wants many models running at once gets its own worker
	// rather than fighting over one. `resume()` therefore always reports
	// no-active-generation.
	// `new URL("./worker.js", import.meta.url)` must stay inline inside the
	// constructor — that's the exact pattern bundlers (vite) statically detect to
	// emit the worker chunk; hoisting it to a variable silently breaks bundling.
	// `Worker` here is CrossOriginWorker.
	const w = new Worker(new URL("./worker.js", import.meta.url), {type: "module"})
	w.onmessage = (/** @type {MessageEvent} */ ev) => dispatch(ev.data)
	connection = {post: (m) => w.postMessage(m)}
	return connection
}

/**
 * Generate. Resolves to `{ text, stats }`.
 *
 * Two intents:
 *   - CHAT (default): pass chat messages, or a string (wrapped as a user turn).
 *     The instruct/chat model responds; the system prompt applies.
 *   - CONTINUATION: pass a string with `{ continuation: true }` to *continue* the
 *     text rather than answer it. local/webllm/ollama feed it raw; chat-only
 *     OpenRouter is framed with a "continue, output only the continuation"
 *     instruction. (This is what Loom uses; everyone else gets plain chat.)
 *
 * @param {Array<any>|string} messages  chat messages, or a string
 * @param {GenOpts} [opts]
 * @returns {Promise<{text:string, toolCalls:object[]|null, toolMode?:string, stats:object|null}>}
 */
export async function generate(messages, opts = {}) {
	const cfg0 = opts.config ?? (await ensureConfig(opts.scope))
	// Prompt resolution, CallConfig, the tools decision, the builtin detour and
	// the chat-vs-continuation input shape all live in request.js, shared with
	// host-side worker specs. The whole opts is passed as overrides: a same-realm
	// caller legitimately owns provider/model/apiKey overrides.
	const {cfg, config, extraSystem, builtin, input} = await prepareGenerate(cfg0, {
		messages,
		system: opts.system,
		tools: opts.tools,
		continuation: opts.continuation,
		overrides: opts,
	})

	// Built-in (Chrome Prompt API) runs on the main thread, not the worker.
	if (builtin) {
		return builtinGenerate(input, {
			temperature: config.temperature,
			topK: config.topK,
			system: effectiveSystem(/** @type {any} */ (cfg), extraSystem),
			onToken: opts.onToken,
			onStatus: opts.onStatus,
			signal: opts.signal,
		}).then((t) => ({text: t, toolCalls: null, stats: null}))
	}

	const conn = getConnection()
	const id = nextId()
	const sessionKey = opts.sessionKey || id
	/** @type {any} */
	let stats = null

	return new Promise((resolve, reject) => {
		const onStatus = opts.onStatus
		if (onStatus) statusListeners.add(onStatus)
		const cleanup = () => {
			handlers.delete(id)
			if (onStatus) statusListeners.delete(onStatus)
			if (opts.signal) opts.signal.removeEventListener("abort", onAbort)
		}
		function onAbort() {
			clog("generate: aborted by caller", {provider: config.provider, model: config.model})
			conn.post({type: "abort", sessionKey})
			cleanup()
			reject(new DOMException("Aborted", "AbortError"))
		}

		handlers.set(id, (/** @type {WorkerMsg} */ msg) => {
			switch (msg.type) {
				case "token":
					opts.onToken?.(msg.delta, msg.text)
					break
				case "prediction":
					opts.onPrediction?.(msg.candidates, msg.step)
					break
				case "stats":
					stats = msg
					opts.onStats?.(msg)
					break
				case "result":
					cleanup()
					resolve({text: msg.text, toolCalls: msg.toolCalls || null, toolMode: msg.toolMode, stats})
					break
				case "error":
					clog("generate: worker error", msg.message)
					cleanup()
					reject(new Error(msg.message))
					break
			}
		})

		if (opts.signal) {
			if (opts.signal.aborted) return onAbort()
			opts.signal.addEventListener("abort", onAbort)
		}
		// A string is a raw continuation prompt; an array is chat messages.
		conn.post(buildGeneratePayload(config, input, {id, sessionKey}))
	})
}

/**
 * Stream a completion as an async iterable of telemetry events:
 *   { type:"token", delta, text }
 *   { type:"prediction", candidates:[{token,p}], step }
 *   { type:"stats", ... }
 *   { type:"status", message }
 *   { type:"done", text, stats }
 *
 * @returns {AsyncGenerator}
 */
/**
 * @param {Array<any>|string} messages
 * @param {GenOpts} [opts]
 */
export async function* stream(messages, opts = {}) {
	/** @type {any[]} */
	const queue = []
	/** @type {((v?:any) => void)|null} */
	let wake = null
	let finished = false
	/** @type {any} */
	let error = null
	const push = (/** @type {any} */ ev) => {
		queue.push(ev)
		wake?.()
	}

	generate(messages, {
		...opts,
		onToken: (delta, text) => push({type: "token", delta, text}),
		onPrediction: (candidates, step) =>
			push({type: "prediction", candidates, step}),
		onStats: (s) => push({type: "stats", ...s}),
		onStatus: (message) => push({type: "status", message}),
	})
		.then((r) => push({type: "done", text: r.text, stats: r.stats}))
		.catch((e) => (error = e))
		.finally(() => {
			finished = true
			wake?.()
		})

	while (true) {
		if (queue.length) {
			yield queue.shift()
			continue
		}
		if (finished) break
		await new Promise((r) => (wake = r))
	}
	if (error) throw error
}

/**
 * Predict the next-token distribution after `text` — one forward pass, no
 * generation. Resolves to `[{token, p}]` (top-k, highest p first). Powers
 * "predict as you type". Local reads real logits; OpenRouter is best-effort
 * (chat-only models return `[]`); Ollama returns `[]`.
 *
 * @param {string} text
 * @param {GenOpts} [opts]
 * @returns {Promise<{token:string,p:number}[]>}
 */
export async function predict(text, opts = {}) {
	const base = opts.config ?? (await ensureConfig(opts.scope))
	// A config provider can carry an in-memory handler that intercepts the request
	// on the main thread (e.g. choochoo runs a base model and adds a live LoRA
	// delta). Opt-in — no handler means normal worker dispatch below.
	if (typeof base?.handler?.predict === "function") return base.handler.predict(text, opts)
	const cfg = await resolveCfgPrompts(base)
	/** @type {CallConfigExt} */
	const config = callConfig(/** @type {any} */ (cfg), /** @type {any} */ ({...opts, topk: opts.topk || 10}))
	// continuation → frame chat-only providers (OpenRouter) to predict the
	// *continuation's* next token, not a chat reply's. Opt-in (Loom sets it).
	config.continuation = !!opts.continuation
	// Built-in exposes no next-token logprobs.
	if (config.provider === "builtin") return Promise.resolve([])
	const promptedText = applyPrompts(text, /** @type {any} */ (cfg), opts.system) // prepends pre-prompt (no system in raw)
	const conn = getConnection()
	const id = nextId()
	const sessionKey = id // so an abort can reach the in-flight request in the worker
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			handlers.delete(id)
			if (opts.signal) opts.signal.removeEventListener("abort", onAbort)
		}
		function onAbort() {
			conn.post({type: "abort", sessionKey}) // cancel the worker-side fetch (OpenRouter/WebLLM)
			cleanup()
			reject(new DOMException("Aborted", "AbortError"))
		}
		handlers.set(id, (/** @type {WorkerMsg} */ msg) => {
			if (msg.type === "predictions") {
				cleanup()
				resolve(msg.candidates)
			} else if (msg.type === "error") {
				cleanup()
				reject(new Error(msg.message))
			}
		})
		if (opts.signal) {
			if (opts.signal.aborted) return onAbort()
			opts.signal.addEventListener("abort", onAbort)
		}
		conn.post({type: "predict", id, sessionKey, provider: config.provider, text: promptedText, config})
	})
}

/**
 * Score every token in `text` — runs a forward pass at each position and
 * returns the model's probability, rank, entropy, and top-k alternatives for
 * the actual next token. Powers the surprisal and info-gain overlays ("how
 * surprised was the model by what you actually wrote?" and "how much did each
 * token reduce its uncertainty?"). Only works for local models.
 *
 * Yields progress events and a final result:
 *   { type:"progress", step, total }
 *   { type:"done", scores:[{token, p, rank, entropy, topk:[{token,p}]}] }
 *
 * @param {string} text
 * @param {GenOpts} [opts]
 * @returns {AsyncGenerator}
 */
export async function* scoreTokens(text, opts = {}) {
	const cfg = await resolveCfgPrompts(opts.config ?? (await ensureConfig(opts.scope)))
	const config = callConfig(/** @type {any} */ (cfg), /** @type {any} */ (opts))
	if (config.provider !== "local") return // only local models expose raw logits
	const conn = getConnection()
	const id = nextId()
	const sessionKey = id

	/** @type {any[]} */
	const queue = []
	/** @type {((v?:any) => void)|null} */
	let wake = null
	let finished = false
	/** @type {any} */
	let error = null
	const push = (/** @type {any} */ ev) => { queue.push(ev); wake?.() }

	handlers.set(id, (/** @type {WorkerMsg} */ msg) => {
		if (msg.type === "score-progress") push({type: "progress", step: msg.step, total: msg.total})
		else if (msg.type === "token-scores") {
			push({type: "done", scores: msg.scores, spans: msg.spans, decoded: msg.decoded})
			finished = true
			handlers.delete(id)
			wake?.()
		} else if (msg.type === "error") {
			error = new Error(msg.message)
			finished = true
			handlers.delete(id)
			wake?.()
		}
	})

	function onAbort() {
		conn.post({type: "abort", sessionKey})
		handlers.delete(id)
		error = new DOMException("Aborted", "AbortError")
		finished = true
		wake?.()
	}
	if (opts.signal) {
		if (opts.signal.aborted) { onAbort(); return }
		opts.signal.addEventListener("abort", onAbort)
	}

	conn.post({type: "score-tokens", id, sessionKey, provider: config.provider, text, config})

	while (true) {
		if (queue.length) { yield queue.shift(); continue }
		if (finished) break
		await new Promise((r) => (wake = r))
	}
	if (opts.signal) opts.signal.removeEventListener("abort", onAbort)
	if (error) throw error
}

/**
 * Compute per-token importance for `text` by erasure-based attribution: a
 * baseline forward pass, then one pass per token with that token masked out,
 * scoring each token by how much its removal shifts the model's next-token
 * distribution (Jensen–Shannon divergence). N+1 forward passes on the local
 * model — genuine importance, not an attention proxy. See Li, Chen, Zhu &
 * Rudin 2016, "Understanding Neural Networks through Representation Erasure".
 *
 * This is erasure-based importance, NOT attention weights — for real attention
 * see computeAttentionWeights. Returns `{decoded, spans}` where decoded is the
 * tokenizer's round-tripped text and spans is `[{from, to, importance}]`
 * (importance normalized to [0,1]) with positions relative to `decoded`. Only
 * works for local models (others resolve to null).
 *
 * @param {string} text
 * @param {GenOpts} [opts]
 * @returns {Promise<{decoded:string, spans:Array<any>}|null>}
 */
export async function computeImportance(text, opts = {}) {
	const cfg = await resolveCfgPrompts(opts.config ?? (await ensureConfig(opts.scope)))
	const config = callConfig(/** @type {any} */ (cfg), /** @type {any} */ (opts))
	if (config.provider !== "local") return null
	const conn = getConnection()
	const id = nextId()
	return new Promise((resolve, reject) => {
		handlers.set(id, (/** @type {WorkerMsg} */ msg) => {
			if (msg.type === "importance-scores") {
				handlers.delete(id)
				resolve({decoded: msg.decoded, spans: msg.spans || []})
			} else if (msg.type === "error") {
				handlers.delete(id)
				reject(new Error(msg.message))
			}
		})
		conn.post({type: "compute-importance", id, sessionKey: id, provider: config.provider, text, config})
	})
}

/**
 * Compute REAL attention weights for `text` (not the erasure proxy that
 * computeImportance returns). Only works for local models exported with an
 * `attentions` output (see glomper-tuning/onnx_attn.py). One forward pass.
 *
 * Resolves to:
 *   { supported:true, dims:{layers,heads,seq}, received, fromLast, spans, tokens, decoded }
 * where `received` and `fromLast` are Float32Arrays of length layers*heads*seq
 * laid out as [(layer*heads + head)*seq + key]:
 *   received[…] = mean attention key j gets across all queries i≥j (causal)
 *   fromLast[…] = attention the final token places on key j
 * `spans` is [{from,to,index}] (char positions in `decoded`, keyed by token
 * index). Resolves to { supported:false } when the model has no attention
 * output, or null for non-local providers.
 *
 * @param {string} text
 * @param {GenOpts} [opts]
 * @returns {Promise<Object|null>}
 */
export async function computeAttentionWeights(text, opts = {}) {
	const cfg = await resolveCfgPrompts(opts.config ?? (await ensureConfig(opts.scope)))
	const config = callConfig(/** @type {any} */ (cfg), /** @type {any} */ (opts))
	if (config.provider !== "local") return null
	const conn = getConnection()
	const id = nextId()
	return new Promise((resolve, reject) => {
		const onAbort = () => { clog("computeAttentionWeights: aborted by caller", {model: config.model}); handlers.delete(id); reject(new DOMException("Aborted", "AbortError")) }
		if (opts.signal) {
			if (opts.signal.aborted) return onAbort()
			opts.signal.addEventListener("abort", onAbort, {once: true})
		}
		handlers.set(id, (/** @type {WorkerMsg} */ msg) => {
			if (msg.type === "attention-weights") {
				handlers.delete(id)
				opts.signal?.removeEventListener("abort", onAbort)
				resolve(msg)
			} else if (msg.type === "error") {
				clog("computeAttentionWeights: worker error", msg.message)
				handlers.delete(id)
				opts.signal?.removeEventListener("abort", onAbort)
				reject(new Error(msg.message))
			}
		})
		conn.post({type: "compute-attention-weights", id, sessionKey: id, provider: config.provider, text, config})
	})
}

/**
 * Extract per-position features from a local model for LoRA-on-head training:
 * a single forward pass returning, for every token position, the final hidden
 * state `h` and the base logits, plus token ids/spans. Requires a model
 * exported with a `last_hidden_state` output (glomper-tuning/onnx_hidden.py).
 *
 * Resolves to { supported, seq, H, V, ids, tokens, spans, decoded, hidden, logits }
 * where `hidden` is a Float32Array(seq*H) and `logits` is a Float32Array(seq*V),
 * both row-major over positions. Returns null for non-local providers, and
 * { supported:false, message } if the model lacks the hidden-state output.
 *
 * @param {string} text
 * @param {GenOpts} [opts]
 */
export async function extractFeatures(text, opts = {}) {
	const cfg = await resolveCfgPrompts(opts.config ?? (await ensureConfig(opts.scope)))
	const config = callConfig(/** @type {any} */ (cfg), /** @type {any} */ (opts))
	if (config.provider !== "local") return null
	const conn = getConnection()
	const id = nextId()
	return new Promise((resolve, reject) => {
		const onAbort = () => { handlers.delete(id); reject(new DOMException("Aborted", "AbortError")) }
		if (opts.signal) {
			if (opts.signal.aborted) return onAbort()
			opts.signal.addEventListener("abort", onAbort, {once: true})
		}
		handlers.set(id, (/** @type {WorkerMsg} */ msg) => {
			if (msg.type === "features") {
				handlers.delete(id)
				opts.signal?.removeEventListener("abort", onAbort)
				resolve(msg)
			} else if (msg.type === "error") {
				handlers.delete(id)
				opts.signal?.removeEventListener("abort", onAbort)
				reject(new Error(msg.message))
			}
		})
		conn.post({type: "extract-features", id, sessionKey: id, provider: config.provider, text, config})
	})
}

/**
 * Decode vocab ids to token strings using the loaded local model's tokenizer.
 * Used to label the next-token bars when training a LoRA adapter. Returns a
 * string[] aligned with `ids`, or null for non-local providers.
 *
 * @param {any} ids
 * @param {GenOpts} [opts]
 */
export async function decodeTokens(ids, opts = {}) {
	const cfg = await resolveCfgPrompts(opts.config ?? (await ensureConfig(opts.scope)))
	const config = callConfig(/** @type {any} */ (cfg), /** @type {any} */ (opts))
	if (config.provider !== "local") return null
	const conn = getConnection()
	const id = nextId()
	return new Promise((resolve, reject) => {
		handlers.set(id, (/** @type {WorkerMsg} */ msg) => {
			if (msg.type === "decoded-tokens") { handlers.delete(id); resolve(msg.strings) }
			else if (msg.type === "error") { handlers.delete(id); reject(new Error(msg.message)) }
		})
		conn.post({type: "decode-tokens", id, sessionKey: id, provider: config.provider, ids, config})
	})
}

/**
 * Like extractFeatures, but returns the `cut_hidden` state (the residual just
 * before the last block's MLP) — for training a LoRA adapter on that MLP (rung 2).
 * Requires a model exported with onnx_block.py. Resolves to
 * { supported, seq, d, ids, tokens, spans, decoded, hidden: Float32Array(seq*d) }.
 *
 * @param {string} text
 * @param {GenOpts} [opts]
 */
export async function extractCutFeatures(text, opts = {}) {
	const cfg = await resolveCfgPrompts(opts.config ?? (await ensureConfig(opts.scope)))
	const config = callConfig(/** @type {any} */ (cfg), /** @type {any} */ (opts))
	if (config.provider !== "local") return null
	const conn = getConnection()
	const id = nextId()
	return new Promise((resolve, reject) => {
		handlers.set(id, (/** @type {WorkerMsg} */ msg) => {
			if (msg.type === "cut-features") { handlers.delete(id); resolve(msg) }
			else if (msg.type === "error") { handlers.delete(id); reject(new Error(msg.message)) }
		})
		conn.post({type: "extract-cut-features", id, sessionKey: id, provider: config.provider, text, config})
	})
}

/**
 * Diagnostic: probe the loaded model for attention weight support. Posts a
 * `probe-attention` message to the worker and returns the result — includes
 * the ONNX session output names, forward-pass output keys, and whether any
 * attention tensors are available. Only works for local models.
 *
 * @param {string} [text]
 * @param {GenOpts} [opts]
 */
export async function probeAttention(text = "Hello world", opts = {}) {
	const cfg = opts.config ?? (await ensureConfig(opts.scope))
	const config = callConfig(/** @type {any} */ (cfg), /** @type {any} */ (opts))
	const conn = getConnection()
	const id = nextId()
	return new Promise((resolve) => {
		handlers.set(id, (/** @type {WorkerMsg} */ msg) => {
			handlers.delete(id)
			resolve(msg)
		})
		conn.post({type: "probe-attention", id, text, config})
	})
}

/**
 * Chat with the user's configured tools available. Tells the model what tools
 * exist, runs an agentic loop: generate → parse `tool-call` blocks → run each
 * handler → feed the result back → generate again, until the model stops calling
 * tools (or maxRounds). Folder-tool handlers run in the MAIN thread (full page
 * access) by default; pass `sandbox` (or set the config's `toolSandbox`) to run
 * them in an isolated Worker instead. Inline tools (with their own `handler` fn)
 * always run as given.
 *
 * @param {Array<any>|string} messages  chat messages (or a string → one user turn)
 * @param {GenOpts} [opts]  same as generate(), plus onToolCall / maxRounds / sandbox
 * @returns {Promise<{text:string, messages:Array<any>}>}
 */
export async function generateWithTools(messages, opts = {}) {
	const cfg = opts.config ?? (await ensureConfig(opts.scope))
	// Folder-tool handlers run sandboxed when the call or the config asks for it.
	const sandbox = opts.sandbox ?? cfg.toolSandbox ?? false
	// Inline tools (each with a `handler(args)` fn) + the user's folder tools.
	const inline = (opts.tools || []).map((/** @type {any} */ t) => ({...t}))
	const folder = await resolveTools(cfg)
	const tools = [...inline, ...folder]
	const convo = Array.isArray(messages)
		? [...messages]
		: [{role: "user", content: String(messages)}]
	const maxRounds = opts.maxRounds ?? 6
	let finalText = ""

	// Find a tool by name, matching either the original or sanitized name.
	const findTool = (/** @type {string} */ name) =>
		tools.find((/** @type {any} */ t) => t.name === name || sanitizeToolName(t.name) === name)

	// Execute a single tool call, returning the result text.
	const execTool = async (/** @type {any} */ call) => {
		const tool = findTool(call.name)
		if (!tool) {
			opts.onToolCall?.({name: call.name, args: call.args, error: "unknown tool"})
			return `Error: no tool named "${call.name}"`
		}
		try {
			const result = tool.handler
				? await tool.handler(call.args || {})
				: await runTool(tool, call.args, {sandbox})
			opts.onToolCall?.({name: call.name, args: call.args, result})
			return typeof result === "string" ? result : JSON.stringify(result)
		} catch (e) {
			const err = /** @type {any} */ (e)
			opts.onToolCall?.({name: call.name, args: call.args, error: err?.message || String(e)})
			return "Error: " + (err?.message || String(e))
		}
	}

	// Whether to use native tool schemas vs text-based XML convention.
	// Starts true for native providers, falls back to false on error.
	const provider = (callConfig(/** @type {any} */ (cfg), /** @type {any} */ (opts))).provider
	let useNative =
		tools.length > 0 &&
		(NATIVE_TOOL_PROVIDERS.has(provider) || TEMPLATE_TOOL_PROVIDERS.has(provider))
	// Text-based tool system prompt, built once and reused across rounds.
	const textToolSystem = tools.length
		? [buildToolsSystem(tools), opts.system].filter(Boolean).join("\n\n") || undefined
		: opts.system

	for (let round = 0; round < maxRounds; round++) {
		const cb = opts.onToken
		/** @type {GenOpts} */
		const genOpts = {
			...opts,
			config: cfg,
			onToken: cb
				? (/** @type {string} */ delta, /** @type {string} */ full) => cb(delta, full, round)
				: undefined,
		}
		if (useNative) {
			// Native: pass tools for generate() to convert to schemas
			genOpts.tools = tools
		} else {
			// Text-based: inject tool descriptions into system prompt ourselves;
			// don't pass tools so generate() won't attempt native for a provider
			// we've already fallen back from.
			genOpts.tools = undefined
			genOpts.system = textToolSystem
		}

		let res
		try {
			res = await generate(convo, genOpts)
		} catch (err) {
			// If native tool calling failed on the first round, fall back to
			// text-based tool descriptions injected into the system prompt.
			if (useNative && round === 0) {
				useNative = false
				res = await generate(convo, {
					...genOpts,
					tools: undefined,
					system: textToolSystem,
				})
			} else {
				throw err
			}
		}
		finalText = res.text

		// Native structured tool_calls if the provider returned them; otherwise
		// parse the model's text (XML <tool_call> / fenced / bare JSON), keeping
		// only calls to real tools — prose can contain JSON that looks like one.
		const nativeCalls = res.toolCalls && res.toolCalls.length > 0
		const calls = /** @type {any[]} */ (
			nativeCalls ? res.toolCalls : parseToolCalls(res.text).filter((call) => findTool(call.name))
		)
		if (!calls.length) break

		if (nativeCalls) {
			// OpenAI format: assistant message includes tool_calls array, each
			// tool result is role:"tool" with a matching tool_call_id.
			convo.push({
				role: "assistant",
				content: res.text || null,
				tool_calls: calls.map((call, i) => ({
					id: call.id || "call_" + round + "_" + i,
					type: "function",
					function: {
						name: call.name,
						arguments: JSON.stringify(call.args || {}),
					},
				})),
			})
			for (let i = 0; i < calls.length; i++) {
				const call = calls[i]
				const callId = call.id || "call_" + round + "_" + i
				convo.push({role: "tool", tool_call_id: callId, content: await execTool(call)})
			}
		} else if (res.toolMode === "template") {
			convo.push({
				role: "assistant",
				content: "",
				tool_calls: calls.map((call) => ({
					type: "function",
					function: {name: call.name, arguments: call.args || {}},
				})),
			})
			for (const call of calls) {
				convo.push({role: "tool", content: await execTool(call)})
			}
		} else {
			// Text-based fallback: assistant text + user message with results.
			convo.push({role: "assistant", content: res.text})
			for (const call of calls) {
				convo.push({role: "user", content: `Tool "${call.name}" returned:\n${await execTool(call)}`})
			}
		}
	}
	return {text: finalText, messages: convo}
}

/**
 * Warm the model/connection ahead of the first real call.
 * @param {GenOpts} [opts]
 */
export function preload(opts = {}) {
	const cfg = opts.config ?? readConfig()
	const config = callConfig(/** @type {any} */ (cfg), /** @type {any} */ (opts))
	getConnection().post({type: "preload", provider: config.provider, config})
}

/**
 * Subscribe to worker status messages (model download / shader compile / etc.).
 * Returns an unsubscribe function.
 * @param {(message:string)=>void} cb
 */
export function onStatus(cb) {
	getConnection()
	statusListeners.add(cb)
	return () => statusListeners.delete(cb)
}

/** Abort an in-flight generation by its sessionKey.
 * @param {string|number} sessionKey */
export function abort(sessionKey) {
	getConnection().post({type: "abort", sessionKey})
}

/**
 * Register a local ONNX model uploaded from disk so the worker can load it as
 * `local/<name>`. `files` is `[{path, blob}]` in transformers.js layout
 * (config.json, tokenizer.json, onnx/model_<dtype>.onnx, …). Session-only — the
 * files aren't persisted, so they must be re-registered after a reload.
 *
 * @param {string} id     e.g. "local/my-model"
 * @param {{path:string, blob:Blob}[]} files
 * @param {string} [dtype="q4f16"]
 */
export function registerLocalModel(id, files, dtype = "q4f16") {
	getConnection().post({type: "register-local-model", id, files, dtype})
}

/**
 * Resume a generation that may have survived a refresh, by sessionKey.
 * Handlers: { onToken(full), onDone(text), onError(msg), onNone() }.
 * @param {string|number} sessionKey
 * @param {{onToken?:(t?:string)=>void, onDone?:(t?:string)=>void, onError?:(m?:string)=>void, onNone?:()=>void}} [handlers2]
 */
export function resume(sessionKey, handlers2 = {}) {
	resumeHandlers.set(sessionKey, handlers2)
	getConnection().post({type: "resume", sessionKey})
}
