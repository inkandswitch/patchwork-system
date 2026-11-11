/**
 * Per-user LLM config, held in a private settings doc (its body IS the config)
 * requested from the `patchwork:tool-storage` provider (see
 * `patchwork-base/providers`) under the shared id `"llm"` — every LLM-touching
 * tool resolves the same doc, the same way any other tool could park its own
 * settings under a different id. The provider lazily creates the doc and
 * scopes it to the current account, so this needs no `window.accountDocHandle`
 * global: just a DOM node inside a mounted `<patchwork-view>` subtree (any
 * element passed to `ensureSettingsDoc`/`subscribeConfig`/etc). See
 * `ensureSettingsDoc()` for resolution/creation.
 *
 * @typedef {"local"|"openrouter"|"ollama"|"webllm"|"builtin"} ProviderId
 *
 * @typedef {Object} CustomModel
 * @property {string} model_id   HuggingFace repo of a self-compiled MLC model
 * @property {string} model_lib  URL/name of its compiled wasm lib
 *
 * @typedef {Object} RecentModel
 * @property {ProviderId} provider
 * @property {string|null} model
 *
 * @typedef {Object} ResolvedPrompts
 * @property {string} [system]  resolved system-prompt text
 * @property {string} [pre]     resolved pre-prompt text
 *
 * @typedef {Object} LLMConfig
 * @property {ProviderId} provider
 * @property {{predict?:Function}|null} [handler]  in-memory request handler attached programmatically by a config provider (never persisted) to intercept calls on the main thread before the worker
 * @property {number} temperature       default sampling temperature (0 = greedy)
 * @property {number} topP              nucleus sampling (1 = off)
 * @property {number} topK              top-k sampling (0 = off)
 * @property {number} minP              min-p sampling (0 = off)
 * @property {number} repetitionPenalty 1 = off
 * @property {number} frequencyPenalty  -2..2
 * @property {number} presencePenalty   -2..2
 * @property {number|null} seed         fixed seed (null = random)
 * @property {number|null} maxTokens    output cap (null = provider default)
 * @property {boolean} outputAttentions request per-token attention scores
 * @property {{model:string,dtype:string|null}} local
 * @property {{apiKey:string,model:string,contextLength:number|null,maxCompletionTokens:number|null}} openrouter
 * @property {{url:string,model:string}} ollama
 * @property {{model:string,custom:CustomModel[]}} webllm
 * @property {Object} builtin
 * @property {string|null} tools        URL of a folder doc of llm:tool DocLinks
 * @property {boolean} toolSandbox      run folder-tool handlers in an isolated Worker
 * @property {string|null} prompts      URL of a folder doc of prompt DocLinks
 * @property {string|null} systemUrl    selected llm:system-prompt doc
 * @property {string|null} preUrl       selected llm:pre-prompt doc
 * @property {RecentModel[]} recentModels  most-recently-chosen, newest first
 * @property {Record<string, boolean>} [toolToggles]  {toolName: false} for host-tool built-ins the user disabled
 * @property {ResolvedPrompts} [resolved]  prompt TEXT, filled in by resolveCfgPrompts
 * @property {Record<string, {config?:any, perdoc?:Record<string, any>}>} [pertool]  per-tool / per-doc whole-config overrides
 *
 * @typedef {{toolId:string, docId?:string}} Scope  config resolution scope (per-tool / per-doc override target)
 *
 * The flat per-provider shape the worker's `generate` message wants. Built by
 * {@link callConfig} from an {@link LLMConfig} plus per-call overrides.
 * @typedef {Object} CallConfig
 * @property {ProviderId} provider
 * @property {number} temperature
 * @property {number} topP
 * @property {number} topK
 * @property {number} minP
 * @property {number} repetitionPenalty
 * @property {number} frequencyPenalty
 * @property {number} presencePenalty
 * @property {number|null} seed
 * @property {number} topk            how many candidate logprobs to stream (viz)
 * @property {number} [maxNewTokens]
 * @property {string} [apiKey]
 * @property {string} [model]
 * @property {number|null} [contextLength]
 * @property {number|null} [maxCompletionTokens]
 * @property {string} [url]
 * @property {string} [dtype]
 * @property {CustomModel[]} [custom]
 *
 * @typedef {import("@automerge/automerge-repo").DocHandle<any>} DocHandle
 */

import {subscribe, request} from "@inkandswitch/patchwork-providers"

// Shared id every LLM-touching tool requests its settings doc under (see
// `patchwork:tool-storage`, patchwork-base/providers) — one config, not one
// per calling tool.
export const TOOL_STORAGE_ID = "llm"
export const CONFIG_SELECTOR = {type: "patchwork:llm-config"}

