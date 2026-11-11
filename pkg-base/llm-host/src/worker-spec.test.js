import {describe, it, expect, vi, beforeEach} from "vitest"
import {makeLLMWorkerSpec} from "./worker-spec.js"

/**
 * Just enough of @chee/patchwork-llm for the spec's host policy to be
 * observable. `prepareGenerate` echoes what it was given.
 */
function fakeLib(cfg = {provider: "local", toolToggles: {}}) {
	return {
		createWorker: () => ({}),
		ensureConfig: vi.fn(async () => cfg),
		ensureSettingsDoc: vi.fn(async () => ({})),
		settingsDocHandle: () => ({}),
		callConfig: (c, o) => ({provider: c.provider, ...o}),
		applyPrompts: (input) => input,
		effectiveSystem: () => "",
		describeConfig: () => "Model",
		fetchOpenRouterModels: async () => [],
		builtinGenerate: vi.fn(async () => "built-in text"),
		resolveCfgPrompts: async (c) => c,
		prepareGenerate: vi.fn(async (cfg0, opts) => ({
			cfg: cfg0,
			config: {provider: cfg0.provider, model: "m", ...opts.overrides, ...(opts.tools ? {tools: opts.tools} : {})},
			extraSystem: opts.system,
			builtin: cfg0.provider === "builtin",
			input: opts.messages,
		})),
		buildGeneratePayload: (config, input, ids) => ({type: "generate", ...ids, provider: config.provider, config, messages: input}),
		parseToolCalls: vi.fn((text) => {
			const m = /<tool_call>(.*?)<\/tool_call>/.exec(text)
			return m ? [JSON.parse(m[1])] : []
		}),
		buildToolsSystem: (tools) => "TOOLS: " + tools.map((t) => t.name).join(","),
		sanitizeToolName: (name) => name.replace(/[^a-zA-Z0-9_-]/g, "_"),
		NATIVE_TOOL_PROVIDERS: new Set(["openrouter", "ollama", "webllm"]),
		resolveTools: vi.fn(async () => []),
		runTool: vi.fn(async () => "ran"),
	}
}

function fakeIO() {
	/** @type {any} */
	const io = {
		post: vi.fn(),
		emit: vi.fn(),
		handler: null,
		on: (fn) => {
			io.handler = fn
		},
		workerId: "w1",
		state: null,
	}
	return io
}

const emitted = (io, type) => io.emit.mock.calls.map((c) => c[0]).filter((f) => f.type === type)
const flush = () => new Promise((r) => setTimeout(r, 0))

