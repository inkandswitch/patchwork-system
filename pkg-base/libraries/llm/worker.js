/**
 * @patchwork/llm worker
 *
 * Runs ALL generation (local transformers.js / OpenRouter / Ollama) off the
 * main thread, keyed by an optional `sessionKey`. Alongside the text it
 * streams the model's next-token distribution ("predictions") and decode stats
 * (TTFT, tokens/sec, the exact sampling settings used) — for local AND
 * OpenRouter.
 *
 * IN:
 *   { type:"generate", id, sessionKey?, provider, messages, config }
 *       config: { model, apiKey?, url?, temperature?, topk?, maxNewTokens?,
 *                 contextLength?, maxCompletionTokens? }
 *   { type:"preload", provider, config }
 *   { type:"resume", sessionKey }
 *   { type:"abort", sessionKey }
 *   { type:"list-local-models" }
 *
 * OUT (per generation `id` unless noted):
 *   { type:"token", id, delta, text }
 *   { type:"prediction", id, step, candidates:[{token,p}] }   // next-token top-k
 *   { type:"stats", id, ...stats }
 *   { type:"result", id, text }
 *   { type:"error", id, message }
 *   { type:"status", message }            // broadcast: model loading, etc.
 *   { type:"ready", ...modelInfo }
 *   { type:"local-models", models }
 *   { type:"resumed"|"resume-result", id, text } | { type:"no-active-generation" }
 */

// v4: the version where TextStreamer + a logits_processor probe (the per-token
// prediction telemetry) are verified working together (rlm uses this combo).

/**
 * @typedef {import("./config.js").CallConfig} CallConfig
 * The config the worker actually receives. Shaped like a {@link CallConfig} but
 * kept fully loose: the worker reads extra fields (tools, continuation, custom)
 * and compares some numeric fields against "" defensively, so a permissive
 * record is intentional here.
 * @typedef {Record<string, any>} WorkerConfig
 *
 * Any worker message payload (request or response) — these are dynamic blobs
 * over postMessage, so a permissive shape is intentional.
 * @typedef {Record<string, any>} AnyMsg
 *
 * A single in-flight generation entry.
 * @typedef {Object} Gen
 * @property {any} id
 * @property {any} port
 * @property {string} fullText
 * @property {boolean} done
 * @property {string} [finalText]
 * @property {AbortController} abortController
 *
 * @typedef {{token:string, p:number}} Candidate
 */

const CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4"
/** @type {Set<any>} */
const ports = new Set()

/** @param {AnyMsg} msg */
function broadcast(msg) {
	for (const port of ports) {
		try {
			port.postMessage(msg)
		} catch {}
	}
}

// The big model weights are fetched by onnxruntime-web DIRECTLY (an external-data
// blob: a `.onnx_data`/`.bin`/hash-named LFS file), bypassing transformers.js's
// `progress_callback` — which only ever sees the small tokenizer/config/onnx-graph
// files. So those instantly hit "100%" while a 400MB+ weights download silently
// streams for minutes with no feedback. Fix: wrap the worker's global `fetch` and
// stream-count bytes on the large weights download, broadcasting real progress.
//
// We deliberately do NOT track `.onnx` files (transformers.js already reports those)
// or anything under the size threshold (tokenizer/config/API calls) — only the big
// external-data blob transformers.js is blind to.
/** @param {number} b */
function fmtMB(b) {
	return (b / 1048576).toFixed(0) + " MB"
}

function installWeightsProgress() {
	const sg = /** @type {any} */ (self)
	if (sg.__llmWeightsFetchPatched) return
	sg.__llmWeightsFetchPatched = true
	const orig = self.fetch.bind(self)
	const THRESHOLD = 50 * 1024 * 1024 // 50MB — well above tokenizer/config/graph files
	self.fetch = async (input, init) => {
		const res = await orig(input, init)
		try {
			const cl = +(res.headers.get("content-length") || 0)
			const url = res.url || (typeof input === "string" ? input : /** @type {any} */ (input)?.url || "")
			const name = (url.split("?")[0].split("/").pop() || "").toLowerCase()
			// `.onnx` graph files are already tracked by transformers.js; skip them so
			// the two don't fight over the status line. Everything else big is weights.
			if (res.ok && res.body && cl > THRESHOLD && !name.endsWith(".onnx")) {
				return trackDownload(res, cl)
			}
		} catch {}
		return res
	}
}

/** @param {Response} res @param {number} total */
function trackDownload(res, total) {
	let loaded = 0
	let lastPct = -1
	const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader()
	const stream = new ReadableStream({
		async pull(controller) {
			const {done, value} = await reader.read()
			if (done) {
				controller.close()
				return
			}
			loaded += value.byteLength
			const pct = total ? Math.round((100 * loaded) / total) : 0
			if (pct !== lastPct) {
				lastPct = pct
				broadcast({
					type: "status",
					message: `Downloading model weights… ${pct}% (${fmtMB(loaded)} / ${fmtMB(total)})`,
				})
			}
			controller.enqueue(value)
		},
		cancel(reason) {
			return reader.cancel(reason)
		},
	})
	return new Response(stream, {
		status: res.status,
		statusText: res.statusText,
		headers: res.headers,
	})
}

// Forward worker diagnostics to every connected page. A SharedWorker has its own
// (usually hidden) console, so without this its logs are invisible from the tool.
// `client.js` re-prints `{type:"log"}` on the main thread. Each arg is reduced to
// something structured-clonable so postMessage never throws on a live object.
/** @param {...any} args */
function log(...args) {
	try {
		console.log("[llm worker]", ...args)
	} catch {}
	broadcast({
		type: "log",
		args: args.map((a) => {
			if (a == null || typeof a !== "object") return a
			try {
				return JSON.parse(JSON.stringify(a))
			} catch {
				return String(a)
			}
		}),
	})
}

// sessionKey -> { id, port, fullText, done, finalText, abortController }
/** @type {Map<any, Gen>} */
const activeGenerations = new Map()

self.addEventListener("error", (e) =>
	broadcast({type: "status", message: "Worker error: " + (/** @type {ErrorEvent} */ (e).message || "")})
)
self.addEventListener("unhandledrejection", (e) =>
	broadcast({
		type: "status",
		message: "Worker error: " + (/** @type {PromiseRejectionEvent} */ (e).reason?.message || /** @type {PromiseRejectionEvent} */ (e).reason || ""),
	})
)

// ---------------------------------------------------------------------------
// Local models (transformers.js)
// ---------------------------------------------------------------------------

const LOCAL_MODELS = [
	{id: "LiquidAI/LFM2.5-2.6B-ONNX", name: "LFM2.5 2.6B", dtype: "q4f16"},
	{id: "onnx-community/Qwen3-4B-ONNX", name: "Qwen3 4B (best)", dtype: "q4f16"},
	{id: "onnx-community/Qwen3-1.7B-ONNX", name: "Qwen3 1.7B", dtype: "q4f16"},
	{id: "onnx-community/Qwen3-0.6B-ONNX", name: "Qwen3 0.6B (fast)", dtype: "q4f16"},
	{id: "onnx-community/Llama-3.2-1B-Instruct-ONNX", name: "Llama 3.2 1B", dtype: "q4f16"},
	{id: "onnx-community/Phi-3.5-mini-instruct-onnx-web", name: "Phi 3.5 Mini", dtype: "q4f16"},
	{id: "onnx-community/SmolLM2-1.7B-Instruct-ONNX", name: "SmolLM2 1.7B", dtype: "q4f16"},
]
const DEFAULT_MODEL_ID = "onnx-community/Qwen3-0.6B-ONNX"
const PREDICTION_CAP = 256 // cap per-step prediction events so a long gen can't flood

/** @type {any} */
let TF = null
/** @type {any} */
let generator = null
let currentModelId = DEFAULT_MODEL_ID
/** @type {string|null} */
let currentDtype = null // the dtype the loaded model was compiled with
let loading = false
/** @type {Promise<void>|null} */
let loadingPromise = null
// The real error from the most recent loadModel() failure. Without this the
// device-fallback loop swallows the cause ("WASM failed") and callers can only
// report a useless "Model not loaded". Surfaced via modelLoadError().
/** @type {any} */
let lastLoadError = null

// Map a raw backend error to something a user can act on. onnxruntime's
// out-of-memory surfaces as `std::bad_alloc` / "Can't create a session" /
// "memory access out of bounds" — none of which mean "your machine is out of
// RAM". The WASM backend is wasm32 (a ~4GB address-space ceiling, independent of
// system RAM) and WebGPU is bound by GPU buffer/VRAM limits (and is disabled in
// incognito). Say that, and point at the escape hatches.
/** @param {any} err */
function friendlyError(err) {
	const raw = String((err && (err.message || err)) || "unknown error")
	// A genuine allocation failure. Big models really can exceed the wasm32
	// address space; this message is only right when the allocator actually
	// said so.
	if (/bad_alloc|out of memory|can'?t create a session/i.test(raw)) {
		return (
			"Out of memory while loading this model. Big models can exceed the browser's " +
			"WASM memory ceiling (~4GB — independent of your system RAM). Try a smaller model, " +
			"or open in a normal (non-incognito) window so WebGPU can run it on the GPU instead. " +
			"(raw: " + raw + ")"
		)
	}
	// A WASM *trap*, not an allocation failure. `memory access out of bounds` /
	// `RuntimeError: Aborted` on the CPU backend almost always means an op the
	// WASM build can't run — most commonly an fp16 dtype (q4f16/fp16), which is
	// a WebGPU dtype. A tiny model hits this without being anywhere near the 4GB
	// ceiling, so DON'T call it "out of memory".
	if (/memory access out of bounds|RuntimeError: Aborted/i.test(raw)) {
		return (
			"The WASM backend crashed running this model — usually an fp16 weight " +
			"format (q4f16/fp16) the CPU backend can't execute, not a size problem. " +
			"Use an integer quantization (q4/q8) for WASM, or open in a normal " +
			"(non-incognito) window so WebGPU is available. (raw: " + raw + ")"
		)
	}
	if (/unaligned/i.test(raw)) {
		return "The WASM backend hit an unaligned-access fault. Try a normal window so WebGPU is available, or a smaller model. (raw: " + raw + ")"
	}
	if (/tensor shape is too large|failed to call OrtRun|op_kernel\.cc/i.test(raw)) {
		return (
			"The model produced a tensor too large for this backend during the forward pass. " +
			"That usually means either a very long prompt, or a model that emits extra big outputs " +
			"every step — e.g. an attention-export model (…-attn) meant for analysis/overlays, not " +
			"chat generation. Use the standard (non-attention) model for chat, shorten the prompt, " +
			"or open in a normal window for WebGPU. (raw: " + raw + ")"
		)
	}
	return raw
}