export const DEFAULTS = {
	provider: "local",
	// --- sampling / decoding parameters ---
	temperature: 0.7,
	topP: 0.9, // nucleus sampling (1 = off)
	topK: 0, // top-k sampling (0 = off)
	minP: 0, // min-p sampling (0 = off)
	repetitionPenalty: 1.1, // 1 = off (transformers / ollama / openrouter)
	frequencyPenalty: 0, // -2..2 (openrouter / ollama / webllm)
	presencePenalty: 0, // -2..2
	seed: null, // fixed seed for reproducibility (null = random)
	maxTokens: null, // output cap (null = provider default / per-call)
	outputAttentions: false, // request per-token attention scores (only some providers)
	local: {model: "onnx-community/Qwen3-0.6B-ONNX", dtype: null}, // dtype null = auto (catalogue default / q4f16)
	openrouter: {
		apiKey: "",
		model: "anthropic/claude-sonnet-4",
		contextLength: null,
		maxCompletionTokens: null,
	},
	ollama: {url: "http://localhost:11434", model: "llama3.2"},
	webllm: {model: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", custom: []}, // MLC WebLLM (WebGPU); custom = self-compiled model records
	builtin: {}, // Chrome built-in AI (Gemini Nano) — one model, no config
	tools: null, // URL of a "folder" doc — its .docs are the llm:tool DocLinks
	toolSandbox: false, // run folder-tool handlers in an isolated Worker (no page access)
	prompts: null, // URL of a "folder" doc — its .docs are the prompt DocLinks
	systemUrl: null, // selected llm:system-prompt doc
	preUrl: null, // selected llm:pre-prompt doc
	recentModels: [], // most-recently-chosen {provider, model}, newest first
	toolToggles: {}, // {toolName: false} — a host tool's built-in tools the user turned off
	// Per-tool / per-doc whole-config overrides. Shape:
	//   pertool[toolId] = { config?: <full LLMConfig>, perdoc?: { [docId]: <full LLMConfig> } }
	// Resolution (see scopedRaw): most-specific present wins — doc → tool → default.
	pertool: {},
}

// Sampling/decoding params reset together by the picker's "Reset to defaults".
export const PARAM_KEYS = [
	"temperature",
	"topP",
	"topK",
	"minP",
	"repetitionPenalty",
	"frequencyPenalty",
	"presencePenalty",
	"seed",
	"maxTokens",
	"outputAttentions",
]

// What each provider's runtime actually READS, not what it accepts. transformers.js
// in particular declares `top_p`/`typical_p` on its GenerationConfig and then never
// looks at them again — its multinomial sampler consults `top_k` and nothing else —
// so those read `false` here even though passing them throws no error.
export const PROVIDER_CAPS = {
	local:      { logprobs: true,  attention: true,  topP: false, topK: true,  minP: false, typicalP: false, repetitionPenalty: true,  noRepeatNgramSize: true,  frequencyPenalty: false, presencePenalty: false, seed: false, maxTokens: true  },
	openrouter: { logprobs: true,  attention: false, topP: true,  topK: true,  minP: true,  typicalP: false, repetitionPenalty: true,  noRepeatNgramSize: false, frequencyPenalty: true,  presencePenalty: true,  seed: true,  maxTokens: true  },
	ollama:     { logprobs: false, attention: false, topP: true,  topK: true,  minP: true,  typicalP: true,  repetitionPenalty: true,  noRepeatNgramSize: false, frequencyPenalty: false, presencePenalty: false, seed: true,  maxTokens: true  },
	webllm:     { logprobs: true,  attention: false, topP: true,  topK: false, minP: false, typicalP: false, repetitionPenalty: false, noRepeatNgramSize: false, frequencyPenalty: true,  presencePenalty: true,  seed: true,  maxTokens: true  },
	builtin:    { logprobs: false, attention: false, topP: false, topK: true,  minP: false, typicalP: false, repetitionPenalty: false, noRepeatNgramSize: false, frequencyPenalty: false, presencePenalty: false, seed: false, maxTokens: false },
}

// Why a param is greyed out, per provider. "Not supported" is true but useless;
// these say what the underlying runtime actually does with the value.
const TRANSFORMERS_NO_FIELD =
	"transformers.js's GenerationConfig has no field for this — it drops the value silently, so the slider would lie to you."
const TRANSFORMERS_DEAD_FIELD =
	"transformers.js declares this on its GenerationConfig but never reads it: its sampler filters by top-k and nothing else. Passing a value is a no-op."
const WEBLLM_MINIMAL =
	"WebLLM's MLC runtime exposes only temperature, top_p and the two OpenAI-style penalties."
const NANO_MINIMAL = "Chrome's built-in Gemini Nano API exposes temperature and topK only."
export const CAP_NOTES = {
	local: {
		topP: TRANSFORMERS_DEAD_FIELD + " Use top-k and temperature to shape the tail.",
		typicalP: TRANSFORMERS_DEAD_FIELD,
		minP: TRANSFORMERS_NO_FIELD,
		frequencyPenalty: TRANSFORMERS_NO_FIELD + " Use repetition penalty instead.",
		presencePenalty: TRANSFORMERS_NO_FIELD + " Use repetition penalty instead.",
		seed: "transformers.js samples from the global RNG and exposes no seed, so runs can't be made reproducible.",
	},
	webllm: {
		topK: WEBLLM_MINIMAL,
		minP: WEBLLM_MINIMAL,
		typicalP: WEBLLM_MINIMAL,
		noRepeatNgramSize: WEBLLM_MINIMAL,
		repetitionPenalty:
			"WebLLM takes frequency/presence penalties instead of a multiplicative repetition penalty.",
	},
	builtin: {
		topP: NANO_MINIMAL,
		minP: NANO_MINIMAL,
		typicalP: NANO_MINIMAL,
		repetitionPenalty: NANO_MINIMAL,
		noRepeatNgramSize: NANO_MINIMAL,
		frequencyPenalty: NANO_MINIMAL,
		presencePenalty: NANO_MINIMAL,
		seed: NANO_MINIMAL,
		maxTokens: "Chrome's built-in Gemini Nano API caps output itself and takes no limit.",
	},
	ollama: {
		logprobs: "Ollama's API returns no per-token logprobs, so there are no next-token predictions to show.",
		frequencyPenalty: "Ollama takes a single repeat_penalty rather than the OpenAI-style pair.",
		presencePenalty: "Ollama takes a single repeat_penalty rather than the OpenAI-style pair.",
		noRepeatNgramSize:
			"Ollama has no n-gram ban; its repeat_penalty (with repeat_last_n) is the nearest thing.",
	},
	openrouter: {
		attention: "Attention scores need the raw model; a hosted API only returns text.",
		typicalP: "No provider behind OpenRouter accepts typical_p — it isn't in any model's supported_parameters.",
		noRepeatNgramSize:
			"OpenAI-shaped APIs have no n-gram ban; repetition/frequency penalties are the nearest thing.",
	},
}

/**
 * Why `key` is unavailable under `provider`, or null if it is available.
 * @param {string} provider
 * @param {string} key
 * @returns {string|null}
 */
export function capNote(provider, key) {
	const caps = /** @type {Record<string, any>} */ (PROVIDER_CAPS)[provider] || {}
	if (caps[key] !== false) return null
	return (
		/** @type {Record<string, any>} */ (CAP_NOTES)[provider]?.[key] ||
		"Not supported by this provider."
	)
}

function repoRef() {
	return (typeof window !== "undefined" && window.repo) || null
}

// --- settings doc -----------------------------------------------------------
// The config lives in its own doc (its body IS the config), requested from the
// `patchwork:tool-storage` provider under `TOOL_STORAGE_ID`. That provider
// owns the account-doc pointer and the lazy-create; this module just resolves
// it and caches the handle so reads/writes stay synchronous afterwards.
//
// Resolving needs *some* DOM node inside a mounted `<patchwork-view>` subtree
// (to dispatch the `patchwork:subscribe` request against) — most callers here
// (client.js, tools.js, picker.js) have no element of their own. Rather than
// fall back to a global, we remember the most recent element any caller *did*
// supply (`lastElement`, warmed by whichever tool's UI mounted first — chat
// view, loom, the picker, …) and let elementless callers piggyback on that
// bootstrap. Until one has happened, resolution simply isn't ready yet — the
// same as any other not-yet-loaded doc.

/** @type {DocHandle|null} */
let settingsHandle = null
/** @type {Promise<DocHandle|null>|null} */
let settingsReady = null // de-dupes concurrent ensureSettingsDoc() calls
/** @type {HTMLElement|null} */
let lastElement = null

/** The cached settings DocHandle, or null until ensureSettingsDoc() resolves. */
export function settingsDocHandle() {
	return settingsHandle
}

/**
 * Resolve (or lazily create, via the `patchwork:tool-storage` provider) the
 * settings doc and cache its handle. Idempotent and concurrency-safe. Pass an
 * `element` the first time it's available (any node inside a mounted
 * `<patchwork-view>`); later elementless calls reuse whichever element a
 * caller most recently supplied.
 * @param {HTMLElement|null} [element]
 * @returns {Promise<DocHandle|null>}
 */
export function ensureSettingsDoc(element) {
	if (element) lastElement = element
	if (settingsHandle) return Promise.resolve(settingsHandle)
	if (settingsReady) return settingsReady
	const el = element ?? lastElement
	const repo = repoRef()
	if (!repo || !el) return Promise.resolve(null) // not bootstrapped yet; don't cache — a later call with an element can still resolve
	settingsReady = (async () => {
		const url = await request(el, {type: "patchwork:tool-storage", toolId: TOOL_STORAGE_ID})
		if (!url) {
			settingsReady = null
			return null
		}
		settingsHandle = await repo.find(/** @type {any} */ (url))
		return settingsHandle
	})()
	return settingsReady
}

/**
 * Ensure the settings doc is resolved, then return the normalized config.
 * @param {Scope} [scope]
 * @param {HTMLElement|null} [element]
 */
export async function ensureConfig(scope, element) {
	await ensureSettingsDoc(element)
	return scope ? readScopedConfig(scope) : readConfig()
}

/**
 * Read the normalized LLM config. Reads the cached settings doc, or defaults
 * if it hasn't resolved yet. Pass a settings-doc snapshot to normalize that
 * instead.
 * @param {Record<string, any>} [snapshot]
 * @returns {LLMConfig}
 */
export function readConfig(snapshot) {
	if (snapshot !== undefined) return normalizeConfig(snapshot)
	return normalizeConfig(settingsHandle?.doc() ?? {})
}

/**
 * Fill in defaults for any missing fields of a raw `llm` config object.
 * @param {any} [raw]
 * @returns {LLMConfig}
 */
export function normalizeConfig(raw = {}) {
	return {
		provider: raw.provider ?? DEFAULTS.provider,
		// Optional in-memory request handler. A config provider can attach
		// { predict, ... } to intercept calls on the main thread before they reach
		// the worker — e.g. choochoo runs a base model and adds a live LoRA delta.
		// Never stored in a doc (it holds functions); only set programmatically via
		// a provider element, and carried through normalize so predict() can find it.
		handler:
			raw.handler && typeof raw.handler === "object" ? raw.handler : null,
		temperature:
			typeof raw.temperature === "number" ? raw.temperature : DEFAULTS.temperature,
		topP: typeof raw.topP === "number" ? raw.topP : DEFAULTS.topP,
		topK: typeof raw.topK === "number" ? raw.topK : DEFAULTS.topK,
		minP: typeof raw.minP === "number" ? raw.minP : DEFAULTS.minP,
		repetitionPenalty:
			typeof raw.repetitionPenalty === "number"
				? raw.repetitionPenalty
				: DEFAULTS.repetitionPenalty,
		frequencyPenalty:
			typeof raw.frequencyPenalty === "number"
				? raw.frequencyPenalty
				: DEFAULTS.frequencyPenalty,
		presencePenalty:
			typeof raw.presencePenalty === "number"
				? raw.presencePenalty
				: DEFAULTS.presencePenalty,
		seed: raw.seed ?? DEFAULTS.seed,
		maxTokens: raw.maxTokens ?? DEFAULTS.maxTokens,
		outputAttentions: raw.outputAttentions ?? DEFAULTS.outputAttentions,
		local: {...DEFAULTS.local, ...(raw.local ?? {})},
		openrouter: {...DEFAULTS.openrouter, ...(raw.openrouter ?? {})},
		ollama: {...DEFAULTS.ollama, ...(raw.ollama ?? {})},
		webllm: {
			...DEFAULTS.webllm,
			...(raw.webllm ?? {}),
			// Self-compiled MLC models: just {model_id, model_lib}. The weights URL is
			// derived from the model_id (its HuggingFace repo) in the worker. Plain
			// copies — these get re-assigned into the doc, and automerge rejects
			// re-inserting its own proxy objects.
			custom: Array.isArray(raw.webllm?.custom)
				? raw.webllm.custom
						.map((/** @type {any} */ c) => ({
							model_id: c.model_id ?? "",
							model_lib: c.model_lib ?? "",
						}))
						.filter((/** @type {CustomModel} */ c) => c.model_id || c.model_lib)
				: [],
		},
		builtin: {...DEFAULTS.builtin, ...(raw.builtin ?? {})},
		// Folders (URLs). The legacy array/object shapes resolve to null here; the
		// one-time migrateConfig() converts them and rewrites the account doc.
		tools: typeof raw.tools === "string" ? raw.tools : null,
		toolSandbox: !!raw.toolSandbox,
		prompts: typeof raw.prompts === "string" ? raw.prompts : null,
		systemUrl:
			raw.systemUrl ??
			(raw.prompts && typeof raw.prompts === "object" ? raw.prompts.systemUrl : null) ??
			null,
		preUrl:
			raw.preUrl ??
			(raw.prompts && typeof raw.prompts === "object" ? raw.prompts.preUrl : null) ??
			null,
		// Plain copies (see webllm.custom note) — re-assigned into the doc on save.
		recentModels: Array.isArray(raw.recentModels)
			? raw.recentModels.map((/** @type {any} */ r) => ({
					provider: r.provider,
					model: r.model ?? null,
			  }))
			: [],
		// {toolName: false} for any host-tool built-in tool the user disabled.
		// Plain copy (see webllm.custom note) — re-assigned into the doc on save.
		toolToggles:
			raw.toolToggles && typeof raw.toolToggles === "object"
				? {...raw.toolToggles}
				: {},
		// Per-tool / per-doc whole-config overrides. Deep plain copy; each nested
		// config is normalized on resolve (scopedRaw → normalizeConfig).
		pertool:
			raw.pertool && typeof raw.pertool === "object"
				? JSON.parse(JSON.stringify(raw.pertool))
				: {},
	}
}

// Pick the raw config for a scope: the most-specific override present wins —
// per-doc → per-tool → the top-level default. `scope` is {toolId, docId?}.
// Whole-scope semantics: an override is a complete config, not a partial.
/**
 * @param {any} raw
 * @param {Scope} [scope]
 */
export function scopedRaw(raw, scope) {
	if (!raw || !scope || !scope.toolId) return raw
	const pt = raw.pertool && raw.pertool[scope.toolId]
	if (!pt) return raw
	if (scope.docId && pt.perdoc && pt.perdoc[scope.docId]) return pt.perdoc[scope.docId]
	if (pt.config) return pt.config
	return raw
}

// Does THIS exact scope level hold its own override? (Used by the picker to show
// create-vs-remove and the active scope.) docId omitted → checks the tool level.
/**
 * @param {any} raw
 * @param {Scope} [scope]
 */
export function hasScopeOverride(raw, scope) {
	if (!raw || !scope || !scope.toolId) return false
	const pt = raw.pertool && raw.pertool[scope.toolId]
	if (!pt) return false
	return scope.docId ? !!(pt.perdoc && pt.perdoc[scope.docId]) : !!pt.config
}

// The raw settings-doc body, used by scope read/write helpers.
function rawSettings() {
	return settingsHandle?.doc() ?? {}
}

// Read a scope's effective config (normalized). Falls back through tool → default.
/** @param {Scope} [scope] */
export function readScopedConfig(scope) {
	return normalizeConfig(scopedRaw(rawSettings(), scope))
}

// Create/replace a scope's whole-config override (writes a full normalized config
// into pertool). `cfgObj` defaults to the current default config (seed a fork).
/**
 * @param {Scope} scope
 * @param {any} [cfgObj]
 */
export function writeScopeOverride(scope, cfgObj) {
	if (!scope || !scope.toolId) return
	const full = JSON.parse(JSON.stringify(normalizeConfig(cfgObj ?? readConfig())))
	delete full.pertool // overrides never nest
	const apply = (/** @type {DocHandle|null} */ handle) => {
		if (!handle) return
		handle.change((/** @type {any} */ d) => {
			if (!d.pertool) d.pertool = {}
			if (!d.pertool[scope.toolId]) d.pertool[scope.toolId] = {}
			if (scope.docId) {
				if (!d.pertool[scope.toolId].perdoc) d.pertool[scope.toolId].perdoc = {}
				d.pertool[scope.toolId].perdoc[scope.docId] = full
			} else {
				d.pertool[scope.toolId].config = full
			}
		})
	}
	if (settingsHandle) apply(settingsHandle)
	else ensureSettingsDoc().then(apply)
}

// Remove a scope's override (fall back to the less-specific scope / default).
/** @param {Scope} scope */
export function clearScopeOverride(scope) {
	if (!scope || !scope.toolId || !settingsHandle) return
	settingsHandle.change((/** @type {any} */ d) => {
		const pt = d.pertool && d.pertool[scope.toolId]
		if (!pt) return
		if (scope.docId) {
			if (pt.perdoc) delete pt.perdoc[scope.docId]
		} else {
			delete pt.config
		}
		// Drop now-empty containers so the tool falls all the way back to default
		// and the settings doc doesn't accumulate dead `pertool` entries.
		if (pt.perdoc && Object.keys(pt.perdoc).length === 0) delete pt.perdoc
		if (!pt.config && !pt.perdoc) delete d.pertool[scope.toolId]
	})
}

/**
 * Combine the configured system prompt with any tool-supplied one. Tools may
 * append their own instructions to the user's system prompt.
 * @param {LLMConfig} [cfg]
 * @param {string} [extraSystem]
 * @returns {string}
 */
export function effectiveSystem(cfg, extraSystem) {
	// `cfg.resolved.{system,pre}` is the prompt TEXT, filled in by resolveCfgPrompts
	// (which reads the selected prompt docs). Absent in a bare cfg → empty.
	return [cfg?.resolved?.system, extraSystem].filter(Boolean).join("\n\n")
}

/**
 * @typedef {{role:string, content:string}} ChatMessage
 */

/**
 * Apply the configured pre-prompt + system prompt to a generation input.
 * - string input (raw continuation): prefixes `system\n\npre\n\n…`
 * - chat messages: prepends a system message.
 * @param {string|ChatMessage[]} input
 * @param {LLMConfig} [cfg]
 * @param {string} [extraSystem]
 * @returns {string|ChatMessage[]}
 */
export function applyPrompts(input, cfg, extraSystem) {
	const sys = effectiveSystem(cfg, extraSystem)
	const pre = cfg?.resolved?.pre || ""
	if (typeof input === "string") {
		// Raw completion has no `system` role, so the system prompt is OMITTED
		// here — only the pre-prompt (literal text before your input) is prepended.
		void sys
		return pre ? pre + "\n\n" + input : input
	}
	// Chat: the system prompt becomes a real `system` turn; the pre-prompt is
	// glued onto the front of the first user message (part of the user's input).
	let msgs = [...input]
	if (pre) {
		const i = msgs.findIndex((m) => m.role === "user")
		if (i === -1) msgs.unshift({role: "user", content: pre})
		else msgs[i] = {...msgs[i], content: pre + "\n\n" + msgs[i].content}
	}
	return sys ? [{role: "system", content: sys}, ...msgs] : msgs
}

/**
 * Resolve the *active* LLM config reactively, calling `callback(config)` now and
 * whenever it changes.
 *
 * Resolution order: a `patchwork:llm-config` provider in `element`'s subtree
 * (request/provide — lets a future provider element scope config per tool/view)
 * wins; if no provider answers within `timeoutMs`, we fall back to this tool's
 * `patchwork:tool-storage` settings doc (and keep it live by listening for
 * changes to it). If a provider appears later, it takes over. Always pass a
 * real `element` when you have one — it's also how the settings doc itself
 * gets resolved (see `ensureSettingsDoc`), even for later callers that don't.
 *
 * @param {HTMLElement} element  a node inside a <patchwork-view>
 * @param {(config: import("./config.js").LLMConfig) => void} callback
 * @returns {() => void} unsubscribe
 */
export function subscribeConfig(element, callback, {timeoutMs = 50} = {}) {
	if (!element) throw new TypeError("subscribeConfig requires an element")
	let providerAnswered = false
	/** @type {(() => void)|null} */
	let fallbackOff = null
	let providerOff = () => {}
	/** @type {ReturnType<typeof setTimeout>|undefined} */
	let timer = undefined

	let cancelled = false
	const startFallback = () => {
		if (providerAnswered || cancelled) return
		callback(readConfig()) // immediate sync value (defaults) so UI isn't blank
		ensureSettingsDoc(element).then((handle) => {
			if (providerAnswered || cancelled || !handle) return
			callback(readConfig()) // real config now that the settings doc resolved
			const onChange = () => {
				if (!providerAnswered && !cancelled) callback(readConfig())
			}
			handle.on("change", onChange)
			fallbackOff = () => handle.off("change", onChange)
		})
	}

	providerOff = subscribe(element, CONFIG_SELECTOR, (raw) => {
		providerAnswered = true
		clearTimeout(timer)
		fallbackOff?.()
		fallbackOff = null
		callback(normalizeConfig(raw))
	})
	timer = setTimeout(startFallback, timeoutMs)

	return () => {
		cancelled = true
		clearTimeout(timer)
		providerOff()
		fallbackOff?.()
	}
}

/**
 * One-shot resolve of the active config (request + account-doc fallback).
 * @param {HTMLElement} element
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<LLMConfig>}
 */
export function resolveConfig(element, opts) {
	return new Promise((resolve) => {
		/** @type {(() => void)|null} */
		let off = null
		let done = false
		off = subscribeConfig(
			element,
			(cfg) => {
				if (done) return
				done = true
				queueMicrotask(() => off && off())
				resolve(cfg)
			},
			opts
		)
	})
}

/**
 * Merge a partial config into the settings doc. `undefined` values are
 * skipped; `null` is stored (e.g. an unknown context length).
 * @param {Partial<LLMConfig> & Record<string, any>} next
 */
export function writeConfig(next) {
	/** @param {DocHandle|null} handle */
	const apply = (handle) => {
		if (!handle) return
		handle.change((/** @type {any} */ d) => {
			if (next.provider !== undefined) d.provider = next.provider
			for (const k of [
				"temperature",
				"topP",
				"topK",
				"minP",
				"repetitionPenalty",
				"frequencyPenalty",
				"presencePenalty",
				"seed",
				"maxTokens",
				"outputAttentions",
				"tools", // folder URL
				"toolSandbox", // run folder-tool handlers in an isolated Worker
				"prompts", // folder URL
				"systemUrl", // selected prompt docs
				"preUrl",
				"recentModels", // [{provider, model}], newest first
				"toolToggles", // {toolName: false} host-tool built-ins turned off
			]) {
				if (next[k] !== undefined) d[k] = next[k]
			}
			for (const group of ["local", "openrouter", "ollama", "webllm", "builtin"]) {
				if (!next[group]) continue
				if (!d[group]) d[group] = {}
				for (const [field, value] of Object.entries(next[group])) {
					if (value === undefined) continue
					d[group][field] = value // null is allowed in automerge
				}
			}
		})
	}
	// Settings doc is usually already resolved (the picker awaits it). If a write
	// races ahead of that, resolve first, then apply.
	if (settingsHandle) apply(settingsHandle)
	else ensureSettingsDoc().then(apply)
}

/**
 * Resolve the flat call config for a given provider from a full LLMConfig — the
 * shape the worker's `generate` message wants.
 * @param {LLMConfig} cfg
 * @param {Partial<CallConfig>} [overrides]
 * @returns {CallConfig}
 */
export function callConfig(cfg, overrides = {}) {
	const provider = overrides.provider ?? cfg.provider
	const base = {
		provider,
		temperature:
			overrides.temperature != null ? overrides.temperature : cfg.temperature,
		topP: overrides.topP != null ? overrides.topP : cfg.topP,
		topK: cfg.topK, // sampling top-k (distinct from `topk`, the prediction-viz count)
		minP: cfg.minP,
		repetitionPenalty: cfg.repetitionPenalty,
		frequencyPenalty: cfg.frequencyPenalty,
		presencePenalty: cfg.presencePenalty,
		seed: cfg.seed,
		topk: (overrides.topk ?? 0) | 0, // how many candidate logprobs to stream (viz)
		maxNewTokens: overrides.maxNewTokens ?? cfg.maxTokens ?? undefined,
	}
	if (provider === "openrouter") {
		return {
			...base,
			apiKey: overrides.apiKey ?? cfg.openrouter.apiKey,
			model: overrides.model ?? cfg.openrouter.model,
			contextLength: cfg.openrouter.contextLength,
			maxCompletionTokens: cfg.openrouter.maxCompletionTokens,
		}
	}
	if (provider === "ollama") {
		return {
			...base,
			url: overrides.url ?? cfg.ollama.url,
			model: overrides.model ?? cfg.ollama.model,
		}
	}
	if (provider === "webllm") {
		return {
			...base,
			model: overrides.model ?? cfg.webllm.model,
			custom: cfg.webllm.custom || [], // self-compiled MLC model records
		}
	}
	return {...base, model: overrides.model ?? cfg.local.model, dtype: overrides.dtype ?? cfg.local.dtype ?? undefined}
}

// ---------------------------------------------------------------------------
// Model catalogues (for the picker)
// ---------------------------------------------------------------------------

/** In-browser (WebGPU/WASM) models, mirroring chat's catalogue. */
export const LOCAL_MODELS = [
	{id: "LiquidAI/LFM2.5-2.6B-ONNX", name: "LFM2.5 2.6B", canUseTool: true},
	{id: "onnx-community/Qwen3-4B-ONNX", name: "Qwen3 4B", canUseTool: true},
	{id: "onnx-community/Qwen3-1.7B-ONNX", name: "Qwen3 1.7B", canUseTool: true},
	{id: "onnx-community/Qwen3-0.6B-ONNX", name: "Qwen3 0.6B", canUseTool: true},
	{
		id: "onnx-community/Llama-3.2-1B-Instruct-ONNX",
		name: "Llama 3.2 1B",
		canUseTool: true,
	},
	{id: "onnx-community/gemma-3-1b-it-ONNX", name: "Gemma 3 1B", canUseTool: false},
	{
		id: "onnx-community/gemma-3-270m-it-ONNX",
		name: "Gemma 3 270M (tiny)",
		canUseTool: false,
	},
	{
		id: "onnx-community/DeepSeek-R1-Distill-Qwen-1.5B-ONNX",
		name: "DeepSeek-R1 Distill 1.5B (reasoning)",
		canUseTool: false,
	},
	{
		id: "onnx-community/Qwen2.5-Coder-1.5B-Instruct",
		name: "Qwen2.5 Coder 1.5B",
		canUseTool: true,
	},
	{
		id: "onnx-community/Qwen2.5-0.5B-Instruct",
		name: "Qwen2.5 0.5B",
		canUseTool: true,
	},
	{
		id: "onnx-community/LFM2-1.2B-ONNX",
		name: "LFM2 1.2B",
		canUseTool: false,
	},
	{
		id: "onnx-community/Phi-3.5-mini-instruct-onnx-web",
		name: "Phi 3.5 Mini",
		canUseTool: false,
	},
	{
		id: "onnx-community/SmolLM2-1.7B-Instruct-ONNX",
		name: "SmolLM2 1.7B",
		canUseTool: false,
	},
	{
		id: "onnx-community/SmolLM2-360M-Instruct",
		name: "SmolLM2 360M (tiny)",
		canUseTool: false,
	},
]

/** Curated WebLLM (MLC) models — WebGPU, non-ONNX. Type any prebuilt model_id too. */
export const WEBLLM_MODELS = [
	{id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC", name: "Qwen2.5 0.5B"},
	{id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", name: "Qwen2.5 1.5B"},
	{id: "Qwen2.5-3B-Instruct-q4f16_1-MLC", name: "Qwen2.5 3B"},
	{id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", name: "Llama 3.2 1B"},
	{id: "Llama-3.2-3B-Instruct-q4f16_1-MLC", name: "Llama 3.2 3B"},
	{id: "Phi-3.5-mini-instruct-q4f16_1-MLC", name: "Phi 3.5 Mini"},
	{id: "gemma-2-2b-it-q4f16_1-MLC", name: "Gemma 2 2B"},
	{id: "Mistral-7B-Instruct-v0.3-q4f16_1-MLC", name: "Mistral 7B"},
	{id: "SmolLM2-1.7B-Instruct-q4f16_1-MLC", name: "SmolLM2 1.7B"},
	{id: "TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC", name: "TinyLlama 1.1B"},
]

/** Fetch the OpenRouter model catalogue (with capability metadata). */
export async function fetchOpenRouterModels() {
	const resp = await fetch("https://openrouter.ai/api/v1/models")
	const data = await resp.json()
	return (data.data || [])
		.filter((/** @type {any} */ m) => m.id)
		.map((/** @type {any} */ m) => ({
			id: m.id,
			name: m.name || m.id,
			context_length: m.context_length || m.top_provider?.context_length,
			max_completion_tokens: m.top_provider?.max_completion_tokens,
			supported_parameters: m.supported_parameters || [],
			default_parameters: m.default_parameters || null,
			input_modalities: m.architecture?.input_modalities || [],
			pricing: m.pricing || null,
		}))
		.sort((/** @type {{name:string}} */ a, /** @type {{name:string}} */ b) =>
			a.name.localeCompare(b.name)
		)
}

// A model's `generation_config.json` carries the sampling settings its authors
// actually recommend — the same numbers a model card quotes. transformers.js
// merges that file over its own defaults, so a value equal to a default tells us
// nothing; only fields that differ are a real suggestion.
const GEN_CONFIG_DEFAULTS = {
	temperature: 1,
	top_p: 1,
	top_k: 50,
	repetition_penalty: 1,
	min_p: 0,
	typical_p: 1,
	no_repeat_ngram_size: 0,
}

/** @type {Record<string, string>} */
const GEN_CONFIG_KEYS = {
	temperature: "temperature",
	top_p: "topP",
	top_k: "topK",
	repetition_penalty: "repetitionPenalty",
	min_p: "minP",
	typical_p: "typicalP",
	no_repeat_ngram_size: "noRepeatNgramSize",
	max_new_tokens: "maxTokens",
	max_length: "maxTokens", // older files spell the output cap this way
}

/**
 * Pick the author-set sampling params out of a parsed `generation_config.json`,
 * as picker-config keys. Returns `{}` when the file is all defaults.
 * @param {any} gc
 * @returns {Record<string, number>}
 */
export function suggestedParams(gc) {
	/** @type {Record<string, number>} */
	const out = {}
	if (!gc || typeof gc !== "object") return out
	// `do_sample: false` means the authors want greedy decoding, whatever else
	// the file says — express that as temperature 0, which is how the rest of
	// this config represents it.
	if (gc.do_sample === false) return {temperature: 0}
	for (const [src, dest] of Object.entries(GEN_CONFIG_KEYS)) {
		const v = gc[src]
		if (typeof v !== "number") continue
		if (v === /** @type {Record<string, number>} */ (GEN_CONFIG_DEFAULTS)[src]) continue
		// max_length defaults to 20 in transformers and means prompt+output, not
		// output — a value that small is boilerplate, not a recommendation.
		if (dest === "maxTokens" && (v <= 20 || out.maxTokens != null)) continue
		out[dest] = v
	}
	return out
}

/**
 * The non-sampling half of a `generation_config.json` — the stop tokens. Not a
 * user knob, but the thing to look at when a model won't shut up: no
 * `eos_token_id` means nothing ever ends generation but the token cap.
 * @param {any} gc
 * @returns {{eos: number[], hasEos: boolean, greedy: boolean}}
 */
export function generationStops(gc) {
	const raw = gc?.eos_token_id
	const eos = raw == null ? [] : Array.isArray(raw) ? raw : [raw]
	return {eos, hasEos: eos.length > 0, greedy: gc?.do_sample === false}
}

// OpenRouter publishes the same idea under `default_parameters` on each model in
// the catalogue (populated for a couple hundred of them; null-filled otherwise).
/** @type {Record<string, string>} */
const OR_PARAM_KEYS = {
	temperature: "temperature",
	top_p: "topP",
	top_k: "topK",
	min_p: "minP",
	repetition_penalty: "repetitionPenalty",
	frequency_penalty: "frequencyPenalty",
	presence_penalty: "presencePenalty",
}

/**
 * @param {any} dp a model's `default_parameters`
 * @returns {Record<string, number>}
 */
export function suggestedParamsFromOpenRouter(dp) {
	/** @type {Record<string, number>} */
	const out = {}
	if (!dp || typeof dp !== "object") return out
	for (const [src, dest] of Object.entries(OR_PARAM_KEYS)) {
		if (typeof dp[src] === "number") out[dest] = dp[src]
	}
	return out
}

/**
 * Fetch a HuggingFace model's `generation_config.json`. Null when the repo
 * doesn't ship one (or the request fails — this is best-effort decoration).
 * @param {string} id
 * @returns {Promise<any>}
 */
export async function fetchGenerationConfig(id) {
	try {
		const res = await fetch(
			`https://huggingface.co/${id}/resolve/main/generation_config.json`
		)
		return res.ok ? await res.json() : null
	} catch {
		return null
	}
}

/**
 * Same, for a local ONNX folder picked from disk — read the file we already hold.
 * @param {{path:string, blob:Blob}[]} files
 * @returns {Promise<any>}
 */
export async function generationConfigFromFiles(files) {
	const f = files.find((x) => x.path.split("/").pop() === "generation_config.json")
	if (!f) return null
	try {
		return JSON.parse(await f.blob.text())
	} catch {
		return null
	}
}

/**
 * Probe an Ollama server for installed models.
 * @param {string} [url]
 * @returns {Promise<string[]>}
 */
export async function fetchOllamaModels(url) {
	const base = (url || DEFAULTS.ollama.url).replace(/\/$/, "")
	const resp = await fetch(base + "/api/tags")
	const data = await resp.json()
	return (data.models || []).map((/** @type {any} */ m) => m.name || m.model)
}

/**
 * Human label for the current selection.
 * @param {LLMConfig} cfg
 * @param {{openrouterModels?: Array<{id:string,name:string}>}} [opts]
 * @returns {string}
 */
export function describeConfig(cfg, {openrouterModels = []} = {}) {
	if (cfg.provider === "local") {
		const m = LOCAL_MODELS.find((x) => x.id === cfg.local.model)
		const name = m ? m.name : cfg.local.model.replace(/^local\//, "")
		return "Browser " + name
	}
	if (cfg.provider === "openrouter") {
		const m = openrouterModels.find((x) => x.id === cfg.openrouter.model)
		return "OpenRouter " + (m ? m.name : cfg.openrouter.model)
	}
	if (cfg.provider === "webllm") {
		const m = WEBLLM_MODELS.find((x) => x.id === cfg.webllm.model)
		return "WebLLM " + (m ? m.name : cfg.webllm.model)
	}
	if (cfg.provider === "builtin") return "Built-in (Chrome)"
	return "Ollama " + cfg.ollama.model
}