describe("makeLLMWorkerSpec · generate", () => {
	let lib, spec, io
	beforeEach(() => {
		lib = fakeLib()
		spec = makeLLMWorkerSpec(lib)
		io = fakeIO()
	})

	it("parses <tool_call> text host-side when the request offered tools", async () => {
		await spec.handle({op: "generate", messages: [{role: "user", content: "hi"}], tools: [{name: "x"}]}, io)
		io.handler({type: "result", text: '<tool_call>{"name":"x","args":{}}</tool_call>', toolCalls: null, toolMode: "template"})
		const [result] = emitted(io, "result")
		expect(result.toolCalls).toEqual([{name: "x", args: {}}])
		expect(result.toolMode).toBe("template")
	})

	it("drops parsed calls to tools that weren't offered", async () => {
		await spec.handle({op: "generate", messages: [], tools: [{name: "x"}]}, io)
		io.handler({type: "result", text: '<tool_call>{"name":"my-package","version":"1.0.0"}</tool_call>', toolCalls: null})
		const [result] = emitted(io, "result")
		expect(result.toolCalls).toBeNull()
		expect(result.toolMode).toBe("text")
	})

	it("marks structured calls native and maps sanitized names back to the declared ones", async () => {
		await spec.handle({op: "generate", messages: [], tools: [{name: "read doc"}]}, io)
		io.handler({type: "result", text: "", toolCalls: [{id: "c1", name: "read_doc", args: {a: 1}}, {id: "c2", name: "nope", args: {}}]})
		const [result] = emitted(io, "result")
		expect(result.toolMode).toBe("native")
		// An unknown structured call is still a real call; the caller reports the error to the model.
		expect(result.toolCalls).toEqual([
			{id: "c1", name: "read doc", args: {a: 1}},
			{id: "c2", name: "nope", args: {}},
		])
		expect(lib.parseToolCalls).not.toHaveBeenCalled()
	})

	it("sanitizes tool names in tool_calls the consumer threads back", async () => {
		const messages = [{role: "assistant", content: null, tool_calls: [{id: "c1", type: "function", function: {name: "read doc", arguments: "{}"}}]}]
		await spec.handle({op: "generate", messages, tools: [{name: "read doc"}]}, io)
		const [, opts] = lib.prepareGenerate.mock.calls[0]
		expect(opts.messages[0].tool_calls[0].function.name).toBe("read_doc")
		expect(messages[0].tool_calls[0].function.name).toBe("read doc")
	})

	it("does not parse prose when no tools were offered", async () => {
		await spec.handle({op: "generate", messages: []}, io)
		io.handler({type: "result", text: '<tool_call>{"name":"x"}</tool_call>', toolCalls: null})
		const [result] = emitted(io, "result")
		expect(result.toolCalls).toBeNull()
		expect(lib.parseToolCalls).not.toHaveBeenCalled()
	})

	it("forwards only sampling overrides, never provider / apiKey / model / url", async () => {
		await spec.handle(
			{
				op: "generate",
				messages: [],
				temperature: 0.2,
				topP: 0.9,
				provider: "openrouter",
				apiKey: "sk-evil",
				model: "gpt",
				url: "https://attacker",
				config: {apiKey: "sk-evil"},
			},
			io
		)
		const [, opts] = lib.prepareGenerate.mock.calls[0]
		expect(opts.overrides).toEqual({temperature: 0.2, topP: 0.9, topk: undefined, maxNewTokens: undefined})
	})

	it("applies the provider-conditional system map and toolToggles, and sends only descriptors", async () => {
		lib = fakeLib({provider: "local", toolToggles: {off: false, optin: true}})
		spec = makeLLMWorkerSpec(lib)
		await spec.handle(
			{
				op: "generate",
				messages: [],
				system: {default: "d", local: "L"},
				tools: [
					{name: "on", description: "d", parameters: {}, extra: 1},
					{name: "off"},
					{name: "optin", defaultOff: true},
					{name: "hidden", defaultOff: true},
				],
			},
			io
		)
		const [, opts] = lib.prepareGenerate.mock.calls[0]
		expect(opts.system).toBe("L")
		expect(opts.tools.map((t) => t.name)).toEqual(["on", "optin"])
		expect(opts.tools[0]).toEqual({name: "on", description: "d", parameters: {}})
	})

	it("posts the library-built payload tagged with the transport's workerId", async () => {
		const token = await spec.handle({op: "generate", messages: [{role: "user", content: "hi"}], sessionKey: "s1"}, io)
		expect(token).toEqual({sessionKey: "s1"})
		expect(io.post).toHaveBeenCalledWith(
			expect.objectContaining({type: "generate", id: "w1", sessionKey: "s1", messages: [{role: "user", content: "hi"}]})
		)
	})

	it("runs builtin in-realm and still fills toolCalls", async () => {
		lib = fakeLib({provider: "builtin", toolToggles: {}})
		lib.builtinGenerate = vi.fn(async () => '<tool_call>{"name":"x","args":{}}</tool_call>')
		spec = makeLLMWorkerSpec(lib)
		await spec.handle({op: "generate", messages: [], tools: [{name: "x"}]}, io)
		await flush()
		expect(io.post).not.toHaveBeenCalled()
		const [result] = emitted(io, "result")
		expect(result.toolCalls).toEqual([{name: "x", args: {}}])
		expect(result.toolMode).toBe("text")
	})
})