// Map a dtype to something the WASM/CPU backend can actually execute. The fp16
// formats (q4f16, q8f16, fp16) are WebGPU-only and trap on WASM, so swap them
// for their integer-quant / fp32 equivalents. Anything already WASM-safe is
// returned unchanged.
/** @param {string} dtype @returns {string} */
function wasmSafeDtype(dtype) {
	switch (dtype) {
		case "q4f16":
			return "q4"
		case "q8f16":
			return "q8"
		case "fp16":
			return "fp32"
		default:
			return dtype
	}
}

function modelLoadError() {
	return lastLoadError
		? "Model load failed: " + friendlyError(lastLoadError)
		: "Model not loaded"
}

// Dispose the current model's onnxruntime session(s) before dropping the
// reference. GC does NOT free native wasm/GPU sessions, so without an explicit
// dispose the old model's memory lingers and loading another can `std::bad_alloc`
// even though nothing uses the old one. Nulls synchronously (so a caller's
// `if (generator)` guard sees it gone immediately) then disposes in background.
function releaseGenerator() {
	const g = generator
	const wasModel = currentModelId
	generator = null
	if (!g) return Promise.resolve()
	return (async () => {
		try {
			if (typeof g.dispose === "function") await g.dispose()
			else if (g.model && typeof g.model.dispose === "function") await g.model.dispose()
			log("releaseGenerator: disposed previous session", {model: wasModel})
		} catch (/** @type {any} */ e) {
			log("releaseGenerator: dispose failed", {model: wasModel, message: e?.message || String(e)})
		}
	})()
}
/** @type {Set<string>} */
const compiledModels = new Set()

// User-supplied local ONNX models (in transformers.js layout) uploaded from
// disk. We serve their files to transformers.js by patching the worker's fetch
// — the same trick rlm uses for CDN files — so a model id like "local/<name>"
// loads from memory instead of the network.
/** @type {Map<string, {files: Map<string, Blob>, dtype: string}>} */
const localModelFiles = new Map() // id -> { files: Map<relpath, Blob>, dtype }

// Drop anything transformers.js already cached under a local model's id, so a
// re-upload of the same folder name can't be served stale bytes from an earlier
// (possibly broken, possibly different) export.
/** @param {string} id */
async function purgeCachedModel(id) {
	try {
		const cache = await caches.open("transformers-cache")
		const keys = await cache.keys()
		let n = 0
		for (const req of keys) {
			if (req.url.includes(id + "/")) {
				await cache.delete(req)
				n++
			}
		}
		if (n) log("purged cached entries for local model", {id, n})
	} catch (/** @type {any} */ e) {
		log("purgeCachedModel failed", {id, message: e?.message || String(e)})
	}
}

function ensureLocalFetchPatch() {
	const sg = /** @type {any} */ (self)
	if (sg.__llmFetchPatched) return
	sg.__llmFetchPatched = true
	const realFetch = self.fetch.bind(self)
	self.fetch = (input, init) => {
		try {
			const url = typeof input === "string" ? input : /** @type {any} */ (input)?.url || ""
			for (const [id, entry] of localModelFiles) {
				const marker = "/" + id + "/resolve/"
				const at = url.indexOf(marker)
				if (at === -1) continue
				const after = url.slice(at + marker.length) // "<rev>/<relpath>"
				const rel = after.substring(after.indexOf("/") + 1)
				const file =
					entry.files.get(rel) || entry.files.get(rel.split("/").pop() || "")
				if (file)
					return Promise.resolve(
						new Response(file, {
							status: 200,
							headers: {"content-length": String(file.size)},
						})
					)
				// transformers.js treats several of these as optional and swallows the
				// 404 into `{}` — a missing generation_config.json costs you
				// eos_token_id, a missing tokenizer_config.json costs you the chat
				// template. Both produce garbage rather than an error, so say so.
				log("local model: 404", {id, rel, have: [...entry.files.keys()]})
				return Promise.resolve(
					new Response("local model file not found: " + rel, {status: 404})
				)
			}
		} catch {}
		return realFetch(input, init)
	}
}

/** @param {Promise<any>} promise @param {number} ms @param {string} label */
function withTimeout(promise, ms, label) {
	return Promise.race([
		promise,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error(label + " timed out")), ms)
		),
	])
}

/** @param {string} [modelId] @param {string} [dtypeOverride] */
async function loadModel(modelId, dtypeOverride) {
	modelId = modelId || DEFAULT_MODEL_ID
	// A dtype change for the same id must force a reload (e.g. switching a custom
	// HF model from q4f16 → q4 to match the variant the repo actually ships).
	const dtypeChanged = dtypeOverride && currentDtype && dtypeOverride !== currentDtype
	if (generator && (currentModelId !== modelId || dtypeChanged)) {
		log("loadModel: switching model — releasing previous", {from: currentModelId, to: modelId, dtypeChanged})
		await releaseGenerator()
	}
	if (generator) return
	if (loading && loadingPromise) return loadingPromise
	currentModelId = modelId
	loading = true
	/** @type {() => void} */
	let resolveLoading = () => {}
	loadingPromise = new Promise((r) => (resolveLoading = r))
	lastLoadError = null
	const reg = localModelFiles.get(modelId)
	ensureLocalFetchPatch()
	// dtype precedence: explicit override (picker) > registered upload > catalogue
	// entry > q4f16. Lets you pick the quantization suffix for any HF id.
	const baseDef = reg
		? {dtype: reg.dtype}
		: LOCAL_MODELS.find((m) => m.id === modelId) || {dtype: "q4f16"}
	const modelDef = {...baseDef, dtype: dtypeOverride || baseDef.dtype}
	currentDtype = modelDef.dtype
	log("loadModel: start", {modelId, dtype: modelDef.dtype})

	try {
		broadcast({type: "status", message: "Loading transformers.js…"})
		TF = await import(/* @vite-ignore */ CDN)
		TF.env.allowLocalModels = false
		installWeightsProgress() // byte-level progress for the external-data weights blob
		// transformers.js routes ALL of its I/O through `env.fetch`, which it binds
		// from `globalThis.fetch` once, at module-eval time. Anything we patch onto
		// `self.fetch` after the import is therefore invisible to it. Delegate to
		// the live `self.fetch` so patch order stops mattering.
		TF.env.fetch = (/** @type {any} */ input, /** @type {any} */ init) =>
			self.fetch(input, init)
		// A local upload is a fake repo: transformers.js caches it under
		// `local/<folder>/<file>` and reads the cache BEFORE calling fetch. Re-upload
		// a corrected (or entirely different) folder under the same name and you get
		// the first upload's bytes forever — often a tokenizer from one model beside
		// weights from another, which reads as fluent gibberish.
		TF.env.useBrowserCache = !reg
		if (navigator.storage?.persist) await navigator.storage.persist()
	} catch (/** @type {any} */ err) {
		lastLoadError = err
		console.error("[llm worker] failed to load transformers.js from", CDN, err)
		broadcast({type: "status", message: "Failed to load transformers.js: " + (err?.message || err)})
		loading = false
		loadingPromise = null
		resolveLoading()
		return
	}

	const isFirstCompile = !compiledModels.has(modelId)
	/** @param {string} backend */
	function progressCb(backend) {
		/** @type {Map<string, {loaded:number, total:number}>} */
		const fileProgress = new Map()
		return (/** @type {any} */ p) => {
			if (p.status === "progress" && p.progress != null && p.file) {
				fileProgress.set(p.file, {loaded: p.loaded || 0, total: p.total || 0})
				const shortName = p.file.split("/").pop() || p.file
				let tl = 0,
					ts = 0
				for (const f of fileProgress.values()) {
					tl += f.loaded
					ts += f.total
				}
				const overall = ts > 0 ? Math.round((100 * tl) / ts) : Math.round(p.progress)
				broadcast({
					type: "status",
					message: `Downloading ${shortName}… ${Math.round(p.progress)}% (overall ${overall}%)`,
				})
			} else if (p.status === "ready") {
				broadcast({
					type: "status",
					message: isFirstCompile
						? `⚠️ Compiling shaders for ${backend} (first time — might freeze for a bit)…`
						: `Compiling shaders for ${backend}…`,
				})
			}
		}
	}

	const hasWebGPU = typeof navigator !== "undefined" && !!navigator.gpu
	const attempts = []
	if (hasWebGPU) attempts.push({device: "webgpu", label: "WebGPU"})
	attempts.push({device: undefined, label: "WASM"})
	// Tell the page WHY a backend isn't in the running, so "it went to WASM" is
	// never a mystery. navigator.gpu is absent in incognito and in any context
	// that doesn't expose WebGPU (e.g. SharedWorkers — but this is a dedicated
	// Worker, where it should be present).
	if (!hasWebGPU) {
		broadcast({type: "status", message: "WebGPU unavailable (navigator.gpu missing — incognito or unsupported context); using WASM"})
	}
	log("loadModel: backends to try", {hasWebGPU, order: attempts.map((a) => a.label)})

	for (const attempt of attempts) {
		// The WASM/CPU backend can't execute fp16 — q4f16/fp16 trap with "memory
		// access out of bounds". Downgrade to the integer-quant equivalent for the
		// WASM attempt only; WebGPU keeps the requested dtype.
		const attemptDtype = attempt.device ? modelDef.dtype : wasmSafeDtype(modelDef.dtype)
		try {
			log("loadModel: trying backend", {backend: attempt.label, dtype: attemptDtype, requested: modelDef.dtype})
			generator = await withTimeout(
				TF.pipeline("text-generation", modelId, {
					dtype: attemptDtype,
					device: attempt.device,
					progress_callback: progressCb(attempt.label),
				}),
				180000,
				attempt.label + " pipeline"
			)
			compiledModels.add(modelId)
			// Record the dtype that actually loaded (WASM may have downgraded), so
			// the reload-on-dtype-change check and model-info report stay accurate.
			currentDtype = attemptDtype
			// Probe the model for attention output support
			try {
				const model = generator.model
				/** @type {Record<string, any>} */
				const sessionInfo = {}
				const sessions = model?.sessions || {}
				for (const [name, session] of Object.entries(sessions)) {
					const outNames = session?.outputNames || []
					sessionInfo[name] = outNames
				}
				broadcast({type: "model-info", model: modelId, sessions: sessionInfo,
					config: model?.config ? {
						output_attentions: model.config.output_attentions,
						num_hidden_layers: model.config.num_hidden_layers,
						num_attention_heads: model.config.num_attention_heads,
						model_type: model.config.model_type,
					} : null,
				})
			} catch (/** @type {any} */ e) {
				broadcast({type: "model-info", model: modelId, error: e.message})
			}
			log("loadModel: ready", {modelId, backend: attempt.label, dtype: modelDef.dtype})
			broadcast({type: "status", message: `Model ready (${attempt.label})`})
			broadcast({type: "ready", model: modelId, device: attempt.label})
			lastLoadError = null
			break
		} catch (/** @type {any} */ err) {
			lastLoadError = err
			// Keep the actual cause, not just "WASM failed".
			log("loadModel: backend failed", {backend: attempt.label, modelId, message: err?.message || String(err)})
			console.error(`[llm worker] ${attempt.label} load failed for ${modelId}:`, err)
			broadcast({
				type: "status",
				message: `${attempt.label} failed: ${err?.message || err}` + (attempt.device ? " — trying WASM…" : ""),
			})
		}
	}
	// Every device attempt failed — surface the last real error to the main
	// thread (callers otherwise report a contentless "Model not loaded").
	if (!generator) {
		log("loadModel: all backends failed", {modelId, message: lastLoadError?.message || String(lastLoadError)})
		console.error(`[llm worker] all backends failed to load ${modelId}:`, lastLoadError)
		broadcast({type: "status", message: modelLoadError()})
		broadcast({type: "load-error", model: modelId, message: modelLoadError()})
	}
	loading = false
	loadingPromise = null
	resolveLoading()
}

