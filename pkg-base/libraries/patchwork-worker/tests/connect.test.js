import {describe, it, expect, afterEach, vi} from "vitest"
import {existsSync, readFileSync} from "node:fs"
import {join} from "node:path"
import {accept} from "@inkandswitch/patchwork-providers"
import {connectWorker, openSession} from "../connect.js"
import {serveWorkerSpec} from "../serve.js"

// A minimal stand-in for the worker provider: answers worker-channel
// subscriptions for the kinds it knows, and refuses the ones it doesn't. Uses
// the real `accept()`, so these tests exercise the actual providers envelope.
function serveKinds(kinds) {
	const listener = (e) => {
		const {selector, port} = e.detail ?? {}
		if (selector?.type !== "patchwork:worker-channel" || !port) return
		const run = kinds[selector.kind]
		if (!run) return // decline, do NOT claim — let it bubble
		accept(e, (respond) => {
			Promise.resolve(run())
				.then((streams) => {
					respond({readable: streams.readable, writable: streams.writable}, [
						streams.readable,
						streams.writable,
					])
				})
				.catch(() => respond(null))
		})
	}
	document.addEventListener("patchwork:subscribe", listener)
	return () => document.removeEventListener("patchwork:subscribe", listener)
}

/** A provider that refuses every worker-channel subscription with `null`. */
function refuseAll(kind) {
	const refuse = (e) => {
		const {selector, port} = e.detail ?? {}
		if (selector?.type !== "patchwork:worker-channel" || !port) return
		if (kind && selector.kind !== kind) return
		accept(e, (respond) => respond(null))
	}
	document.addEventListener("patchwork:subscribe", refuse)
	return () => document.removeEventListener("patchwork:subscribe", refuse)
}

/** Echoes one token + a terminal result for every request frame written. */
function echoWorker() {
	let controller
	const readable = new ReadableStream({start: (c) => (controller = c)})
	const writable = new WritableStream({
		write(frame) {
			if (frame.op === "abort") return
			controller.enqueue({id: frame.id, type: "token", delta: "hi", text: "hi"})
			controller.enqueue({id: frame.id, type: "result", text: "hi"})
		},
	})
	return {writable, readable}
}

/** A hand-driven stream pair: the test controls the readable and sees writes. */
function manualWorker() {
	let controller
	const written = []
	const readable = new ReadableStream({start: (c) => (controller = c)})
	const writable = new WritableStream({write: (f) => void written.push(f)})
	return {readable, writable, written, push: (f) => controller.enqueue(f), end: () => controller.close()}
}

function mountElement() {
	const el = document.createElement("div")
	document.body.appendChild(el)
	cleanups.push(() => el.remove())
	return el
}

let cleanups = []
afterEach(() => {
	cleanups.forEach((f) => f())
	cleanups = []
	vi.useRealTimers()
})

async function readN(readable, n) {
	const reader = readable.getReader()
	const out = []
	while (out.length < n) {
		const {value, done} = await reader.read()
		if (done) break
		out.push(value)
	}
	reader.releaseLock()
	return out
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

const TERMINAL = {
	result: (f) => f.text,
	error: (f) => {
		throw new Error(f.message)
	},
}

describe("connectWorker", () => {
	it("connects when a provider answers, and the transferred streams are live", async () => {
		const kind = "echo-" + Math.random()
		cleanups.push(serveKinds({[kind]: echoWorker}))

		const conn = await connectWorker(kind, {element: mountElement()})
		expect(conn.readable).toBeInstanceOf(ReadableStream)
		expect(conn.writable).toBeInstanceOf(WritableStream)
		expect(typeof conn.disconnect).toBe("function")

		const writer = conn.writable.getWriter()
		await writer.write({op: "generate", id: "x"})
		writer.releaseLock()
		const frames = await readN(conn.readable, 2)
		expect(frames[0]).toMatchObject({id: "x", type: "token"})
		expect(frames[1]).toMatchObject({id: "x", type: "result"})
	})

	it("multiplexes many request ids over one connection", async () => {
		const kind = "echo-" + Math.random()
		cleanups.push(serveKinds({[kind]: echoWorker}))

		const conn = await connectWorker(kind, {element: mountElement()})
		const writer = conn.writable.getWriter()
		await writer.write({op: "generate", id: "a"})
		await writer.write({op: "generate", id: "b"})
		writer.releaseLock()

		const ids = (await readN(conn.readable, 4)).map((f) => f.id)
		expect(ids.filter((x) => x === "a")).toHaveLength(2)
		expect(ids.filter((x) => x === "b")).toHaveLength(2)
	})

	it("fails fast on an explicit refusal", async () => {
		// A refusal the provider already knows about must not cost the discovery
		// timeout — this is the path the isolation bridge uses when the worker
		// channel isn't in shared-providers.
		cleanups.push(refuseAll())
		const started = Date.now()
		await expect(connectWorker("nope", {element: mountElement()})).rejects.toThrow(
			/no worker available/
		)
		expect(Date.now() - started).toBeLessThan(1000)
	})

	it("rejects without an element to discover from", async () => {
		await expect(connectWorker("anything", {})).rejects.toThrow(/no element/)
	})

	it("times out when nothing answers at all", async () => {
		// Nothing is mounted, so this waits out DISCOVERY_TIMEOUT_MS — a backstop,
		// not control flow. Fake timers so the suite doesn't wait 8 s for real.
		vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]})
		const pending = connectWorker("nobody-" + Math.random(), {element: mountElement()})
		const assertion = expect(pending).rejects.toThrow(/no worker available/)
		await vi.advanceTimersByTimeAsync(8001)
		await assertion
	})
})

