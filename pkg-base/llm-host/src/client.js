/**
 * The consume half of the LLM protocol, the mirror of worker-spec.js.
 *
 * Tools don't import this. index.ts registers `makeLLMClient` as the
 * `patchwork:worker-client` plugin "llm", and a tool calls
 * `connectWorkerClient("llm", …)` from @grjte/patchwork-worker to get one bound
 * to a session.
 *
 * This is the chunk a sandboxed tool loads, so it must import nothing: never
 * @chee/patchwork-llm, never ./worker-spec.js.
 *
 * Frames:
 *   generate  {op, scope, system, tools, userTools, messages|text, sessionKey}
 *             -> token | status | model | stats | prediction ... result | error
 *   run-tool  {op, scope, name, args} -> tool-result | error
 */

/**
 * @typedef {Object} Tool
 * @property {string} name
 * @property {string} [description]
 * @property {any} [parameters]      JSON Schema for the arguments
 * @property {boolean} [defaultOff]  only offered once the user turns it on
 * @property {(args: any) => any} [handler]  generateWithTools runs this; never sent
 *
 * @typedef {Object} ToolCall
 * @property {string} name     as declared in `tools`
 * @property {any} args
 * @property {string} [id]
 * @property {boolean} [host]  one of the user's own tools: run it with `runTool`
 *
 * @typedef {Object} GenOpts
 * @property {any} [scope]  {toolId, docId}; the host resolves config for it
 * @property {string|Record<string,string>} [system]  a string, or {default, [provider]}
 * @property {Tool[]} [tools]
 * @property {boolean} [userTools]  also offer the user's own tools (host-run)
 * @property {string} [sessionKey]
 * @property {HTMLElement} [element]  a node in the mounted <patchwork-view>, for discovery
 * @property {AbortSignal} [signal]
 * @property {(delta: string, full: string, round?: number) => void} [onToken]
 * @property {(message: string) => void} [onStatus]
 * @property {(label: string) => void} [onModel]
 *
 * @typedef {Object} GenResult
 * @property {string} text
 * @property {ToolCall[]|null} toolCalls
 * @property {"native"|"template"|"text"} [toolMode]  how to thread results back
 *
 * @typedef {GenOpts & {
 *   maxRounds?: number,
 *   onToolCall?: (info: {name: string, args: any, result?: any, error?: string}) => void,
 * }} ToolLoopOpts
 */

/** @param {{request: (frame: any, opts: any) => {promise: Promise<any>}}} session */
export function makeLLMClient(session) {
	/**
	 * Generate a completion. Streams tokens via `onToken` and resolves with the
	 * text and any tool calls. Running the calls is up to the caller; see
	 * generateWithTools.
	 * @param {any[]|string} messages
	 * @param {GenOpts} [opts]
	 * @returns {Promise<GenResult>}
	 */
	function generate(messages, opts = {}) {
		const {promise} = session.request(
			{
				op: "generate",
				sessionKey: opts.sessionKey,
				scope: opts.scope,
				system: opts.system,
				// Handlers can't be structured-cloned across the isolation boundary.
				tools: opts.tools?.map(({name, description, parameters, defaultOff}) => ({
					name,
					description,
					parameters,
					defaultOff,
				})),
				userTools: opts.userTools,
				...(typeof messages === "string" ? {text: messages} : {messages}),
			},
			{
				element: opts.element,
				signal: opts.signal,
				terminal: {
					result: (/** @type {any} */ f) => ({text: f.text, toolCalls: f.toolCalls || null, toolMode: f.toolMode}),
					error: (/** @type {any} */ f) => {
						throw new Error(f.message)
					},
				},
				onFrame: (/** @type {any} */ f) => {
					if (f.type === "token") opts.onToken?.(f.delta, f.text)
					else if (f.type === "status") opts.onStatus?.(f.message)
					else if (f.type === "model") opts.onModel?.(f.label)
				},
			}
		)
		return promise
	}

	/**
	 * Run one of the user's own tools (a call tagged `host`). It runs on the
	 * host, sandboxed.
	 * @param {ToolCall} call
	 * @param {Pick<GenOpts, "scope"|"element"|"signal">} [opts]
	 */
	function runTool(call, opts = {}) {
		return session.request(
			{op: "run-tool", scope: opts.scope, name: call.name, args: call.args},
			{
				element: opts.element,
				signal: opts.signal,
				terminal: {
					"tool-result": (/** @type {any} */ f) => f.result,
					error: (/** @type {any} */ f) => {
						throw new Error(f.message)
					},
				},
			}
		).promise
	}

	/**
	 * Generate, run the tool calls, feed the results back and generate again,
	 * until the model stops calling tools or `maxRounds` (default 6) runs out.
	 * Calls to `tools` run their `handler` here; the user's own tools are offered
	 * too and run on the host.
	 * @param {any[]|string} messages
	 * @param {ToolLoopOpts} [opts]
	 * @returns {Promise<{text: string, messages: any[]}>}
	 */
	async function generateWithTools(messages, opts = {}) {
		const {maxRounds = 6, onToolCall, onToken, ...genOpts} = opts
		const tools = opts.tools || []
		const convo = typeof messages === "string" ? [{role: "user", content: messages}] : [...messages]

		/** @param {ToolCall} call @returns {Promise<string>} */
		async function run(call) {
			const {name, args} = call
			try {
				let result
				if (call.host) result = await runTool(call, opts)
				else {
					const handler = tools.find((t) => t.name === name)?.handler
					if (!handler) throw new Error(`no tool named "${name}"`)
					result = await handler(args || {})
				}
				onToolCall?.({name, args, result})
				return typeof result === "string" ? result : (JSON.stringify(result) ?? "")
			} catch (e) {
				const error = /** @type {any} */ (e)?.message || String(e)
				onToolCall?.({name, args, error})
				return "Error: " + error
			}
		}

		let text = ""
		for (let round = 0; round < maxRounds; round++) {
			const res = await generate(convo, {
				...genOpts,
				userTools: genOpts.userTools ?? true,
				onToken: onToken && ((delta, full) => onToken(delta, full, round)),
			})
			text = res.text
			if (!res.toolCalls) break
			const calls = res.toolCalls.map((call, i) => ({...call, id: call.id || `call_${round}_${i}`}))
			const results = []
			for (const call of calls) results.push(await run(call))
			convo.push(...threadResults(res, calls, results))
		}
		return {text, messages: convo}
	}

	return {generate, generateWithTools, runTool}
}

/**
 * The messages that carry one round's tool calls and results back to the
 * model, in the shape its `toolMode` expects.
 * @param {GenResult} res
 * @param {(ToolCall & {id: string})[]} calls
 * @param {string[]} results
 */
function threadResults(res, calls, results) {
	if (res.toolMode === "native")
		return [
			{
				role: "assistant",
				content: res.text || null,
				tool_calls: calls.map((c) => ({
					id: c.id,
					type: "function",
					function: {name: c.name, arguments: JSON.stringify(c.args || {})},
				})),
			},
			...calls.map((c, i) => ({role: "tool", tool_call_id: c.id, content: results[i]})),
		]
	if (res.toolMode === "template")
		return [
			{
				role: "assistant",
				content: "",
				tool_calls: calls.map((c) => ({type: "function", function: {name: c.name, arguments: c.args || {}}})),
			},
			...results.map((content) => ({role: "tool", content})),
		]
	return [
		{role: "assistant", content: res.text},
		...calls.map((c, i) => ({role: "user", content: `Tool "${c.name}" returned:\n${results[i]}`})),
	]
}
