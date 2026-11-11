/**
 * Chrome built-in AI (the Prompt API — on-device Gemini Nano).
 *
 * Runs on the MAIN thread: the `LanguageModel` global is a window API, not a
 * worker one, so this path bypasses the SharedWorker. No next-token logprobs are
 * exposed, so `predict()` (the typing popup) doesn't work with built-in —
 * generation + streaming do.
 */

function getLM() {
	if (typeof self === "undefined") return null
	return self.LanguageModel || (self.ai && self.ai.languageModel) || null
}

/** Is the Prompt API present at all (i.e. show the option)? */
export function builtinSupported() {
	return !!getLM()
}

/** "available" | "downloadable" | "downloading" | "unavailable" */
export async function builtinAvailability() {
	const LM = getLM()
	if (!LM) return "unavailable"
	try {
		if (LM.availability) return await LM.availability()
		if (LM.capabilities) {
			const c = await LM.capabilities()
			return c?.available === "readily"
				? "available"
				: c?.available === "after-download"
					? "downloadable"
					: "unavailable"
		}
	} catch {}
	return "unavailable"
}

/** @param {import("./config.js").ChatMessage[]} messages */
function messagesToText(messages) {
	return messages
		.filter((m) => m.role !== "system")
		.map((m) => m.content)
		.join("\n\n")
}

/** @param {ReadableStream<any>} stream */
async function* readStream(stream) {
	const reader = stream.getReader()
	try {
		while (true) {
			const {done, value} = await reader.read()
			if (done) break
			yield value
		}
	} finally {
		try {
			reader.releaseLock()
		} catch {}
	}
}

/**
 * @typedef {Object} BuiltinOpts
 * @property {number} [temperature]
 * @property {number} [topK]
 * @property {string} [system]
 * @property {(delta: string, full: string) => void} [onToken]
 * @property {(status: string) => void} [onStatus]
 * @property {AbortSignal} [signal]
 */

/**
 * Generate via the Prompt API. `onToken(delta, full)` per chunk; returns full
 * text. Handles both the old (cumulative chunk) and new (delta chunk) shapes.
 * @param {string|import("./config.js").ChatMessage[]} input
 * @param {BuiltinOpts} [opts]
 */
export async function builtinGenerate(input, opts = {}) {
	const {temperature, topK, system, onToken, onStatus, signal} = opts
	const LM = getLM()
	if (!LM)
		throw new Error(
			"Built-in AI isn't available here (needs Chrome with the Prompt API)."
		)
	/** @type {any} */
	const createOpts = {}
	if (typeof temperature === "number") {
		createOpts.temperature = Math.min(2, Math.max(0, temperature))
		createOpts.topK = topK && topK > 0 ? topK : 8 // Prompt API needs topK alongside temperature
	}
	if (system) createOpts.initialPrompts = [{role: "system", content: system}]
	createOpts.monitor = (/** @type {any} */ m) => {
		try {
			m.addEventListener("downloadprogress", (/** @type {any} */ e) =>
				onStatus?.(
					"Downloading built-in model… " + Math.round((e.loaded || 0) * 100) + "%"
				)
			)
		} catch {}
	}
	let session
	try {
		session = await LM.create(createOpts)
	} catch {
		// retry without sampling params (version differences)
		session = await LM.create(system ? {initialPrompts: createOpts.initialPrompts} : {})
	}
	try {
		const text = typeof input === "string" ? input : messagesToText(input)
		let full = ""
		if (session.promptStreaming) {
			const stream = session.promptStreaming(text, signal ? {signal} : undefined)
			for await (const chunk of readStream(stream)) {
				if (typeof chunk !== "string") continue
				let delta
				if (chunk.startsWith(full)) {
					delta = chunk.slice(full.length)
					full = chunk
				} else {
					delta = chunk
					full += chunk
				}
				if (delta) onToken?.(delta, full)
			}
		} else {
			full = await session.prompt(text)
			onToken?.(full, full)
		}
		return full
	} finally {
		try {
			session.destroy?.()
		} catch {}
	}
}