describe("makeLLMWorkerSpec · the user's own tools", () => {
	let lib, spec, io
	beforeEach(() => {
		lib = fakeLib()
		lib.resolveTools = vi.fn(async () => [
			{url: "u1", name: "Weather now", description: "w", parameters: {type: "object"}, handlerUrl: "h1"},
			{url: "u2", name: "x", description: "clash", handlerUrl: "h2"},
		])
		spec = makeLLMWorkerSpec(lib)
		io = fakeIO()
	})

	it("are offered only when the request asks for them", async () => {
		await spec.handle({op: "generate", messages: [], tools: [{name: "x"}]}, io)
		expect(lib.prepareGenerate.mock.calls[0][1].tools.map((t) => t.name)).toEqual(["x"])
	})

	it("are appended after the consumer's tools, which win a name clash", async () => {
		await spec.handle({op: "generate", messages: [], tools: [{name: "x"}], userTools: true}, io)
		const [, opts] = lib.prepareGenerate.mock.calls[0]
		expect(opts.tools).toEqual([
			{name: "x", description: undefined, parameters: undefined},
			{name: "Weather now", description: "w", parameters: {type: "object"}, host: true},
		])
	})

	it("come back tagged `host`", async () => {
		await spec.handle({op: "generate", messages: [], tools: [{name: "x"}], userTools: true}, io)
		io.handler({type: "result", text: "", toolCalls: [{id: "c1", name: "Weather_now", args: {}}, {id: "c2", name: "x", args: {}}]})
		const [result] = emitted(io, "result")
		expect(result.toolCalls).toEqual([
			{id: "c1", name: "Weather now", args: {}, host: true},
			{id: "c2", name: "x", args: {}},
		])
	})

	it("run on the host, always sandboxed", async () => {
		await spec.handle({op: "run-tool", name: "Weather_now", args: {city: "x"}}, io)
		expect(lib.runTool).toHaveBeenCalledWith(expect.objectContaining({handlerUrl: "h1"}), {city: "x"}, {sandbox: true})
		expect(emitted(io, "tool-result")).toEqual([{type: "tool-result", result: "ran"}])
	})

	it("reject a run-tool for a tool that doesn't exist", async () => {
		await expect(spec.handle({op: "run-tool", name: "nope", args: {}}, io)).rejects.toThrow('no tool named "nope"')
		expect(lib.runTool).not.toHaveBeenCalled()
	})
})

describe("makeLLMWorkerSpec · native tool fallback", () => {
	let lib, spec, io
	beforeEach(() => {
		lib = fakeLib({provider: "openrouter", toolToggles: {}})
		spec = makeLLMWorkerSpec(lib)
		io = fakeIO()
	})

	const generate = (io) => spec.handle({op: "generate", messages: [], tools: [{name: "x"}], system: "s"}, io)

	it("retries once with the tools in the system prompt when native tools are rejected", async () => {
		await generate(io)
		expect(io.post.mock.calls[0][0].config.tools).toBeDefined()
		expect(io.handler({type: "error", message: "No endpoints found that support tool use"})).toBe(false)
		expect(io.post).toHaveBeenCalledTimes(2)
		const retry = io.post.mock.calls[1][0]
		expect(retry.config.tools).toBeUndefined()
		expect(lib.prepareGenerate.mock.calls.at(-1)[1].system).toBe("TOOLS: x\n\ns")
		expect(emitted(io, "error")).toEqual([])

		io.handler({type: "result", text: '<tool_call>{"name":"x","args":{}}</tool_call>', toolCalls: null})
		const [result] = emitted(io, "result")
		expect(result.toolCalls).toEqual([{name: "x", args: {}}])
		expect(result.toolMode).toBe("text")

		// Remembered for the model: the next request goes straight to the prompt.
		const io2 = fakeIO()
		await generate(io2)
		expect(io2.post.mock.calls[0][0].config.tools).toBeUndefined()
	})

	it("doesn't retry once tokens have streamed", async () => {
		await generate(io)
		io.handler({type: "token", delta: "a", text: "a"})
		expect(io.handler({type: "error", message: "boom"})).toBe(true)
		expect(io.post).toHaveBeenCalledTimes(1)
		expect(emitted(io, "error")).toEqual([{type: "error", message: "boom"}])
	})

	it("doesn't remember the model when the retry fails too", async () => {
		await generate(io)
		io.handler({type: "error", message: "401"})
		expect(io.handler({type: "error", message: "401"})).toBe(true)
		expect(emitted(io, "error")).toEqual([{type: "error", message: "401"}])

		const io2 = fakeIO()
		await generate(io2)
		expect(io2.post.mock.calls[0][0].config.tools).toBeDefined()
	})
})
