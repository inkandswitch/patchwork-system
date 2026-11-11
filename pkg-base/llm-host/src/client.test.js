import {describe, it, expect, vi} from "vitest"
import {makeLLMClient} from "./client.js"

/**
 * A fake transport session. `reply(frame, opts)` decides how each request
 * settles: return a terminal frame, or call `opts.onFrame` first for progress.
 * Every request is recorded in `requests`.
 */
function fakeSession(reply = () => ({type: "result", text: ""})) {
	/** @type {{frame: any, opts: any}[]} */
	const requests = []
	const session = {
		request(frame, opts) {
			requests.push({frame, opts})
			const promise = Promise.resolve().then(() => {
				const f = reply(frame, opts)
				return opts.terminal[f.type](f)
			})
			return {promise, abort: vi.fn()}
		},
	}
	return {session, requests}
}

describe("makeLLMClient · generate", () => {
	it("sends a generate frame with messages, scope, system, tools and sessionKey", async () => {
		const {session, requests} = fakeSession(() => ({type: "result", text: "hello", toolCalls: null}))
		const el = {}
		const signal = new AbortController().signal
		const res = await makeLLMClient(session).generate([{role: "user", content: "hi"}], {
			sessionKey: "doc-1",
			scope: {toolId: "chat"},
			system: {default: "be brief"},
			tools: [{name: "x"}],
			element: /** @type {any} */ (el),
			signal,
		})
		expect(requests[0].frame).toEqual({
			op: "generate",
			sessionKey: "doc-1",
			scope: {toolId: "chat"},
			system: {default: "be brief"},
			tools: [{name: "x"}],
			messages: [{role: "user", content: "hi"}],
		})
		expect(requests[0].opts.element).toBe(el)
		expect(requests[0].opts.signal).toBe(signal)
		expect(res).toEqual({text: "hello", toolCalls: null, toolMode: undefined})
	})

	it("sends only tool descriptors, never handlers", async () => {
		const {session, requests} = fakeSession()
		await makeLLMClient(session).generate("x", {
			tools: [{name: "x", description: "d", parameters: {}, defaultOff: true, handler: () => 1}],
		})
		expect(requests[0].frame.tools).toEqual([{name: "x", description: "d", parameters: {}, defaultOff: true}])
		expect(() => structuredClone(requests[0].frame)).not.toThrow()
	})

	it("sends a string prompt as text", async () => {
		const {session, requests} = fakeSession()
		await makeLLMClient(session).generate("continue this")
		expect(requests[0].frame.text).toBe("continue this")
		expect(requests[0].frame.messages).toBeUndefined()
	})

	it("passes toolCalls and toolMode through from the result frame", async () => {
		const {session} = fakeSession(() => ({type: "result", text: "t", toolCalls: [{name: "x", args: {}}], toolMode: "template"}))
		await expect(makeLLMClient(session).generate("x")).resolves.toEqual({
			text: "t",
			toolCalls: [{name: "x", args: {}}],
			toolMode: "template",
		})
	})

	it("rejects with the error frame's message", async () => {
		const {session} = fakeSession(() => ({type: "error", message: "boom"}))
		await expect(makeLLMClient(session).generate("x")).rejects.toThrow("boom")
	})

	it("routes token / status / model frames to the callbacks", async () => {
		const {session} = fakeSession((_frame, opts) => {
			opts.onFrame({type: "token", delta: "h", text: "h"})
			opts.onFrame({type: "status", message: "loading"})
			opts.onFrame({type: "model", label: "Local 1B"})
			opts.onFrame({type: "stats", tokPerSec: 1})
			return {type: "result", text: "h"}
		})
		const onToken = vi.fn()
		const onStatus = vi.fn()
		const onModel = vi.fn()
		await makeLLMClient(session).generate("x", {onToken, onStatus, onModel})
		expect(onToken).toHaveBeenCalledWith("h", "h")
		expect(onStatus).toHaveBeenCalledWith("loading")
		expect(onModel).toHaveBeenCalledWith("Local 1B")
	})
})

describe("makeLLMClient · runTool", () => {
	it("asks the host to run the call and resolves with its result", async () => {
		const {session, requests} = fakeSession(() => ({type: "tool-result", result: {temp: 12}}))
		const result = await makeLLMClient(session).runTool({name: "weather", args: {city: "x"}}, {scope: {toolId: "t"}})
		expect(requests[0].frame).toEqual({op: "run-tool", scope: {toolId: "t"}, name: "weather", args: {city: "x"}})
		expect(result).toEqual({temp: 12})
	})
})