describe("openSession", () => {
	it("resolves on the terminal frame and streams the rest", async () => {
		const kind = "echo-" + Math.random()
		cleanups.push(serveKinds({[kind]: echoWorker}))

		const session = openSession(kind, {element: mountElement()})
		const seen = []
		const {promise} = session.request(
			{op: "generate"},
			{terminal: TERMINAL, onFrame: (f) => seen.push(f.type)}
		)
		await expect(promise).resolves.toBe("hi")
		expect(seen).toEqual(["token"])
	})

	it("does not cache a failed connection — a later request reconnects", async () => {
		// One early failure must not poison the session: once a provider shows up,
		// the next request must find it.
		const kind = "echo-" + Math.random()
		const session = openSession(kind, {element: mountElement()})

		const stopRefusing = refuseAll(kind)
		const first = session.request({op: "generate"}, {terminal: TERMINAL})
		await expect(first.promise).rejects.toThrow(/no worker available/)
		stopRefusing()

		cleanups.push(serveKinds({[kind]: echoWorker}))
		const second = session.request({op: "generate"}, {terminal: TERMINAL})
		await expect(second.promise).resolves.toBe("hi")
	})

	it("fails in-flight requests when the connection drops, then reconnects", async () => {
		// A request awaiting a terminal frame that can no longer arrive must reject,
		// not hang; and the dead connection must not be reused.
		const kind = "drop-" + Math.random()
		const workers = []
		cleanups.push(
			serveKinds({
				[kind]: () => {
					const w = manualWorker()
					workers.push(w)
					return w
				},
			})
		)
		const session = openSession(kind, {element: mountElement()})

		const first = session.request({op: "generate"}, {terminal: TERMINAL})
		await tick()
		workers[0].end() // stream ends with no terminal frame
		await expect(first.promise).rejects.toThrow(/closed before the request completed/)

		const second = session.request({op: "generate"}, {terminal: TERMINAL})
		await tick()
		expect(workers).toHaveLength(2) // a new connection, not the dead one
		expect(workers[1].written[0]).toMatchObject({op: "generate"})
		workers[1].push({id: workers[1].written[0].id, type: "result", text: "ok"})
		await expect(second.promise).resolves.toBe("ok")
	})

	it("fans id-less broadcast frames out to every in-flight request", async () => {
		// The LLM worker posts model-download progress and its own errors as
		// `{type:"status"}` with no id. Every caller waiting on that worker hears it.
		const kind = "bcast-" + Math.random()
		let w
		cleanups.push(serveKinds({[kind]: () => (w = manualWorker())}))
		const session = openSession(kind, {element: mountElement()})

		const seenA = []
		const seenB = []
		const a = session.request({op: "generate"}, {terminal: TERMINAL, onFrame: (f) => seenA.push(f)})
		const b = session.request({op: "generate"}, {terminal: TERMINAL, onFrame: (f) => seenB.push(f)})
		await tick()
		w.push({type: "status", message: "Downloading model weights… 40%"})
		await tick()
		expect(seenA).toEqual([{type: "status", message: "Downloading model weights… 40%"}])
		expect(seenB).toEqual([{type: "status", message: "Downloading model weights… 40%"}])

		// A settled request no longer hears broadcasts.
		w.push({id: w.written[0].id, type: "result", text: "done"})
		await expect(a.promise).resolves.toBe("done")
		w.push({type: "status", message: "later"})
		await tick()
		expect(seenA).toHaveLength(1)
		expect(seenB).toHaveLength(2)
		w.push({id: w.written[1].id, type: "result", text: "done"})
		await b.promise
	})

	it("close() tears the served connection down and the next request reconnects", async () => {
		// End to end through serveWorkerSpec: closing the session ends both streams,
		// so the host side terminates its dedicated worker.
		const kind = "close-" + Math.random()
		const workers = []
		const spec = {
			createWorker: () => {
				const fake = {
					terminated: false,
					onmessage: null,
					postMessage() {},
					terminate() {
						fake.terminated = true
					},
				}
				workers.push(fake)
				return fake
			},
			handle: (frame, io) => {
				io.on(() => false)
				io.post({id: io.workerId})
			},
		}
		cleanups.push(serveKinds({[kind]: () => serveWorkerSpec(spec, {})}))
		const session = openSession(kind, {element: mountElement()})

		const first = session.request({op: "generate"}, {terminal: TERMINAL})
		await tick()
		expect(workers).toHaveLength(1)
		session.close()
		await expect(first.promise).rejects.toThrow(/was closed/)
		await tick()
		expect(workers[0].terminated).toBe(true)

		const second = session.request({op: "generate"}, {terminal: TERMINAL})
		second.promise.catch(() => {})
		await tick()
		expect(workers).toHaveLength(2)
		session.close()
	})

	it("a closed connection's shutdown does not break the one that replaced it", async () => {
		// close() then an immediate request: the old connection's pump ends after the
		// new one has opened, and must not uncache it or fail its requests.
		const kind = "replace-" + Math.random()
		const workers = []
		cleanups.push(
			serveKinds({
				[kind]: () => {
					const w = manualWorker()
					workers.push(w)
					return w
				},
			})
		)
		const session = openSession(kind, {element: mountElement()})

		const first = session.request({op: "generate"}, {terminal: TERMINAL})
		first.promise.catch(() => {})
		await tick()
		session.close()
		const second = session.request({op: "generate"}, {terminal: TERMINAL})
		await tick()
		expect(workers).toHaveLength(2)
		workers[1].push({id: workers[1].written[0].id, type: "result", text: "ok"})
		await expect(second.promise).resolves.toBe("ok")

		// ...and the session still reuses that connection.
		const third = session.request({op: "generate"}, {terminal: TERMINAL})
		await tick()
		expect(workers).toHaveLength(2)
		workers[1].push({id: workers[1].written[1].id, type: "result", text: "again"})
		await expect(third.promise).resolves.toBe("again")
	})

	it("forwards an abort that fires while the connection is still opening", async () => {
		const kind = "abort-" + Math.random()
		let w
		cleanups.push(serveKinds({[kind]: () => (w = manualWorker())}))
		const session = openSession(kind, {element: mountElement()})

		const {promise, abort} = session.request({op: "generate"}, {terminal: TERMINAL})
		abort() // before discovery has resolved
		await expect(promise).rejects.toThrow(/Aborted/)
		await tick()
		// The request frame was already on its way; the abort follows it.
		expect(w.written.map((f) => f.op)).toEqual(["generate", "abort"])
		expect(w.written[1].id).toBe(w.written[0].id)
	})

	it("does not open a connection to abort a request that was never sent", async () => {
		let dispatches = 0
		const count = (e) => {
			if (e.detail?.selector?.type === "patchwork:worker-channel") dispatches++
		}
		document.addEventListener("patchwork:subscribe", count)
		cleanups.push(() => document.removeEventListener("patchwork:subscribe", count))

		const session = openSession("never-" + Math.random(), {element: mountElement()})
		const {promise} = session.request(
			{op: "generate"},
			{terminal: TERMINAL, signal: AbortSignal.abort()}
		)
		await expect(promise).rejects.toThrow(/Aborted/)
		expect(dispatches).toBe(0)
	})
})

describe("package shape", () => {
	it("publishes every exported subpath", () => {
		const dir = process.cwd()
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
		expect(pkg.files).toContain("types")
		for (const [subpath, target] of Object.entries(pkg.exports)) {
			const file = target.default
			expect(existsSync(join(dir, file)), `${subpath} -> ${file}`).toBe(true)
			expect(pkg.files, `${file} in files`).toContain(file.replace(/^\.\//, ""))
			expect(existsSync(join(dir, target.types)), `${subpath} types`).toBe(true)
		}
	})
})
