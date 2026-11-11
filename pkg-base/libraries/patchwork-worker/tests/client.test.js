import {describe, it, expect, afterEach, vi} from "vitest"

// connectWorkerClient resolves the client factory from the host plugin registry.
// Stub it before importing, so these tests exercise the helper's own logic
// (bounded wait / late registration / shape check) without the real platform.
const registry = {
	plugins: new Map(),
	waiters: [],
	has(id) {
		return this.plugins.has(id)
	},
	async loadWhenReady(id) {
		// Mirrors the real registry: waits for a late registration rather than
		// reporting the plugin missing.
		if (this.plugins.has(id)) return {module: this.plugins.get(id)}
		return new Promise((resolve) => {
			this.waiters.push({id, resolve})
		})
	},
	register(id, factory) {
		this.plugins.set(id, factory)
		for (const w of this.waiters) {
			if (w.id === id) w.resolve({module: factory})
		}
		this.waiters = this.waiters.filter((w) => w.id !== id)
	},
	reset() {
		this.plugins.clear()
		this.waiters = []
	},
}

vi.mock("@inkandswitch/patchwork-plugins", () => ({
	getRegistry: () => registry,
}))

const {connectWorkerClient} = await import("../client.js")

afterEach(() => {
	registry.reset()
})

describe("connectWorkerClient", () => {
	it("resolves the registered factory bound to a session for the same kind", async () => {
		let seen = null
		registry.register("llm", (session) => {
			seen = session
			return {generate: () => "ok"}
		})
		const client = await connectWorkerClient("llm", {sessionOpts: {idPrefix: "t"}})
		expect(client.generate()).toBe("ok")
		// The factory receives an openSession() session.
		expect(typeof seen.request).toBe("function")
		expect(typeof seen.close).toBe("function")
	})

	it("waits for a plugin registered after the call", async () => {
		const pending = connectWorkerClient("llm", {timeoutMs: 1000})
		await new Promise((r) => setTimeout(r, 10))
		registry.register("llm", () => ({late: true}))
		await expect(pending).resolves.toEqual({late: true})
	})

	it("rejects after the bounded wait when nothing registers the kind", async () => {
		await expect(connectWorkerClient("nobody", {timeoutMs: 50})).rejects.toThrow(/timed out/)
	})

	it("rejects when the plugin does not resolve to a factory", async () => {
		registry.register("llm", {not: "a function"})
		await expect(connectWorkerClient("llm", {timeoutMs: 50})).rejects.toThrow(
			/did not resolve to a factory/
		)
	})

})