// Top-k of a logits row as softmax probabilities (two passes + a tiny top-k
// scan — cheap enough to run every decode step). Adapted from rlm.
/** @param {ArrayLike<number>} data @param {number} vocab @param {number} k */
function topkFromLogits(data, vocab, k) {
	let max = -Infinity
	for (let i = 0; i < vocab; i++) if (data[i] > max) max = data[i]
	let sum = 0
	/** @type {number[]} */
	const idx = []
	/** @type {number[]} */
	const val = []
	for (let i = 0; i < vocab; i++) {
		const v = data[i]
		sum += Math.exp(v - max)
		if (idx.length < k) {
			idx.push(i)
			val.push(v)
		} else {
			let mi = 0
			for (let j = 1; j < k; j++) if (val[j] < val[mi]) mi = j
			if (v > val[mi]) {
				val[mi] = v
				idx[mi] = i
			}
		}
	}
	return idx
		.map((id, j) => ({id, p: Math.exp(val[j] - max) / sum}))
		.sort((a, b) => b.p - a.p)
}

// Optional OpenAI-style sampling params, omitting off/default values so a
// provider that doesn't support one isn't upset.
// Parse a tool-call arguments value (string or already-object) → object.
/** @param {any} v @returns {any} */
function safeJson(v) {
	if (v && typeof v === "object") return v
	if (typeof v !== "string") return {}
	try {
		return JSON.parse(v)
	} catch {
		return {}
	}
}

/** @param {WorkerConfig} config */
function samplingExtras(config) {
	/** @type {Record<string, any>} */
	const p = {}
	if (config.topK > 0) p.top_k = config.topK
	if (config.minP > 0) p.min_p = config.minP
	if (config.repetitionPenalty && config.repetitionPenalty !== 1)
		p.repetition_penalty = config.repetitionPenalty
	if (config.frequencyPenalty) p.frequency_penalty = config.frequencyPenalty
	if (config.presencePenalty) p.presence_penalty = config.presencePenalty
	if (config.seed != null && config.seed !== "") p.seed = config.seed
	return p
}

// Render a chat conversation to a plain ChatML prompt string. Fallback for
// local models (base / coder checkpoints) whose tokenizer ships no
// `chat_template` — without this, transformers.js throws inside the pipeline.
/** @param {any[]} messages */
function messagesToPrompt(messages) {
	let out = ""
	for (const m of messages) {
		const content = typeof m.content === "string" ? m.content : ""
		out += `<|im_start|>${m.role || "user"}\n${content}<|im_end|>\n`
	}
	return out + "<|im_start|>assistant\n"
}

/** @param {Gen} gen @param {any} input @param {WorkerConfig} config */
async function doGenerateLocal(gen, input, config) {
	const tokenizer = generator.tokenizer
	const isText = typeof input === "string"
	const temperature = config.temperature ?? 0.7
	const topk = config.topk | 0
	const maxNewTokens = config.maxNewTokens ?? 2048

	// The text-generation pipeline applies the chat template itself when handed a
	// messages array. If the model has no template, do it ourselves and pass a
	// plain string instead (a string input skips templating entirely).
	const usedChatFallback = !isText && !tokenizer.chat_template
	let genInput = usedChatFallback ? messagesToPrompt(input) : input
	let templateTools = !isText && config.tools?.length ? config.tools : undefined
	if (templateTools && tokenizer.chat_template) {
		const rendered = tokenizer.apply_chat_template(genInput, {
			tools: templateTools,
			tokenize: false,
			add_generation_prompt: true,
		})
		let exposesTools = false
		for (const tool of templateTools) {
			const name = tool?.function?.name || tool?.name
			if (name && rendered.includes(name)) {
				exposesTools = true
				break
			}
		}
		if (!exposesTools) {
			const system = config.toolSystem
			if (system) {
				genInput = [...genInput]
				if (genInput[0]?.role === "system")
					genInput[0] = {
						...genInput[0],
						content: [system, genInput[0].content].filter(Boolean).join("\n\n"),
					}
				else genInput.unshift({role: "system", content: system})
			}
			templateTools = undefined
		}
	}
	// ChatML is Qwen's format, not a universal one. Handing it to a Llama / Gemma /
	// LFM2 checkpoint produces confident nonsense, so this fallback is a last
	// resort and must be visible — most often it means tokenizer_config.json (or
	// chat_template.jinja) never loaded, which transformers.js swallows into `{}`.
	if (usedChatFallback) {
		log("doGenerateLocal: NO CHAT TEMPLATE — falling back to ChatML", {
			model: currentModelId,
			warning:
				"output will be garbage unless this model is ChatML-native; check that tokenizer_config.json / chat_template.jinja loaded",
		})
		broadcast({
			type: "status",
			message: `⚠️ ${currentModelId} has no chat template — using ChatML. Output may be garbage.`,
		})
	}

	// On the no-template fallback a base model may not stop at the turn boundary
	// and keeps going, role-playing further <|im_start|> turns — which surface as
	// repeated text. For such models these aren't special tokens, so they stream
	// as literal text and we can cut the output there.
	const stopMarkers = usedChatFallback ? ["<|im_end|>", "<|im_start|>"] : []

	let promptTokens = 0
	try {
		const prompt =
			typeof genInput === "string"
				? genInput
				: tokenizer.apply_chat_template(genInput, {
						tokenize: false,
						add_generation_prompt: true,
						...(templateTools ? {tools: templateTools} : {}),
				  })
		promptTokens = tokenizer.encode(prompt).length
	} catch (/** @type {any} */ e) {
		log("doGenerateLocal: prompt build/encode failed (continuing)", {
			model: currentModelId,
			hasChatTemplate: !!tokenizer.chat_template,
			usedFallback: usedChatFallback,
			message: e?.message || String(e),
		})
	}

	const tStart = performance.now()
	let tFirst = 0
	let full = ""
	/** @type {any} */
	let heartbeat = null

	let stopped = false
	let posted = 0
	const streamer = new TF.TextStreamer(tokenizer, {
		skip_prompt: true,
		skip_special_tokens: true,
		callback_function: (/** @type {string} */ text) => {
			if (stopped) return
			if (!tFirst) {
				tFirst = performance.now()
				if (heartbeat) {
					clearInterval(heartbeat)
					heartbeat = null
				}
				log("doGenerateLocal: first token", {
					ttftMs: Math.round(tFirst - tStart),
					promptTokens,
				})
			}
			full += text
			let cut = -1
			for (const m of stopMarkers) {
				const i = full.indexOf(m)
				if (i !== -1 && (cut === -1 || i < cut)) cut = i
			}
			if (cut !== -1) {
				full = full.slice(0, cut)
				stopped = true
			}
			gen.fullText = full
			const delta = full.slice(posted)
			posted = full.length
			if (delta) post(gen, {type: "token", delta, text: full})
		},
	})

	// Teaching probe: a plain function is a valid logits processor; we read the
	// next-token distribution and stream the top candidates, returning logits
	// unchanged so generation is untouched.
	let step = 0
	const logits_processor =
		topk > 0
			? [
					(/** @type {any} */ inputIds, /** @type {any} */ logits) => {
						if (step < PREDICTION_CAP) {
							try {
								const vocab = logits.dims.at(-1)
								const data = logits.data
								const candidates = topkFromLogits(data, vocab, topk).map(
									({id, p}) => ({token: tokenizer.decode([id]), p: +p.toFixed(4)})
								)
								// Full-distribution entropy (bits) from raw logits
								let mx = -Infinity
								for (let j = 0; j < vocab; j++) if (data[j] > mx) mx = data[j]
								let sm = 0
								for (let j = 0; j < vocab; j++) sm += Math.exp(data[j] - mx)
								let ent = 0
								for (let j = 0; j < vocab; j++) {
									const p = Math.exp(data[j] - mx) / sm
									if (p > 0) ent -= p * Math.log2(p)
								}
								post(gen, {type: "prediction", step, candidates, entropy: +ent.toFixed(3)})
							} catch {}
						}
						step++
						return logits
					},
			  ]
			: undefined

	// The await below is the big silent gap: prefill of the whole prompt runs
	// before the first token streams. On the WASM backend a long prompt can take
	// many seconds, so emit a heartbeat (also resets a caller's inactivity
	// watchdog) and log the parameters we're running with.
	log("doGenerateLocal: generating", {
		model: currentModelId,
		dtype: currentDtype,
		promptTokens,
		maxNewTokens,
		temperature,
		inputKind: typeof genInput === "string" ? "text" : "messages",
	})
	heartbeat = setInterval(() => {
		if (tFirst) return
		const s = Math.round((performance.now() - tStart) / 1000)
		broadcast({type: "status", message: `Generating… ${s}s (prefilling, no token yet)`})
		log("doGenerateLocal: still prefilling", {elapsedS: s})
	}, 2000)

	let output
	try {
		// Only what transformers.js actually reads: its multinomial sampler consults
		// `top_k` alone. `top_p` and `typical_p` are declared on GenerationConfig and
		// never looked at; `min_p` isn't even a field. Passing them would just make
		// the decode stats below lie about what ran. See PROVIDER_CAPS.local.
		output = await generator(genInput, {
			...(templateTools ? {tools: templateTools} : {}),
			max_new_tokens: maxNewTokens,
			do_sample: temperature > 0,
			temperature,
			...(config.topK > 0 ? {top_k: config.topK} : {}),
			repetition_penalty: config.repetitionPenalty ?? 1.1,
			...(config.noRepeatNgramSize > 0
				? {no_repeat_ngram_size: config.noRepeatNgramSize}
				: {}),
			streamer,
			logits_processor,
		})
	} finally {
		if (heartbeat) {
			clearInterval(heartbeat)
			heartbeat = null
		}
	}

	const text =
		full || output?.[0]?.generated_text?.at(-1)?.content || ""

	let genTokens = 0
	try {
		genTokens = tokenizer.encode(text).length
	} catch {}
	const now = performance.now()
	post(gen, {
		type: "stats",
		provider: "local",
		model: currentModelId,
		promptTokens,
		genTokens,
		ttftMs: tFirst ? Math.round(tFirst - tStart) : null,
		totalMs: Math.round(now - tStart),
		tokPerSec: tFirst ? +(genTokens / ((now - tFirst) / 1000)).toFixed(1) : null,
		decode: {
			greedy: !(temperature > 0),
			temperature,
			top_k: config.topK > 0 ? config.topK : null, // null = the model's own generation_config
			repetition_penalty: config.repetitionPenalty ?? 1.1,
			no_repeat_ngram_size: config.noRepeatNgramSize || 0,
			maxNewTokens,
		},
	})
	// Local has no native tool API; the client parses the model's text (XML/JSON)
	// when tools were requested via the system prompt.
	return {text, toolCalls: null, toolMode: templateTools ? "template" : "text"}
}

