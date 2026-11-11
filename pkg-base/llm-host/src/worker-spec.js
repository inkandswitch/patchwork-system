/**
 * The serve half of the LLM protocol: a WorkerSpec that @grjte/patchwork-worker
 * serves in the host realm, over @chee/patchwork-llm's compute worker.
 *
 * Config and the API key are resolved here from the frame's `scope` and never
 * leave the host. Request preparation is the library's own `prepareGenerate`, so
 * this path can't drift from the library's same-realm `generate()`. What's added
 * here is host policy: which overrides a consumer may set, provider-conditional
 * system prompts, `toolToggles`, the user's own tools, and turning model output
 * into `toolCalls` so consumers never parse it.
 *
 * Consumers only ever see the tool names they declared. Providers need names
 * matching [a-zA-Z0-9_-]{1,64}, so names are sanitized on the way in (including
 * in `tool_calls` the consumer threads back) and mapped back on the way out.
 *
 * `lib` is passed in because llm-host loads the library from its automerge doc
 * at runtime.
 */

/**
 * `system` is a string, or a map like `{default, local, openrouter}` where the
 * provider's entry wins.
 * @param {any} system
 * @param {string} provider
 */
function systemFor(system, provider) {
	if (system == null || typeof system === "string") return system ?? undefined
	return system[provider] ?? system.default ?? undefined
}

/**
 * A tool is offered unless toggled off; a `defaultOff` tool only if toggled on.
 * @param {any[]|undefined} tools
 * @param {Record<string, boolean>} [toggles]
 */
function enabledTools(tools, toggles = {}) {
	if (!Array.isArray(tools)) return []
	return tools.filter((tool) => (tool.defaultOff ? toggles[tool.name] === true : toggles[tool.name] !== false))
}