describe("makeLLMClient · generateWithTools", () => {
	/** Replies to generate frames from `results` in order. */
	function scripted(results, runTool = () => ({type: "tool-result", result: "host result"})) {
		let i = 0
		return fakeSession((frame) => (frame.op === "run-tool" ? runTool(frame) : {type: "result", ...results[i++]}))
	}

	it("threads native calls back as tool_calls + role:tool messages", async () => {
		const {session, requests} = scripted([
			{text: "", toolCalls: [{id: "c1", name: "add", args: {a: 1, b: 2}}], toolMode: "native"},
			{text: "3", toolCalls: null, toolMode: "native"},
		])
		const add = vi.fn(({a, b}) => a + b)
		const res = await makeLLMClient(session).generateWithTools("1+2?", {tools: [{name: "add", handler: add}]})
		expect(add).toHaveBeenCalledWith({a: 1, b: 2})
		expect(res.text).toBe("3")
		expect(requests[1].frame.messages).toEqual([
			{role: "user", content: "1+2?"},
			{
				role: "assistant",
				content: null,
				tool_calls: [{id: "c1", type: "function", function: {name: "add", arguments: '{"a":1,"b":2}'}}],
			},
			{role: "tool", tool_call_id: "c1", content: "3"},
		])
		expect(res.messages).toEqual(requests[1].frame.messages)
	})

	it("threads template calls as role:tool messages without ids", async () => {
		const {session, requests} = scripted([
			{text: "<tool_call>…</tool_call>", toolCalls: [{name: "add", args: {a: 1}}], toolMode: "template"},
			{text: "done", toolCalls: null},
		])
		await makeLLMClient(session).generateWithTools([{role: "user", content: "q"}], {tools: [{name: "add", handler: () => "ok"}]})
		expect(requests[1].frame.messages.slice(1)).toEqual([
			{role: "assistant", content: "", tool_calls: [{type: "function", function: {name: "add", arguments: {a: 1}}}]},
			{role: "tool", content: "ok"},
		])
	})

	it("threads text-mode calls as plain messages", async () => {
		const {session, requests} = scripted([
			{text: "calling add", toolCalls: [{name: "add", args: {}}], toolMode: "text"},
			{text: "done", toolCalls: null},
		])
		await makeLLMClient(session).generateWithTools("q", {tools: [{name: "add", handler: () => ({n: 1})}]})
		expect(requests[1].frame.messages.slice(1)).toEqual([
			{role: "assistant", content: "calling add"},
			{role: "user", content: 'Tool "add" returned:\n{"n":1}'},
		])
	})

	it("runs host-tagged calls on the host and offers the user's tools by default", async () => {
		const {session, requests} = scripted([
			{text: "", toolCalls: [{id: "c1", name: "Weather now", args: {city: "x"}, host: true}], toolMode: "native"},
			{text: "sunny", toolCalls: null},
		])
		const onToolCall = vi.fn()
		await makeLLMClient(session).generateWithTools("weather?", {scope: {toolId: "t"}, onToolCall})
		expect(requests[0].frame.userTools).toBe(true)
		expect(requests[1].frame).toEqual({op: "run-tool", scope: {toolId: "t"}, name: "Weather now", args: {city: "x"}})
		expect(onToolCall).toHaveBeenCalledWith({name: "Weather now", args: {city: "x"}, result: "host result"})
		expect(requests[2].frame.messages.at(-1)).toEqual({role: "tool", tool_call_id: "c1", content: "host result"})
	})

	it("reports handler errors and unknown tools to the model instead of throwing", async () => {
		const {session, requests} = scripted([
			{
				text: "",
				toolCalls: [
					{id: "c1", name: "boom", args: {}},
					{id: "c2", name: "nope", args: {}},
				],
				toolMode: "native",
			},
			{text: "sorry", toolCalls: null},
		])
		const onToolCall = vi.fn()
		const res = await makeLLMClient(session).generateWithTools("q", {
			tools: [
				{
					name: "boom",
					handler: () => {
						throw new Error("kaboom")
					},
				},
			],
			onToolCall,
		})
		expect(res.text).toBe("sorry")
		expect(requests[1].frame.messages.slice(-2).map((m) => m.content)).toEqual(["Error: kaboom", 'Error: no tool named "nope"'])
		expect(onToolCall).toHaveBeenCalledWith({name: "boom", args: {}, error: "kaboom"})
	})

	it("stops after maxRounds and tags tokens with the round", async () => {
		const {session, requests} = fakeSession((frame, opts) => {
			opts.onFrame({type: "token", delta: "t", text: "t"})
			return {type: "result", text: "again", toolCalls: [{name: "loop", args: {}}], toolMode: "text"}
		})
		const onToken = vi.fn()
		const res = await makeLLMClient(session).generateWithTools("q", {
			tools: [{name: "loop", handler: () => "ok"}],
			maxRounds: 2,
			onToken,
		})
		expect(requests).toHaveLength(2)
		expect(res.text).toBe("again")
		expect(onToken.mock.calls).toEqual([
			["t", "t", 0],
			["t", "t", 1],
		])
	})
})