// ---------------------------------------------------------------------------
// OpenRouter (SSE) — with logprobs → predictions, usage → stats
// ---------------------------------------------------------------------------

// Chat-only providers (OpenRouter, etc.) can't do raw completion — they'd
// *answer* the text. So a raw continuation is framed as a chat turn instructing
// the model to continue and emit ONLY the continuation.
const CONTINUE_SYS =
	"You are a text-continuation engine inside a writing tool. Continue the user's text seamlessly from exactly where it ends, matching its voice, tense, and style. Output ONLY the continuation — no preamble, no commentary, no explanation, no quotation marks — and never restate or acknowledge the user's text. If it ends mid-word or mid-sentence, finish it."

/** @param {Gen} gen @param {any} input @param {WorkerConfig} config */
async function doGenerateOpenRouter(gen, input, config) {
	const isText = typeof input === "string"
	const temperature = config.temperature ?? 0.7
	const topk = config.topk | 0
	/** @type {Record<string, any>} */
	const body = {
		model: config.model || "anthropic/claude-sonnet-4",
		stream: true,
		stream_options: {include_usage: true},
		temperature,
	}
	if (config.topP != null) body.top_p = config.topP
	Object.assign(body, samplingExtras(config))
	// Always chat; a raw string becomes a "continue this" chat turn.
	body.messages = isText
		? [{role: "system", content: CONTINUE_SYS}, {role: "user", content: input}]
		: input
	if (config.maxNewTokens) body.max_tokens = config.maxNewTokens
	else if (config.contextLength) {
		const inputEstimate = Math.ceil(JSON.stringify(input).length / 4)
		const maxOutput = config.maxCompletionTokens || 8192
		body.max_tokens = Math.min(
			maxOutput,
			Math.max(1024, config.contextLength - inputEstimate - 256)
		)
	}
	// Native function calling streams just like a normal completion: we emit
	// content deltas live AND reassemble the tool_call deltas (each chunk carries
	// partial {index, id?, function:{name?, arguments?}}) so the text still streams
	// token-by-token instead of arriving all at once. logprobs and tools don't
	// combine on OpenRouter, so only request logprobs when no tools are in play.
	const hasTools = !!(config.tools && config.tools.length)
	if (hasTools) {
		body.tools = config.tools
		body.tool_choice = "auto"
	} else if (topk > 0) {
		body.logprobs = true
		body.top_logprobs = Math.min(topk, 20) // OpenAI caps top_logprobs at 20
	}

	const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		headers: {
			Authorization: "Bearer " + config.apiKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal: gen.abortController.signal,
	})
	if (!res.ok) throw new Error("OpenRouter: " + (await res.text()))

	const tStart = performance.now()
	let tFirst = 0
	let full = ""
	let step = 0
	/** @type {any} */
	let usage = null
	const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader()
	const decoder = new TextDecoder()
	let buf = ""
	// Reassemble streamed tool_calls: each chunk carries partial deltas keyed by
	// `index`; `id`/`name` arrive once, `arguments` accrues as a JSON string.
	/** @type {Map<number, {id?:string, name?:string, args:string}>} */
	const toolAcc = new Map()

	const handleLine = (/** @type {string} */ line) => {
		if (!line.startsWith("data: ")) return
		const data = line.slice(6).trim()
		if (data === "[DONE]") return
		let parsed
		try {
			parsed = JSON.parse(data)
		} catch {
			return
		}
		if (parsed.usage) usage = parsed.usage
		const choice = parsed.choices?.[0]
		const delta = choice?.delta?.content
		if (delta) {
			if (!tFirst) tFirst = performance.now()
			full += delta
			gen.fullText = full
			post(gen, {type: "token", delta, text: full})
		}
		for (const tc of choice?.delta?.tool_calls || []) {
			const idx = tc.index ?? 0
			let acc = toolAcc.get(idx)
			if (!acc) {
				acc = {id: undefined, name: undefined, args: ""}
				toolAcc.set(idx, acc)
			}
			if (tc.id) acc.id = tc.id
			if (tc.function?.name) acc.name = tc.function.name
			if (tc.function?.arguments) acc.args += tc.function.arguments
		}
		if (topk > 0) {
			for (const item of choice?.logprobs?.content || []) {
				if (step >= PREDICTION_CAP) break
				const candidates = (item.top_logprobs || []).map((/** @type {any} */ tl) => ({
					token: tl.token,
					p: +Math.exp(tl.logprob).toFixed(4),
				}))
				if (candidates.length) post(gen, {type: "prediction", step, candidates})
				step++
			}
		}
	}

	while (true) {
		const {done, value} = await reader.read()
		if (done) break
		buf += decoder.decode(value, {stream: true})
		const lines = buf.split("\n")
		buf = lines.pop() || ""
		for (const line of lines) handleLine(line)
	}
	if (buf.trim()) for (const line of buf.split("\n")) handleLine(line)

	const now = performance.now()
	const genTokens = usage?.completion_tokens ?? null
	post(gen, {
		type: "stats",
		provider: "openrouter",
		model: config.model,
		promptTokens: usage?.prompt_tokens ?? null,
		genTokens,
		ttftMs: tFirst ? Math.round(tFirst - tStart) : null,
		totalMs: Math.round(now - tStart),
		tokPerSec:
			tFirst && genTokens
				? +(genTokens / ((now - tFirst) / 1000)).toFixed(1)
				: null,
		decode: {greedy: temperature === 0, temperature},
	})
	// Build structured tool calls from the accumulated deltas (named ones only).
	const toolCalls = toolAcc.size
		? [...toolAcc.entries()]
				.sort((a, b) => a[0] - b[0])
				.map(([, acc]) => ({id: acc.id, name: acc.name, args: safeJson(acc.args)}))
				.filter((tc) => tc.name)
		: []
	return {text: full, toolCalls: toolCalls.length ? toolCalls : null}
}

// ---------------------------------------------------------------------------
// Ollama (NDJSON) — tokens + basic stats (no logprobs available)
// ---------------------------------------------------------------------------

/** @param {Gen} gen @param {any} input @param {WorkerConfig} config */
async function doGenerateOllama(gen, input, config) {
	const isText = typeof input === "string"
	const baseUrl = (config.url || "http://localhost:11434").replace(/\/$/, "")
	/** @type {Record<string, any>} */
	const body = {
		model: config.model || "llama3.2",
		stream: true,
		options: {
			temperature: config.temperature ?? 0.7,
			...(config.topP != null ? {top_p: config.topP} : {}),
			...(config.topK > 0 ? {top_k: config.topK} : {}),
			...(config.minP > 0 ? {min_p: config.minP} : {}),
			...(config.typicalP != null && config.typicalP < 1
				? {typical_p: config.typicalP}
				: {}),
			...(config.repetitionPenalty && config.repetitionPenalty !== 1
				? {repeat_penalty: config.repetitionPenalty}
				: {}),
			...(config.frequencyPenalty ? {frequency_penalty: config.frequencyPenalty} : {}),
			...(config.presencePenalty ? {presence_penalty: config.presencePenalty} : {}),
			...(config.seed != null && config.seed !== "" ? {seed: config.seed} : {}),
		},
	}
	if (isText) body.prompt = input
	else body.messages = input

	// Native tool calling (chat only): non-streaming, parse message.tool_calls.
	if (config.tools && config.tools.length && !isText) {
		body.tools = config.tools
		body.stream = false
		const t0 = performance.now()
		const r = await fetch(baseUrl + "/api/chat", {
			method: "POST",
			headers: {"Content-Type": "application/json"},
			body: JSON.stringify(body),
			signal: gen.abortController.signal,
		})
		if (!r.ok) throw new Error("Ollama: " + (await r.text()))
		const data = await r.json()
		const text = data.message?.content || ""
		if (text) post(gen, {type: "token", delta: text, text})
		gen.fullText = text
		const toolCalls = (data.message?.tool_calls || []).map((/** @type {any} */ tc, /** @type {number} */ i) => ({
			id: tc.id || "call_" + i,
			name: tc.function?.name,
			args: safeJson(tc.function?.arguments), // Ollama already gives an object
		}))
		post(gen, {
			type: "stats",
			provider: "ollama",
			model: config.model,
			promptTokens: data.prompt_eval_count ?? null,
			genTokens: data.eval_count ?? null,
			ttftMs: null,
			totalMs: Math.round(performance.now() - t0),
			tokPerSec: null,
			decode: {greedy: (config.temperature ?? 0.7) === 0, temperature: config.temperature ?? 0.7},
		})
		return {text, toolCalls}
	}

	const res = await fetch(baseUrl + (isText ? "/api/generate" : "/api/chat"), {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify(body),
		signal: gen.abortController.signal,
	})
	if (!res.ok) throw new Error("Ollama: " + (await res.text()))

	const tStart = performance.now()
	let tFirst = 0
	let full = ""
	/** @type {any} */
	let final = null
	const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader()
	const decoder = new TextDecoder()
	let buf = ""
	while (true) {
		const {done, value} = await reader.read()
		if (done) break
		buf += decoder.decode(value, {stream: true})
		const lines = buf.split("\n")
		buf = lines.pop() || ""
		for (const line of lines) {
			if (!line.trim()) continue
			try {
				const parsed = JSON.parse(line)
				if (parsed.done) final = parsed
				const content = isText ? parsed.response : parsed.message?.content
				if (content) {
					if (!tFirst) tFirst = performance.now()
					full += content
					gen.fullText = full
					post(gen, {type: "token", delta: content, text: full})
				}
			} catch {}
		}
	}
	const now = performance.now()
	const genTokens = final?.eval_count ?? null
	post(gen, {
		type: "stats",
		provider: "ollama",
		model: config.model,
		promptTokens: final?.prompt_eval_count ?? null,
		genTokens,
		ttftMs: tFirst ? Math.round(tFirst - tStart) : null,
		totalMs: Math.round(now - tStart),
		tokPerSec:
			final?.eval_count && final?.eval_duration
				? +(final.eval_count / (final.eval_duration / 1e9)).toFixed(1)
				: null,
		decode: {temperature: config.temperature ?? 0.7},
	})
	return {text: full, toolCalls: null}
}