/** @param {any} lib */
export function makeLLMWorkerSpec(lib) {
	const {sanitizeToolName} = lib

	// "provider:model" pairs that rejected native tool calling. Their later
	// requests describe the tools in the system prompt instead.
	const noNativeTools = new Set()

	/** @type {Promise<any[]>|null} */
	let openrouterModels = null
	/** Human-readable model label; never includes secrets. @param {any} cfg */
	async function modelLabel(cfg) {
		try {
			if (cfg.provider === "openrouter") openrouterModels ??= lib.fetchOpenRouterModels().catch(() => [])
			return lib.describeConfig(cfg, {openrouterModels: (await openrouterModels) || []})
		} catch {
			return "the configured model"
		}
	}

	/**
	 * Config comes from `frame.scope` only. A consumer-supplied `frame.config`
	 * would let a tool choose the provider and its own key.
	 * @param {any} frame
	 * @param {Promise<any>|null} settingsWarm
	 */
	async function resolveCfg0(frame, settingsWarm) {
		if (settingsWarm) await settingsWarm
		// ensureConfig quietly falls back to defaults (and an empty API key) when
		// the settings doc isn't loaded yet, e.g. when the warm timed out.
		if (!lib.settingsDocHandle()) await lib.ensureSettingsDoc()
		return lib.ensureConfig(frame.scope)
	}

	/**
	 * callConfig also honours provider / apiKey / model / url overrides, so only
	 * the sampling knobs a consumer owns are passed through.
	 * @param {any} frame
	 */
	function samplingOverrides(frame) {
		return {
			temperature: frame.temperature,
			topP: frame.topP,
			topk: frame.topk,
			maxNewTokens: frame.maxNewTokens,
		}
	}

	/** @param {any} frame @param {Promise<any>|null} settingsWarm */
	async function resolveForFrame(frame, settingsWarm) {
		const cfg = await lib.resolveCfgPrompts(await resolveCfg0(frame, settingsWarm))
		return {cfg, config: lib.callConfig(cfg, samplingOverrides(frame))}
	}

	/**
	 * The consumer's enabled tools, then (when `frame.userTools`) the user's own
	 * `llm:tool` docs, tagged `host`. A consumer tool wins a name clash.
	 * @param {any} frame
	 * @param {any} cfg0
	 */
	async function toolsFor(frame, cfg0) {
		const tools = enabledTools(frame.tools, cfg0.toolToggles).map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}))
		if (!frame.userTools) return tools
		const taken = new Set(tools.map((t) => sanitizeToolName(t.name)))
		for (const t of await lib.resolveTools(cfg0)) {
			if (taken.has(sanitizeToolName(t.name))) continue
			taken.add(sanitizeToolName(t.name))
			tools.push({name: t.name, description: t.description, parameters: t.parameters, host: true})
		}
		return tools
	}

	/** @param {any[]} tools @param {string} name */
	function findTool(tools, name) {
		return tools.find((t) => t.name === name) ?? tools.find((t) => sanitizeToolName(t.name) === name)
	}

	/**
	 * Sanitize tool names in `tool_calls` the consumer threads back.
	 * @param {any} messages
	 */
	function wireNames(messages) {
		if (!Array.isArray(messages)) return messages
		return messages.map((m) =>
			Array.isArray(m?.tool_calls)
				? {
						...m,
						tool_calls: m.tool_calls.map((/** @type {any} */ c) =>
							c?.function ? {...c, function: {...c.function, name: sanitizeToolName(c.function.name)}} : c
						),
					}
				: m
		)
	}

	/**
	 * `toolCalls` and `toolMode` for a result. Structured calls come from native
	 * function calling. Otherwise the text is parsed, keeping only calls to
	 * offered tools, since prose can contain JSON that merely looks like a call.
	 * `toolMode` says how to thread the results back: "native", "template" or
	 * "text".
	 * @param {any} msg  {text, toolCalls, toolMode} from the worker
	 * @param {any[]} tools
	 */
	function toolCallsFor(msg, tools) {
		if (!tools.length) return {toolCalls: null, toolMode: msg.toolMode}
		const structured = Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0
		const raw = structured ? msg.toolCalls : lib.parseToolCalls(msg.text || "")
		const calls = []
		for (const call of raw) {
			const tool = findTool(tools, call.name)
			if (!tool && !structured) continue
			calls.push({...call, name: tool?.name ?? call.name, ...(tool?.host ? {host: true} : {})})
		}
		return {
			toolCalls: calls.length ? calls : null,
			toolMode: structured ? "native" : msg.toolMode === "template" ? "template" : "text",
		}
	}

	return {
		createWorker: lib.createWorker,

		/**
		 * Warm the settings doc. `ctx.element` reaches the tool-storage provider;
		 * the transport bounds this with a timeout.
		 * @param {{element?: HTMLElement}} ctx
		 */
		open(ctx) {
			return ctx.element ? Promise.resolve(lib.ensureSettingsDoc(ctx.element)).catch(() => null) : null
		},

		/**
		 * @param {any} frame
		 * @param {any} io  @grjte/patchwork-worker's IO: {post, emit, on, workerId, state}
		 */
		async handle(frame, io) {
			const {post, emit, on, workerId, state: settingsWarm} = io
			const op = frame.op
			const sessionKey = frame.sessionKey || workerId

			if (op === "generate") {
				const cfg0 = await resolveCfg0(frame, settingsWarm)
				const tools = await toolsFor(frame, cfg0)
				const system = systemFor(frame.system, cfg0.provider)
				const base = {
					messages: frame.text != null ? frame.text : wireNames(frame.messages),
					// A continuation is a raw string prompt with no chat messages.
					continuation: !!frame.continuation && frame.messages === undefined,
					overrides: samplingOverrides(frame),
				}
				const withTools = () => lib.prepareGenerate(cfg0, {...base, system, tools})
				const toolsInPrompt = () =>
					lib.prepareGenerate(cfg0, {
						...base,
						system: [lib.buildToolsSystem(tools), system].filter(Boolean).join("\n\n"),
					})

				let prepared = await withTools()
				const {cfg, config} = prepared
				const modelKey = `${config.provider}:${config.model}`
				let native = tools.length > 0 && lib.NATIVE_TOOL_PROVIDERS.has(config.provider)
				if (native && noNativeTools.has(modelKey)) {
					prepared = await toolsInPrompt()
					native = false
				}
				// If the model rejects native tools, retry once with them in the prompt.
				const fallback = native ? await toolsInPrompt() : null

				void modelLabel(cfg).then((label) => emit({type: "model", label}))

				// builtin (Chrome Prompt API) runs in this realm, not in the worker. It
				// can't be aborted: the transport only routes op:"abort" to requests
				// tracked with `on`, which needs a worker message to finish.
				if (prepared.builtin) {
					try {
						const text = await lib.builtinGenerate(prepared.input, {
							temperature: config.temperature,
							topK: config.topK,
							system: lib.effectiveSystem(cfg, prepared.extraSystem),
							onToken: (/** @type {string} */ _delta, /** @type {string} */ full) =>
								emit({type: "token", delta: "", text: full}),
							onStatus: (/** @type {string} */ message) => emit({type: "status", message}),
						})
						emit({type: "result", text, ...toolCallsFor({text}, tools)})
					} catch (e) {
						emit({type: "error", message: /** @type {any} */ (e)?.message || String(e)})
					}
					return {sessionKey}
				}

				const send = (/** @type {any} */ p) =>
					post(lib.buildGeneratePayload(p.config, p.input, {id: workerId, sessionKey}))
				let streamed = false
				let fellBack = false
				on((msg) => {
					switch (msg.type) {
						case "token":
							streamed = true
							emit(msg)
							return false
						case "prediction":
						case "stats":
							emit(msg)
							return false
						case "result":
							if (fellBack) noNativeTools.add(modelKey)
							emit({...msg, ...toolCallsFor(msg, tools)})
							return true
						case "error":
							if (fallback && !streamed && !fellBack) {
								fellBack = true
								send(fallback)
								return false
							}
							emit(msg)
							return true
					}
					return false
				})
				send(prepared)
				return {sessionKey}
			}

			// Runs one of the user's own tools (a call the result tagged `host`).
			// Always sandboxed: the caller may itself be a sandboxed tool, and must
			// not get page access through us.
			if (op === "run-tool") {
				const cfg0 = await resolveCfg0(frame, settingsWarm)
				const tool = findTool(await lib.resolveTools(cfg0), frame.name)
				if (!tool) throw new Error(`no tool named "${frame.name}"`)
				const result = await lib.runTool(tool, frame.args, {sandbox: true})
				emit({type: "tool-result", result})
				return {sessionKey}
			}

			if (op === "predict") {
				const {cfg, config} = await resolveForFrame(frame, settingsWarm)
				config.continuation = !!frame.continuation
				if (config.provider === "builtin") {
					emit({type: "predictions", candidates: []})
					return {sessionKey}
				}
				on((msg) => {
					if (msg.type !== "predictions" && msg.type !== "error") return false
					emit(msg)
					return true
				})
				post({
					type: "predict",
					id: workerId,
					sessionKey,
					provider: config.provider,
					text: lib.applyPrompts(frame.text, cfg, systemFor(frame.system, config.provider)),
					config,
				})
				return {sessionKey}
			}

			// Local-only analysis ops: op -> [terminal type, optional progress type].
			/** @type {Record<string, string[]>} */
			const analytical = {
				"score-tokens": ["token-scores", "score-progress"],
				"compute-importance": ["importance-scores"],
				"compute-attention-weights": ["attention-weights"],
				"extract-features": ["features"],
				"extract-cut-features": ["cut-features"],
				"decode-tokens": ["decoded-tokens"],
				"probe-attention": ["probe-attention-result"],
			}
			if (analytical[op]) {
				const {config} = await resolveForFrame(frame, settingsWarm)
				const [terminal, progress] = analytical[op]
				on((msg) => {
					if (msg.type === progress) emit(msg)
					if (msg.type !== terminal && msg.type !== "error") return false
					emit(msg)
					return true
				})
				/** @type {any} */
				const payload = {type: op, id: workerId, sessionKey, provider: config.provider, config}
				if (frame.text != null) payload.text = frame.text
				if (frame.ids != null) payload.ids = frame.ids
				post(payload)
				return {sessionKey}
			}

			if (op === "preload") {
				const {config} = await resolveForFrame(frame, settingsWarm)
				post({type: "preload", provider: config.provider, config})
			}
			return {sessionKey}
		},

		/**
		 * The worker keys in-flight generations by sessionKey.
		 * @param {{sessionKey: string}} token
		 * @param {(m: any) => void} post
		 */
		abort(token, post) {
			post({type: "abort", sessionKey: token.sessionKey})
		},
	}
}
