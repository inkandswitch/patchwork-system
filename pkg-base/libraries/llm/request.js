/**
 * Request preparation — the transport-neutral half of a `generate` call.
 *
 * Everything between "here is a resolved config and what the caller wants" and
 * "here is the exact payload the worker understands" lives here, once: prompt
 * resolution, the flat CallConfig, the native-vs-templated tool decision, the
 * built-in (Chrome Prompt API) detour, and the chat-vs-continuation input shape.
 *
 * Two callers share it and must stay in step:
 *   - client.js `generate()` — same realm, posts straight to this library's worker.
 *   - a host-side worker spec (e.g. llm-host's worker-spec.js) — receives request
 *     frames over a stream and posts to the worker it runs.
 *
 * What is deliberately NOT here, because it is caller policy rather than
 * preparation: resolving a provider-conditional `system` map, filtering tools by
 * the user's `toolToggles`, and deciding which `overrides` reach `callConfig`
 * (client.js passes the whole opts; a host must pass only sampling knobs, since
 * callConfig also honours provider/apiKey/model/url).
 */

import {callConfig, applyPrompts} from "./config.js"
import {toToolSchemas, buildToolsSystem, resolveCfgPrompts} from "./tools.js"

/**
 * CallConfig plus the extra mutable fields tacked on per call.
 * @typedef {import("./config.js").CallConfig & {tools?:any, toolSystem?:string, continuation?:boolean}} CallConfigExt
 */

/**
 * The `generate` message the worker accepts. A string `text` is a raw
 * continuation prompt; `messages` is chat.
 * @typedef {{type:string, id:string, sessionKey:string, provider:import("./config.js").ProviderId, config:import("./config.js").CallConfig, text?:string, messages?:any}} GeneratePayload
 */

// Providers with real function-calling APIs (the worker passes tool schemas and
// parses structured tool_calls). Everything else (local transformers, Chrome
// built-in) uses the <tool_call> XML prompt convention, parsed from the text.
export const NATIVE_TOOL_PROVIDERS = new Set(["openrouter", "ollama", "webllm"])
export const TEMPLATE_TOOL_PROVIDERS = new Set(["local"])

/**
 * @typedef {Object} PrepareOpts
 * @property {any[]|string} messages   chat messages, or a string
 * @property {string} [system]         extra system prompt, already provider-resolved
 * @property {any[]} [tools]           tool descriptors, already filtered
 * @property {boolean} [continuation]  treat a string input as a raw continuation
 * @property {any} [overrides]         passed to callConfig verbatim (see header)
 *
 * @typedef {Object} PreparedGenerate
 * @property {any} cfg                 config with prompt docs resolved (`cfg.resolved`)
 * @property {CallConfigExt} config    the flat per-call config the worker receives
 * @property {string|undefined} extraSystem
 * @property {boolean} builtin         provider is "builtin": run builtinGenerate(input, …)
 *                                     in-realm instead of posting to the worker
 * @property {any} input               builtin: the pre-joined text/messages;
 *                                     otherwise applyPrompts()'d text or messages
 */

/**
 * Prepare a generate request from an unresolved config and the caller's intent.
 *
 * @param {any} cfg0  an LLMConfig (e.g. from ensureConfig), prompts not yet resolved
 * @param {PrepareOpts} opts
 * @returns {Promise<PreparedGenerate>}
 */
export async function prepareGenerate(cfg0, {messages, system, tools, continuation, overrides = {}}) {
	// Resolve the selected system/pre prompt docs → their text. repo.find is
	// cached, so this is cheap after first load.
	const cfg = await resolveCfgPrompts(cfg0)
	/** @type {CallConfigExt} */
	const config = callConfig(/** @type {any} */ (cfg), /** @type {any} */ (overrides))

	// Tools: native providers get JSON schemas on `config.tools`; the rest get the
	// <tool_call> XML convention prepended to the system prompt (parsed from text).
	const hasTools = Array.isArray(tools) && tools.length > 0
	const native = hasTools && NATIVE_TOOL_PROVIDERS.has(config.provider)
	const templated = hasTools && TEMPLATE_TOOL_PROVIDERS.has(config.provider)
	if (native || templated) config.tools = toToolSchemas(tools)
	if (templated) config.toolSystem = buildToolsSystem(tools)
	const extraSystem =
		hasTools && !native && !templated
			? [buildToolsSystem(tools), system].filter(Boolean).join("\n\n")
			: system

	// Built-in (Chrome Prompt API) runs in the caller's realm, not the worker.
	// The caller runs builtinGenerate(input, {system: effectiveSystem(cfg,
	// extraSystem), …}) with its own callbacks.
	if (config.provider === "builtin") {
		const pre = cfg.resolved?.pre || ""
		const input =
			typeof messages === "string"
				? pre
					? pre + "\n\n" + messages
					: messages
				: messages
		return {cfg, config, extraSystem, builtin: true, input}
	}

	// A string input is CHAT by default — wrapped as a user turn, so instruct/chat
	// models respond normally and the system prompt applies. It's a raw
	// CONTINUATION only when asked: raw-fed for local/webllm/ollama, and
	// CONTINUE_SYS-framed for chat-only OpenRouter (see the worker).
	const asContinuation = !!continuation && typeof messages === "string"
	const prepared = asContinuation
		? messages
		: typeof messages === "string"
			? [{role: "user", content: messages}]
			: messages
	// Prepend the configured system + pre-prompt (and any tool-supplied system).
	const input = applyPrompts(prepared, /** @type {any} */ (cfg), extraSystem)
	return {cfg, config, extraSystem, builtin: false, input}
}

/**
 * The `generate` message for the worker, from a prepared request.
 *
 * @param {CallConfigExt} config
 * @param {any} input  string (raw continuation) or chat messages
 * @param {{id: string, sessionKey: string}} ids
 * @returns {GeneratePayload}
 */
export function buildGeneratePayload(config, input, {id, sessionKey}) {
	/** @type {GeneratePayload} */
	const payload = {type: "generate", id, sessionKey, provider: config.provider, config}
	if (typeof input === "string") payload.text = input
	else payload.messages = input
	return payload
}