// ---------------------------------------------------------------------------
// Predict: a single forward pass → the next-token distribution at the cursor.
// Powers "predict as you type" without generating. Local reads the real logits;
// OpenRouter is best-effort via the /completions logprobs (chat-only models
// won't return any — the caller just sees an empty list).
// ---------------------------------------------------------------------------

/** @param {any} text @param {WorkerConfig} config */
async function predictLocal(text, config) {
	const topk = Math.max(1, config.topk | 0 || 10)
	const tokenizer = generator.tokenizer
	/** @type {Candidate[]} */
	let candidates = []
	await generator(text || " ", {
		max_new_tokens: 1,
		do_sample: false,
		logits_processor: [
			(/** @type {any} */ inputIds, /** @type {any} */ logits) => {
				if (!candidates.length) {
					try {
						const vocab = logits.dims.at(-1)
						candidates = topkFromLogits(logits.data, vocab, topk).map(({id, p}) => ({
							token: tokenizer.decode([id]),
							p: +p.toFixed(4),
						}))
					} catch {}
				}
				return logits
			},
		],
	})
	return candidates
}

// Score every token position in the input — one forward pass per position,
// extracting exact probability (from full vocab), rank, entropy, and top-k
// alternatives. Powers the attention heatmap: "how surprised was the model
// by what you actually wrote?"
/** @param {Gen} gen @param {any} text @param {WorkerConfig} config */
async function scoreTokensLocal(gen, text, config) {
	const tokenizer = generator.tokenizer
	const ids = tokenizer.encode(text)
	/** @type {any[]} */
	const scores = []

	for (let i = 0; i < ids.length; i++) {
		if (gen.abortController.signal.aborted) break

		const prefix = i === 0 ? "" : tokenizer.decode(ids.slice(0, i), {skip_special_tokens: true})
		/** @type {any} */
		let result = null

		await generator(prefix || " ", {
			max_new_tokens: 1,
			do_sample: false,
			logits_processor: [
				(/** @type {any} */ inputIds, /** @type {any} */ logits) => {
					if (result) return logits // only first call matters
					const vocab = logits.dims.at(-1)
					const data = logits.data
					const actualId = ids[i]

					// Softmax (numerically stable)
					let mx = -Infinity
					for (let j = 0; j < vocab; j++) if (data[j] > mx) mx = data[j]
					let sm = 0
					for (let j = 0; j < vocab; j++) sm += Math.exp(data[j] - mx)

					// Exact probability + rank of actual next token
					const actualP = Math.exp(data[actualId] - mx) / sm
					let rank = 1
					const actualLogit = data[actualId]
					for (let j = 0; j < vocab; j++) {
						if (data[j] > actualLogit + 1e-8) rank++
					}

					// Full-distribution entropy
					let ent = 0
					for (let j = 0; j < vocab; j++) {
						const p = Math.exp(data[j] - mx) / sm
						if (p > 0) ent -= p * Math.log2(p)
					}

					// Top-k alternatives for context
					const topk = topkFromLogits(data, vocab, 10).map(({id, p}) => ({
						token: tokenizer.decode([id]),
						p: +p.toFixed(4),
					}))

					result = {
						token: tokenizer.decode([actualId]),
						p: +actualP.toFixed(6),
						rank,
						entropy: +ent.toFixed(3),
						topk,
					}
					return logits
				},
			],
		})

		if (result) scores.push(result)
		post(gen, {type: "score-progress", step: i, total: ids.length})
	}

	// Build character position spans via cumulative decode
	const spans = []
	let prevLen = 0
	for (let i = 0; i < ids.length && i < scores.length; i++) {
		const partial = tokenizer.decode(ids.slice(0, i + 1), {skip_special_tokens: true})
		const from = prevLen
		const to = partial.length
		if (to > from) spans.push({from, to, index: i})
		prevLen = partial.length
	}
	const decoded = tokenizer.decode(ids, {skip_special_tokens: true})

	post(gen, {type: "token-scores", scores, spans, decoded})
}

// Perturbation-based token importance (erasure-based attribution).
// For each token, mask it out and measure how much the model's predictions
// change — tokens whose removal most affects the output are most important.
// N+1 forward passes (one baseline + one per token). Genuine importance
// scores, not a proxy.
/** @param {Gen} gen @param {any} text @param {WorkerConfig} config */
async function computeImportanceLocal(gen, text, config) {
	const model = generator.model
	const tokenizer = generator.tokenizer
	const inputs = tokenizer(text, {return_tensor: true})
	const ids = Array.from(inputs.input_ids.data)
	const seqLen = ids.length
	if (seqLen < 2) { post(gen, {type: "importance-scores", decoded: text, spans: []}); return }

	const vocab = model.config?.vocab_size || 151936
	const lastOff = (seqLen - 1) * vocab

	// Helper: softmax of logits at the last position
	/** @param {ArrayLike<number>} logitsData */
	function lastProbs(logitsData) {
		const p = new Float64Array(vocab)
		let mx = -Infinity
		for (let j = 0; j < vocab; j++) { const v = logitsData[lastOff + j]; if (v > mx) mx = v }
		let sm = 0
		for (let j = 0; j < vocab; j++) { p[j] = Math.exp(logitsData[lastOff + j] - mx); sm += p[j] }
		for (let j = 0; j < vocab; j++) p[j] /= sm
		return p
	}

	// JS divergence between two probability distributions
	/** @param {ArrayLike<number>} p @param {ArrayLike<number>} q */
	function jsDiv(p, q) {
		let d = 0
		for (let j = 0; j < vocab; j++) {
			const m = (p[j] + q[j]) / 2
			if (m > 0) {
				if (p[j] > 0) d += p[j] * Math.log(p[j] / m)
				if (q[j] > 0) d += q[j] * Math.log(q[j] / m)
			}
		}
		return d / 2
	}

	// 1. Baseline forward pass
	broadcast({type: "status", message: "Saliency: baseline…"})
	const baseOut = await model(inputs)
	const baseP = lastProbs(baseOut.logits.data)

	// 2. For each token, replace it with unk/pad and measure divergence
	const importance = new Float64Array(seqLen)
	const idsData = new BigInt64Array(inputs.input_ids.data)

	for (let i = 0; i < seqLen; i++) {
		if (gen.abortController.signal.aborted) break
		broadcast({type: "status", message: `Saliency: ${i + 1}/${seqLen}…`})
		post(gen, {type: "score-progress", step: i, total: seqLen})

		// Replace token i with 0 (unk/pad) — semantic erasure
		const modIds = new BigInt64Array(idsData)
		modIds[i] = 0n
		const modInputs = {
			input_ids: new TF.Tensor("int64", modIds, inputs.input_ids.dims),
			attention_mask: inputs.attention_mask,
		}
		const modOut = await model(modInputs)
		const modP = lastProbs(modOut.logits.data)
		importance[i] = jsDiv(baseP, modP)
	}

	// Normalize to [0, 1]
	let lo = Infinity, hi = -Infinity
	for (let i = 0; i < seqLen; i++) {
		if (importance[i] < lo) lo = importance[i]
		if (importance[i] > hi) hi = importance[i]
	}
	const range = hi - lo || 1

	// Build spans via cumulative decode
	const spans = []
	let prevLen = 0
	for (let i = 0; i < ids.length; i++) {
		const partial = tokenizer.decode(ids.slice(0, i + 1), {skip_special_tokens: true})
		const from = prevLen
		const to = partial.length
		if (to > from) {
			spans.push({from, to, importance: (importance[i] - lo) / range})
		}
		prevLen = partial.length
	}
	const decoded = tokenizer.decode(ids, {skip_special_tokens: true})

	post(gen, {type: "importance-scores", decoded, spans})
	broadcast({type: "status", message: ""})
}

// REAL attention weights (not erasure). For models exported with an `attentions`
// output (see glomper-tuning/onnx_attn.py — shape [batch, layers, heads, seq,
// seq], post-softmax, rows sum to 1 over keys). One forward pass; we reduce the
// big [L,H,S,S] tensor server-side to two per-(layer,head) vectors so the client
// can re-slice layer/head/view instantly without re-running:
//   received[l][h][j] = mean over queries i≥j of A[i,j]  — how attended-to key j
//                        is across the whole sequence (causal: only i≥j see it)
//   fromLast[l][h][j] = A[S-1, j]                         — what the final token
//                        (the next-token prediction position) attends to
// If the model has no `attentions` output, posts {supported:false}.
/** @param {Gen} gen @param {any} text @param {WorkerConfig} config */
async function computeAttentionWeightsLocal(gen, text, config) {
	const model = generator.model
	const tokenizer = generator.tokenizer
	const inputs = tokenizer(text, {return_tensor: true})
	const ids = Array.from(inputs.input_ids.data)
	const seqLen = ids.length
	if (seqLen < 2) {
		post(gen, {type: "attention-weights", supported: true, dims: {layers: 0, heads: 0, seq: seqLen}, received: new Float32Array(0), fromLast: new Float32Array(0), spans: [], tokens: [], decoded: text})
		return
	}

	log("computeAttentionWeights: forward pass", {model: currentModelId, seqLen})
	broadcast({type: "status", message: "Attention: forward pass…"})
	const outputs = await model(inputs)
	const att = outputs.attentions
	if (!att || !att.dims || att.dims.length !== 5) {
		// Report what the forward pass actually produced so the UI can say why
		// (wrong model vs. an attentions output that's named/shaped unexpectedly).
		const outputKeys = Object.keys(outputs || {})
		log("computeAttentionWeights: no usable attentions output", {model: currentModelId, outputKeys, attnDims: att?.dims || null})
		console.warn(`[llm worker] ${currentModelId} has no usable attentions output. forward outputs:`, outputKeys, att ? `(attentions dims: [${att.dims}])` : "(no `attentions` key)")
		post(gen, {type: "attention-weights", supported: false, model: currentModelId, outputKeys, attnDims: att?.dims || null})
		broadcast({type: "status", message: ""})
		return
	}

	// dims: [batch, layers, heads, queries, keys]
	const [, L, H, Sq, Sk] = att.dims
	const data = att.data // Float32Array, batch index 0
	const S = Sk
	const strideL = H * Sq * Sk
	const strideH = Sq * Sk
	const strideQ = Sk
	const received = new Float32Array(L * H * S)
	const fromLast = new Float32Array(L * H * S)
	const lastQ = Sq - 1
	for (let l = 0; l < L; l++) {
		for (let h = 0; h < H; h++) {
			const base = l * strideL + h * strideH
			const out = (l * H + h) * S
			const lastRow = base + lastQ * strideQ
			for (let j = 0; j < S; j++) fromLast[out + j] = data[lastRow + j]
			for (let j = 0; j < S; j++) {
				let sum = 0, cnt = 0
				for (let i = j; i < Sq; i++) { sum += data[base + i * strideQ + j]; cnt++ }
				received[out + j] = cnt ? sum / cnt : 0
			}
		}
	}

	// Char-position spans (skip_special_tokens, like the other passes) keyed by
	// token index so the client can map a span back to its attention row/col.
	const spans = []
	const tokens = []
	let prevLen = 0
	for (let i = 0; i < seqLen; i++) {
		const partial = tokenizer.decode(ids.slice(0, i + 1), {skip_special_tokens: true})
		const from = prevLen
		const to = partial.length
		tokens.push(tokenizer.decode([ids[i]]))
		if (to > from) spans.push({from, to, index: i})
		prevLen = partial.length
	}
	const decoded = tokenizer.decode(ids, {skip_special_tokens: true})

	post(gen, {type: "attention-weights", supported: true, dims: {layers: L, heads: H, seq: S}, received, fromLast, spans, tokens, decoded})
	broadcast({type: "status", message: ""})
}

/** @param {any} text @param {WorkerConfig} config @param {AbortSignal} signal */
async function predictOpenRouter(text, config, signal) {
	const topk = Math.min(Math.max(1, config.topk | 0 || 10), 20)
	// Chat with the continuation framing (raw /completions doesn't work for
	// chat-only models); the first token's logprobs are the next-token dist.
	const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		headers: {
			Authorization: "Bearer " + config.apiKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: config.model,
			messages: config.continuation
				? [{role: "system", content: CONTINUE_SYS}, {role: "user", content: text || " "}]
				: [{role: "user", content: text || " "}],
			max_tokens: 1,
			temperature: 0,
			logprobs: true,
			top_logprobs: topk,
		}),
		signal,
	})
	if (!res.ok) throw new Error("OpenRouter predict: " + (await res.text()))
	const data = await res.json()
	const top = data.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs
	if (!top) return []
	return top
		.map((/** @type {any} */ tl) => ({token: tl.token, p: +Math.exp(tl.logprob).toFixed(4)}))
		.sort((/** @type {any} */ a, /** @type {any} */ b) => b.p - a.p)
}

/** @param {any} port @param {AnyMsg} data */
function handlePredict(port, data) {
	const {id, text, config = {}} = data
	const provider = data.provider
	const sessionKey = data.sessionKey || id
	// Register an abortable entry so an "abort" message (keyed by sessionKey) can
	// cancel the in-flight request — the OpenRouter/WebLLM fetch honours the signal.
	const abortController = new AbortController()
	activeGenerations.set(sessionKey, {id, port, done: false, fullText: "", abortController})
	const cleanup = () => activeGenerations.delete(sessionKey)
	const reply = (/** @type {any} */ candidates) => {
		cleanup()
		port.postMessage({type: "predictions", id, candidates})
	}
	const failPredict = (/** @type {any} */ message) => {
		cleanup()
		if (!abortController.signal.aborted) port.postMessage({type: "error", id, message})
	}

	if (provider === "openrouter") {
		predictOpenRouter(text, config, abortController.signal)
			.then(reply)
			.catch((e) => failPredict(e?.message || String(e)))
		return
	}
	if (provider === "ollama") {
		reply([]) // Ollama's API exposes no logprobs
		return
	}
	if (provider === "webllm") {
		predictWebLLM(text, config)
			.then(reply)
			.catch((e) => failPredict(e?.message || String(e)))
		return
	}
	const requested = config.model || DEFAULT_MODEL_ID
	const run = () =>
		predictLocal(text, config)
			.then(reply)
			.catch((e) => failPredict(e?.message || String(e)))
	if (!generator || currentModelId !== requested) {
		if (currentModelId !== requested) generator = null
		loadModel(requested, config.dtype).then(() =>
			generator ? run() : failPredict(modelLoadError())
		)
	} else run()
}

// ---------------------------------------------------------------------------
// WebLLM (MLC) — WebGPU, non-ONNX, loaded from a CDN like transformers.js. We're
// already in a worker, so CreateMLCEngine runs the model right here. logprobs
// give the same per-token predictions as the rest. (Mirrors rlm's WebLLMClient.)
// ---------------------------------------------------------------------------

/** @type {any} */
let webllmMod = null
/** @type {any} */
let webllmEngine = null
/** @type {any} */
let webllmModel = null

/** @param {string} [model] @param {any} [custom] */
async function ensureWebLLM(model, custom) {
	model = model || "Qwen2.5-1.5B-Instruct-q4f16_1-MLC"
	if (!webllmMod) {
		broadcast({type: "status", message: "Loading WebLLM…"})
		// @ts-ignore — remote ESM URL, no type declarations
		webllmMod = await import(/* @vite-ignore */ "https://esm.run/@mlc-ai/web-llm")
	}
	if (webllmEngine && webllmModel === model) return
	if (webllmEngine) {
		try {
			await webllmEngine.unload?.()
		} catch {}
		webllmEngine = null
	}
	webllmModel = model
	// Merge any self-compiled MLC model records into the prebuilt list so a custom
	// model_id resolves to its weights + wasm lib. We only store {model_id,
	// model_lib}; the weights URL is the model_id's HuggingFace repo. Stored in the
	// config (not localStorage), threaded through as config.custom.
	const customList = (Array.isArray(custom) ? custom : [])
		.filter((/** @type {any} */ c) => c && c.model_id && c.model_lib)
		.map((/** @type {any} */ c) => ({
			...c,
			// weights URL defaults to the HF repo named by model_id (matches rlm —
			// WebLLM appends the resolve path itself, so NO /resolve/main/ suffix)
			model: c.model || "https://huggingface.co/" + c.model_id,
		}))
	const appConfig = customList.length
		? {
				...webllmMod.prebuiltAppConfig,
				model_list: [...webllmMod.prebuiltAppConfig.model_list, ...customList],
		  }
		: undefined
	webllmEngine = await webllmMod.CreateMLCEngine(model, {
		appConfig,
		initProgressCallback: (/** @type {any} */ r) =>
			broadcast({
				type: "status",
				message:
					r.text ||
					"Loading… " +
						(typeof r.progress === "number" ? Math.round(r.progress * 100) + "%" : ""),
			}),
	})
	broadcast({type: "status", message: "Model ready (WebLLM)"})
	broadcast({type: "ready", model, device: "WebGPU"})
}

/** @param {Gen} gen @param {any} input @param {WorkerConfig} config */
async function doGenerateWebLLM(gen, input, config) {
	await ensureWebLLM(config.model, config.custom)
	const isText = typeof input === "string"

	// Native tool calling (chat only): non-streaming, parse message.tool_calls.
	if (config.tools && config.tools.length && !isText) {
		const t0 = performance.now()
		const res = await webllmEngine.chat.completions.create({
			messages: input,
			tools: config.tools,
			tool_choice: "auto",
			stream: false,
			temperature: config.temperature ?? 0.7,
			...(config.topP != null ? {top_p: config.topP} : {}),
			...(config.maxNewTokens ? {max_tokens: config.maxNewTokens} : {}),
		})
		const msg = res.choices?.[0]?.message || {}
		const text = msg.content || ""
		if (text) post(gen, {type: "token", delta: text, text})
		gen.fullText = text
		const toolCalls = (msg.tool_calls || []).map((/** @type {any} */ tc) => ({
			id: tc.id,
			name: tc.function?.name,
			args: safeJson(tc.function?.arguments),
		}))
		post(gen, {
			type: "stats",
			provider: "webllm",
			model: config.model,
			promptTokens: res.usage?.prompt_tokens ?? null,
			genTokens: res.usage?.completion_tokens ?? null,
			ttftMs: null,
			totalMs: Math.round(performance.now() - t0),
			tokPerSec: null,
			decode: {temperature: config.temperature ?? 0.7},
		})
		return {text, toolCalls}
	}
	const temperature = config.temperature ?? 0.7
	const topk = config.topk | 0
	const common = {
		stream: true,
		stream_options: {include_usage: true},
		temperature,
		...(config.topP != null ? {top_p: config.topP} : {}),
		...(config.frequencyPenalty ? {frequency_penalty: config.frequencyPenalty} : {}),
		...(config.presencePenalty ? {presence_penalty: config.presencePenalty} : {}),
		...(config.seed != null && config.seed !== "" ? {seed: config.seed} : {}),
		...(config.maxNewTokens ? {max_tokens: config.maxNewTokens} : {}),
		...(topk > 0 ? {logprobs: true, top_logprobs: topk} : {}),
	}
	const tStart = performance.now()
	let tFirst = 0
	let full = ""
	let usage = null
	let step = 0
	const stream = isText
		? await webllmEngine.completions.create({prompt: input, ...common})
		: await webllmEngine.chat.completions.create({messages: input, ...common})
	for await (const chunk of stream) {
		if (gen.abortController.signal.aborted) break
		if (chunk.usage) usage = chunk.usage
		const ch = chunk.choices?.[0]
		const delta = isText ? ch?.text : ch?.delta?.content
		const lp = ch?.logprobs?.content
		if (lp && topk > 0) {
			for (const e of lp) {
				if (step >= PREDICTION_CAP) break
				const candidates = (e.top_logprobs || []).map((/** @type {any} */ c) => ({
					token: c.token,
					p: +Math.exp(c.logprob).toFixed(4),
				}))
				if (candidates.length) post(gen, {type: "prediction", step, candidates})
				step++
			}
		}
		if (delta) {
			if (!tFirst) tFirst = performance.now()
			full += delta
			gen.fullText = full
			post(gen, {type: "token", delta, text: full})
		}
	}
	const now = performance.now()
	const genTokens = usage?.completion_tokens ?? null
	post(gen, {
		type: "stats",
		provider: "webllm",
		model: config.model,
		promptTokens: usage?.prompt_tokens ?? null,
		genTokens,
		ttftMs: tFirst ? Math.round(tFirst - tStart) : null,
		totalMs: Math.round(now - tStart),
		tokPerSec:
			tFirst && genTokens ? +(genTokens / ((now - tFirst) / 1000)).toFixed(1) : null,
		decode: {temperature, top_p: config.topP},
	})
	return {text: full, toolCalls: null}
}

/** @param {any} text @param {WorkerConfig} config */
async function predictWebLLM(text, config) {
	await ensureWebLLM(config.model, config.custom)
	const topk = Math.max(1, config.topk | 0 || 10)
	const res = await webllmEngine.completions.create({
		prompt: text || " ",
		max_tokens: 1,
		temperature: 0,
		logprobs: true,
		top_logprobs: topk,
		stream: false,
	})
	const lp = res.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs
	if (!lp) return []
	return lp
		.map((/** @type {any} */ c) => ({token: c.token, p: +Math.exp(c.logprob).toFixed(4)}))
		.sort((/** @type {any} */ a, /** @type {any} */ b) => b.p - a.p)
}

// ---------------------------------------------------------------------------
// Dispatch + lifecycle
// ---------------------------------------------------------------------------

/** @param {Gen} gen @param {AnyMsg} msg */
function post(gen, msg) {
	try {
		gen.port.postMessage({...msg, id: gen.id})
	} catch {}
}

/** @param {any} sessionKey @param {Gen} gen @param {string} text @param {any} [toolCalls] @param {string} [toolMode] */
function finalize(sessionKey, gen, text, toolCalls, toolMode) {
	gen.done = true
	gen.finalText = text
	try {
		gen.port.postMessage({type: "result", id: gen.id, text, toolCalls: toolCalls || null, toolMode})
	} catch {}
	broadcast({type: "status", message: ""})
	if (sessionKey) setTimeout(() => activeGenerations.delete(sessionKey), 5000)
}

/** @param {any} sessionKey @param {Gen} gen @param {string} message */
function fail(sessionKey, gen, message) {
	try {
		gen.port.postMessage({type: "error", id: gen.id, message})
	} catch {}
	broadcast({type: "status", message: ""})
	if (sessionKey) activeGenerations.delete(sessionKey)
}

// `input` is either chat messages (array → chat-templated) or a raw string
// (→ plain continuation, what the loom editor wants).
/** @param {any} sessionKey @param {Gen} gen @param {string} provider @param {any} input @param {WorkerConfig} config */
async function runGeneration(sessionKey, gen, provider, input, config) {
	try {
		log("runGeneration: start", {
			provider,
			model: config.model || currentModelId,
			inputKind: typeof input === "string" ? "text" : "messages",
			messages: Array.isArray(input) ? input.length : undefined,
		})
		broadcast({type: "status", message: "Thinking…"})
		let out
		if (provider === "openrouter") out = await doGenerateOpenRouter(gen, input, config)
		else if (provider === "ollama") out = await doGenerateOllama(gen, input, config)
		else if (provider === "webllm") out = await doGenerateWebLLM(gen, input, config)
		else out = await doGenerateLocal(gen, input, config)
		log("runGeneration: done", {provider, chars: out.text?.length || 0})
		finalize(
			sessionKey,
			gen,
			out.text,
			out.toolCalls,
			"toolMode" in out && typeof out.toolMode === "string" ? out.toolMode : undefined
		)
	} catch (/** @type {any} */ err) {
		if (gen.abortController.signal.aborted) {
			log("runGeneration: aborted", {provider, chars: gen.fullText?.length || 0})
			return
		}
		log("runGeneration: error", {provider, model: currentModelId, message: err?.message || String(err)})
		if (gen.fullText) finalize(sessionKey, gen, gen.fullText)
		else fail(sessionKey, gen, friendlyError(err))
	}
}

// Extract per-position features for training a LoRA adapter ON the head: ONE
// forward pass → the final hidden state h and the base logits at EVERY position,
// plus token ids. Requires a model exported with a `last_hidden_state` output
// (glomper-tuning/onnx_hidden.py); otherwise reports {supported:false}.
/** @param {Gen} gen @param {any} text */
async function extractFeaturesLocal(gen, text) {
	const model = generator.model
	const tokenizer = generator.tokenizer
	const inputs = tokenizer(text || " ", {return_tensor: true})
	const ids = Array.from(inputs.input_ids.data, Number)
	const seq = ids.length

	broadcast({type: "status", message: "Extracting features (forward pass)…"})
	const outputs = await model(inputs)
	const hs = outputs.last_hidden_state
	const lg = outputs.logits
	if (!hs || !lg) {
		post(gen, {
			type: "features",
			supported: false,
			outputKeys: Object.keys(outputs || {}),
			message: `${currentModelId} has no last_hidden_state output — needs a hidden-state export (onnx_hidden.py).`,
		})
		broadcast({type: "status", message: ""})
		return
	}
	const H = hs.dims.at(-1)
	const V = lg.dims.at(-1)
	const hidden = Float32Array.from(hs.data) // [seq*H], batch 0
	const logits = Float32Array.from(lg.data) // [seq*V], batch 0

	// char-position spans per token (skip_special_tokens), like the other passes
	const spans = []
	let prevLen = 0
	for (let i = 0; i < seq; i++) {
		const partial = tokenizer.decode(ids.slice(0, i + 1), {skip_special_tokens: true})
		if (partial.length > prevLen) spans.push({from: prevLen, to: partial.length, index: i})
		prevLen = partial.length
	}
	const decoded = tokenizer.decode(ids, {skip_special_tokens: true})
	const tokens = ids.map((/** @type {any} */ tid) => tokenizer.decode([tid]))

	post(gen, {type: "features", supported: true, seq, H, V, ids, tokens, spans, decoded, hidden, logits})
	broadcast({type: "status", message: ""})
}

// Like extractFeaturesLocal but reads the `cut_hidden` output (the residual just
// before the last block's MLP) — for rung 2 (LoRA on the last block's MLP).
// Requires a model exported with onnx_block.py.
/** @param {Gen} gen @param {any} text */
async function extractCutFeaturesLocal(gen, text) {
	const model = generator.model
	const tokenizer = generator.tokenizer
	const inputs = tokenizer(text || " ", {return_tensor: true})
	const ids = Array.from(inputs.input_ids.data, Number)
	const seq = ids.length
	broadcast({type: "status", message: "Extracting cut features (forward pass)…"})
	const outputs = await model(inputs)
	const cut = outputs.cut_hidden
	if (!cut) {
		post(gen, {
			type: "cut-features",
			supported: false,
			outputKeys: Object.keys(outputs || {}),
			message: `${currentModelId} has no cut_hidden output — needs a cut-point export (onnx_block.py).`,
		})
		broadcast({type: "status", message: ""})
		return
	}
	const d = cut.dims.at(-1)
	const hidden = Float32Array.from(cut.data) // [seq*d], batch 0
	const spans = []
	let prevLen = 0
	for (let i = 0; i < seq; i++) {
		const partial = tokenizer.decode(ids.slice(0, i + 1), {skip_special_tokens: true})
		if (partial.length > prevLen) spans.push({from: prevLen, to: partial.length, index: i})
		prevLen = partial.length
	}
	const decoded = tokenizer.decode(ids, {skip_special_tokens: true})
	const tokens = ids.map((/** @type {any} */ tid) => tokenizer.decode([tid]))
	post(gen, {type: "cut-features", supported: true, seq, d, ids, tokens, spans, decoded, hidden})
	broadcast({type: "status", message: ""})
}

/** @param {any} port @param {AnyMsg} data */
function handleMessage(port, data) {
	const {type, id} = data
	const sessionKey = data.sessionKey || id

	// If a local request asks for a dtype different from the loaded model's, drop
	// the cached generator so every handler's `!generator` guard forces a reload.
	// (Same model id, different quantization — e.g. q4f16 → q4 — still needs a
	// fresh compile.) Handled centrally so individual handlers stay simple.
	const reqDtype = data.config?.dtype
	if (generator && !loading && reqDtype && currentDtype && reqDtype !== currentDtype) {
		generator = null
	}

	if (type === "list-local-models") {
		port.postMessage({type: "local-models", models: LOCAL_MODELS})
		return
	}
	if (type === "predict") {
		handlePredict(port, data)
		return
	}
	if (type === "score-tokens") {
		const {provider, config = {}} = data
		if (provider !== "local") {
			port.postMessage({type: "token-scores", id, scores: []})
			return
		}
		const gen = {id, port, fullText: "", done: false, finalText: "", abortController: new AbortController()}
		activeGenerations.set(sessionKey, gen)
		const requested = config.model || DEFAULT_MODEL_ID
		const run = () =>
			scoreTokensLocal(gen, data.text, config)
				.then(() => { gen.done = true; activeGenerations.delete(sessionKey) })
				.catch((e) => {
					if (!gen.abortController.signal.aborted)
						port.postMessage({type: "error", id, message: e?.message || String(e)})
					activeGenerations.delete(sessionKey)
				})
		if (!generator || currentModelId !== requested) {
			if (currentModelId !== requested) releaseGenerator()
			loadModel(requested, config.dtype).then(() => {
				if (!generator) { port.postMessage({type: "error", id, message: modelLoadError()}); return }
				run()
			})
		} else run()
		return
	}
	if (type === "compute-importance") {
		const {provider, config = {}} = data
		if (provider !== "local") {
			port.postMessage({type: "importance-scores", id, scores: []})
			return
		}
		const gen = {id, port, fullText: "", done: false, finalText: "", abortController: new AbortController()}
		activeGenerations.set(sessionKey, gen)
		const requested = config.model || DEFAULT_MODEL_ID
		const run = () =>
			computeImportanceLocal(gen, data.text, config)
				.then(() => { gen.done = true; activeGenerations.delete(sessionKey) })
				.catch((e) => {
					if (!gen.abortController.signal.aborted)
						port.postMessage({type: "error", id, message: e?.message || String(e)})
					activeGenerations.delete(sessionKey)
				})
		if (!generator || currentModelId !== requested) {
			if (currentModelId !== requested) releaseGenerator()
			loadModel(requested, config.dtype).then(() => {
				if (!generator) { port.postMessage({type: "error", id, message: modelLoadError()}); return }
				run()
			})
		} else run()
		return
	}
	if (type === "compute-attention-weights") {
		const {provider, config = {}} = data
		if (provider !== "local") {
			port.postMessage({type: "attention-weights", id, supported: false})
			return
		}
		const gen = {id, port, fullText: "", done: false, finalText: "", abortController: new AbortController()}
		activeGenerations.set(sessionKey, gen)
		const requested = config.model || DEFAULT_MODEL_ID
		const run = () => {
			log("compute-attention-weights: run", {model: requested})
			return computeAttentionWeightsLocal(gen, data.text, config)
				.then(() => { gen.done = true; activeGenerations.delete(sessionKey) })
				.catch((e) => {
					const aborted = gen.abortController.signal.aborted
					// Always log the real cause — even on abort, where the client only
					// ever sees a generic AbortError and the true error would be lost.
					log("compute-attention-weights: error", {model: requested, aborted, message: e?.message || String(e)})
					if (!aborted)
						port.postMessage({type: "error", id, message: friendlyError(e)})
					activeGenerations.delete(sessionKey)
				})
		}
		if (!generator || currentModelId !== requested) {
			if (currentModelId !== requested) releaseGenerator()
			loadModel(requested, config.dtype)
				.then(() => {
					if (!generator) { port.postMessage({type: "error", id, message: modelLoadError()}); return }
					run()
				})
				.catch((e) => {
					log("compute-attention-weights: loadModel threw", {model: requested, message: e?.message || String(e)})
					port.postMessage({type: "error", id, message: friendlyError(e)})
				})
		} else run()
		return
	}
	if (type === "extract-features") {
		const {provider, config = {}} = data
		if (provider !== "local") {
			port.postMessage({type: "features", id, supported: false, message: "features require a local model"})
			return
		}
		const gen = {id, port, fullText: "", done: false, finalText: "", abortController: new AbortController()}
		activeGenerations.set(sessionKey, gen)
		const requested = config.model || DEFAULT_MODEL_ID
		const run = () => {
			log("extract-features: run", {model: requested})
			return extractFeaturesLocal(gen, data.text)
				.then(() => { gen.done = true; activeGenerations.delete(sessionKey) })
				.catch((e) => {
					const aborted = gen.abortController.signal.aborted
					log("extract-features: error", {model: requested, aborted, message: e?.message || String(e)})
					if (!aborted)
						port.postMessage({type: "error", id, message: friendlyError(e)})
					activeGenerations.delete(sessionKey)
				})
		}
		if (!generator || currentModelId !== requested) {
			if (currentModelId !== requested) releaseGenerator()
			loadModel(requested, config.dtype)
				.then(() => {
					if (!generator) { port.postMessage({type: "error", id, message: modelLoadError()}); return }
					run()
				})
				.catch((e) => {
					log("extract-features: loadModel threw", {model: requested, message: e?.message || String(e)})
					port.postMessage({type: "error", id, message: friendlyError(e)})
				})
		} else run()
		return
	}
	if (type === "extract-cut-features") {
		const {provider, config = {}} = data
		if (provider !== "local") {
			port.postMessage({type: "cut-features", id, supported: false, message: "features require a local model"})
			return
		}
		const gen = {id, port, fullText: "", done: false, finalText: "", abortController: new AbortController()}
		activeGenerations.set(sessionKey, gen)
		const requested = config.model || DEFAULT_MODEL_ID
		const run = () =>
			extractCutFeaturesLocal(gen, data.text)
				.then(() => { gen.done = true; activeGenerations.delete(sessionKey) })
				.catch((e) => {
					if (!gen.abortController.signal.aborted)
						port.postMessage({type: "error", id, message: e?.message || String(e)})
					activeGenerations.delete(sessionKey)
				})
		if (!generator || currentModelId !== requested) {
			if (currentModelId !== requested) releaseGenerator()
			loadModel(requested, config.dtype).then(() => {
				if (!generator) { port.postMessage({type: "error", id, message: modelLoadError()}); return }
				run()
			})
		} else run()
		return
	}
	if (type === "decode-tokens") {
		// Decode a list of vocab ids to their token strings (for labelling the
		// LoRA panel's next-token bars). Uses the loaded model's tokenizer.
		const run = () => {
			try {
				const tokenizer = generator.tokenizer
				const strings = (data.ids || []).map((/** @type {any} */ tid) => tokenizer.decode([tid]))
				port.postMessage({type: "decoded-tokens", id, strings})
			} catch (/** @type {any} */ e) {
				port.postMessage({type: "error", id, message: e?.message || String(e)})
			}
		}
		const requested = data.config?.model || DEFAULT_MODEL_ID
		if (!generator || currentModelId !== requested) {
			if (currentModelId !== requested) releaseGenerator()
			loadModel(requested, data.config?.dtype).then(() => generator ? run() : port.postMessage({type: "error", id, message: modelLoadError()}))
		} else run()
		return
	}
	if (type === "probe-attention") {
		// Diagnostic: try to get attention weights from the model directly.
		const run = async () => {
			const model = generator.model
			const tokenizer = generator.tokenizer
			const text = data.text || "Hello world"
			const inputs = tokenizer(text, {return_tensor: true})
			/** @type {Record<string, any>} */
			const report = {type: "probe-attention-result", id}

			// What sessions does the ONNX model have?
			/** @type {Record<string, any>} */
			const sessions = {}
			for (const [name, session] of Object.entries(model?.sessions || {})) {
				sessions[name] = {
					inputNames: /** @type {any} */ (session)?.inputNames || [],
					outputNames: /** @type {any} */ (session)?.outputNames || [],
				}
			}
			report.sessions = sessions

			// Try a direct forward pass and see what the output object contains
			try {
				const outputs = await model(inputs)
				report.outputKeys = Object.keys(outputs || {})
				report.hasAttentions = "attentions" in (outputs || {})
				// Check for attention-like keys
				report.attentionKeys = Object.keys(outputs || {}).filter(k =>
					/attention|attn/i.test(k)
				)
			} catch (/** @type {any} */ e) {
				report.forwardError = e.message
			}

			// Try calling generate with output_attentions
			try {
				const genOut = await model.generate({
					...inputs,
					max_new_tokens: 1,
					output_attentions: true,
					return_dict_in_generate: true,
				})
				report.generateKeys = Object.keys(genOut || {})
				report.generateHasAttentions = "attentions" in (genOut || {})
			} catch (/** @type {any} */ e) {
				report.generateError = e.message
			}

			port.postMessage(report)
		}
		const requested = data.config?.model || DEFAULT_MODEL_ID
		if (!generator || currentModelId !== requested) {
			loadModel(requested, data.config?.dtype).then(() => generator ? run() : port.postMessage({type: "probe-attention-result", id, error: modelLoadError()}))
		} else run()
		return
	}
	if (type === "register-local-model") {
		/** @type {Map<string, Blob>} */
		const files = new Map((data.files || []).map((/** @type {any} */ f) => [f.path, f.blob]))
		localModelFiles.set(data.id, {files, dtype: data.dtype || "q4f16"})
		ensureLocalFetchPatch()
		if (currentModelId === data.id) releaseGenerator() // force a reload (dispose old session)
		purgeCachedModel(data.id).then(() =>
			port.postMessage({type: "local-model-registered", id: data.id, count: files.size})
		)
		return
	}
	if (type === "preload") {
		if (data.provider === "local") {
			if (!generator && !loading) loadModel(data.config?.model, data.config?.dtype)
			if (generator) port.postMessage({type: "ready"})
		} else port.postMessage({type: "ready"})
		return
	}
	if (type === "resume") {
		const key = data.sessionKey
		const gen = activeGenerations.get(key)
		if (gen && !gen.done) {
			gen.port = port // re-point the live stream at the reconnecting tab
			port.postMessage({type: "resumed", id: gen.id, sessionKey: key, text: gen.fullText})
		} else if (gen && gen.done) {
			port.postMessage({type: "resume-result", id: gen.id, sessionKey: key, text: gen.finalText})
			activeGenerations.delete(key)
		} else port.postMessage({type: "no-active-generation", sessionKey: key})
		return
	}
	if (type === "abort") {
		const gen = activeGenerations.get(data.sessionKey)
		if (gen && !gen.done) {
			gen.abortController.abort()
			activeGenerations.delete(data.sessionKey)
		}
		return
	}
	if (type === "generate") {
		const {provider, config = {}} = data
		const input = data.text != null ? data.text : data.messages
		const gen = {
			id,
			port,
			fullText: "",
			done: false,
			finalText: "",
			abortController: new AbortController(),
		}
		activeGenerations.set(sessionKey, gen)
		if (provider === "local") {
			const requested = config.model || DEFAULT_MODEL_ID
			if (!generator || currentModelId !== requested) {
				if (currentModelId !== requested) releaseGenerator()
				loadModel(requested, config.dtype)
					.then(() => {
						if (!generator)
							return fail(sessionKey, gen, `Model "${requested}" failed to load (still not ready after load). Try a different local model, or check the device has enough memory.`)
						runGeneration(sessionKey, gen, provider, input, config)
					})
					.catch((e) =>
						fail(sessionKey, gen, `Couldn't load local model "${requested}": ${e?.message || e}`),
					)
			} else runGeneration(sessionKey, gen, provider, input, config)
		} else {
			runGeneration(sessionKey, gen, provider, input, config)
		}
	}
}

// SharedWorker entry — one port per connecting tab.
/** @type {any} */ (self).onconnect = (/** @type {any} */ e) => {
	const port = e.ports[0]
	ports.add(port)
	port.onmessage = (/** @type {any} */ ev) => handleMessage(port, ev.data)
	if (generator) port.postMessage({type: "ready"})
	port.start()
}

// Dedicated-Worker fallback (browsers without module SharedWorker, e.g. Safari):
// treat `self` as the single port. `self.postMessage` reaches the main thread.
if (typeof (/** @type {any} */ (self).SharedWorkerGlobalScope) === "undefined") {
	ports.add(self)
	self.onmessage = (/** @type {any} */ ev) => handleMessage(self, ev.data)
}
