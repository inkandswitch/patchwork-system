import {describe, it, expect, vi, afterEach} from "vitest"
import {serveWorkerSpec} from "../serve.js"

/**
 * A fake Worker: records posted messages, lets the test push replies back, and
 * tracks termination. No real Worker (happy-dom has none) — we are testing the
 * transport, so the worker is a stub.
 */
function fakeWorker() {
	const w = {
		posted: [],
		terminated: false,
		/** @type {((ev:{data:any})=>void)|null} */
		onmessage: null,
		/** @type {((ev:any)=>void)|null} */
		onerror: null,
		/** @type {((ev:any)=>void)|null} */
		onmessageerror: null,
		postMessage(msg, transfer) {
			w.posted.push({msg, transfer})
		},
		terminate() {
			w.terminated = true
		},
		/** push a message from the "worker" back to the transport */
		reply(data) {
			w.onmessage?.({data})
		},
		/** simulate the worker crashing */
		crash() {
			w.onerror?.({message: "boom"})
		},
	}
	return w
}

/** Drive a served connection: write frames to writable, read frames off readable. */
function drive(streams) {
	const writer = streams.writable.getWriter()
	const reader = streams.readable.getReader()
	const frames = []
	let ended = false
	;(async () => {
		try {
			for (;;) {
				const {value, done} = await reader.read()
				if (done) break
				frames.push(value)
			}
		} catch {}
		ended = true
	})()
	return {
		write: (f) => writer.write(f),
		close: () => writer.close(),
		cancelRead: () => reader.cancel(),
		frames,
		ended: () => ended,
		settle: async () => {
			for (let i = 0; i < 20; i++) await Promise.resolve()
			await new Promise((r) => setTimeout(r, 0))
		},
	}
}

/** A spec that posts one message per request and waits for its reply. */
function echoSpec(w) {
	return {
		createWorker: () => w,
		handle(frame, io) {
			io.on((msg) => {
				io.emit({type: "result", text: msg.text})
				return true
			})
			io.post({type: "generate", id: io.workerId, text: frame.text})
			return {sessionKey: frame.id}
		},
	}
}

afterEach(() => vi.useRealTimers())

describe("serveWorkerSpec", () => {
	it("routes a request to the worker and its reply back, re-tagged with the caller id", async () => {
		const w = fakeWorker()
		const conn = drive(serveWorkerSpec(echoSpec(w), {}))
		await conn.write({id: "req-1", op: "generate", text: "hi"})
		await conn.settle()
		expect(w.posted).toHaveLength(1)
		const {msg} = w.posted[0]
		expect(msg.type).toBe("generate")
		expect(msg.id).not.toBe("req-1") // worker-side id is transport-minted
		w.reply({id: msg.id, type: "result", text: "hi"})
		await conn.settle()
		expect(conn.frames).toEqual([{id: "req-1", type: "result", text: "hi"}])
	})

	it("gives each connection its own worker, and passes ctx to the spec", async () => {
		const workers = []
		let seenCtx
		const spec = {
			createWorker: () => {
				const w = fakeWorker()
				workers.push(w)
				return w
			},
			handle: (frame, io) => {
				seenCtx = io.ctx
				io.post({type: "x", id: io.workerId})
			},
		}
		const el = document.createElement("div")
		const a = drive(serveWorkerSpec(spec, {element: el}))
		const b = drive(serveWorkerSpec(spec, {}))
		await a.write({id: "1", op: "go"})
		await b.write({id: "2", op: "go"})
		await a.settle()
		expect(workers).toHaveLength(2)
		expect(workers[0]).not.toBe(workers[1])
		expect(seenCtx).toEqual({})
	})

	it("tears down from either stream end: worker terminated, readable closed", async () => {
		// Writable closed: a reader blocked on read() is released with done=true.
		const w1 = fakeWorker()
		const a = drive(serveWorkerSpec(echoSpec(w1), {}))
		await a.write({id: "a", op: "go"})
		await a.settle()
		expect(w1.terminated).toBe(false)
		await a.close()
		await a.settle()
		expect(w1.terminated).toBe(true)
		expect(a.ended()).toBe(true)

		// Readable cancelled.
		const w2 = fakeWorker()
		const b = drive(serveWorkerSpec(echoSpec(w2), {}))
		await b.write({id: "b", op: "go"})
		await b.settle()
		await b.cancelRead()
		await b.settle()
		expect(w2.terminated).toBe(true)
	})

	it("tears down when the worker dies, so a waiting consumer sees end-of-stream", async () => {
		const w = fakeWorker()
		const conn = drive(serveWorkerSpec(echoSpec(w), {}))
		await conn.write({id: "a", op: "go"})
		await conn.settle()
		w.crash()
		await conn.settle()
		expect(w.terminated).toBe(true)
		expect(conn.ended()).toBe(true)
	})

	it("tears down when the worker cannot be constructed", async () => {
		const spec = {
			createWorker: () => Promise.reject(new Error("no worker for you")),
			handle: (frame, io) => io.post({id: io.workerId}),
		}
		const conn = drive(serveWorkerSpec(spec, {}))
		await conn.write({id: "a", op: "go"})
		await conn.settle()
		expect(conn.ended()).toBe(true)
	})

	it("routes op:abort to spec.abort with the stored token, once", async () => {
		const w = fakeWorker()
		const aborted = []
		const spec = {
			...echoSpec(w),
			abort(token, post) {
				aborted.push(token)
				post({type: "abort", sessionKey: token.sessionKey})
			},
		}
		const conn = drive(serveWorkerSpec(spec, {}))
		await conn.write({id: "a", op: "generate"})
		await conn.settle()
		await conn.write({id: "a", op: "abort"})
		await conn.write({id: "a", op: "abort"}) // duplicate: already forgotten
		await conn.write({id: "zzz", op: "abort"}) // unknown: ignored
		await conn.settle()
		expect(aborted).toEqual([{sessionKey: "a"}])
		expect(w.posted.some((p) => p.msg.type === "abort" && p.msg.sessionKey === "a")).toBe(true)
	})

	it("honours an abort that races in while the request is still resolving", async () => {
		// The abort arrives while `handle` is suspended on a slow `open`, before the
		// abort token exists. It must be deferred and fire once the token lands.
		const w = fakeWorker()
		const aborted = []
		let releaseOpen
		const spec = {
			...echoSpec(w),
			open: () => new Promise((r) => (releaseOpen = r)),
			abort: (token) => void aborted.push(token),
		}
		const conn = drive(serveWorkerSpec(spec, {}))
		await conn.write({id: "a", op: "generate"}) // suspends on open
		await conn.write({id: "a", op: "abort"}) // before the token exists
		await conn.settle()
		expect(aborted).toEqual([])

		releaseOpen(null)
		await conn.settle()
		expect(aborted).toEqual([{sessionKey: "a"}])
		await conn.write({id: "a", op: "abort"})
		await conn.settle()
		expect(aborted).toEqual([{sessionKey: "a"}])
	})

	it("forgets a request whose final reply arrives before handle returns", async () => {
		const w = fakeWorker()
		const aborted = []
		let release
		const spec = {
			createWorker: () => w,
			async handle(frame, io) {
				io.on(() => true)
				io.post({id: io.workerId})
				await new Promise((r) => (release = r))
				return {sessionKey: frame.id}
			},
			abort: (token) => void aborted.push(token),
		}
		const conn = drive(serveWorkerSpec(spec, {}))
		await conn.write({id: "a", op: "generate"})
		await conn.settle()
		w.reply({id: w.posted[0].msg.id}) // done, while handle is still pending
		release()
		await conn.settle()
		await conn.write({id: "a", op: "abort"})
		await conn.settle()
		expect(aborted).toEqual([])
	})

	it("does nothing for a request whose handle returns after teardown", async () => {
		const w = fakeWorker()
		const aborted = []
		let release
		const spec = {
			createWorker: () => w,
			async handle(frame, io) {
				io.on(() => false)
				await new Promise((r) => (release = r))
				return {sessionKey: frame.id}
			},
			abort: (token) => void aborted.push(token),
		}
		const conn = drive(serveWorkerSpec(spec, {}))
		await conn.write({id: "a", op: "generate"})
		await conn.write({id: "a", op: "abort"}) // deferred: no token yet
		await conn.close()
		release()
		await conn.settle()
		expect(aborted).toEqual([])
	})

	it("treats an open that throws synchronously as state: null", async () => {
		const spec = {
			createWorker: () => fakeWorker(),
			open: () => {
				throw new Error("no settings")
			},
			handle: (frame, io) => void io.emit({type: "ran", state: io.state}),
		}
		const conn = drive(serveWorkerSpec(spec, {}))
		await conn.write({id: "a", op: "go"})
		await conn.settle()
		expect(conn.frames).toEqual([{id: "a", type: "ran", state: null}])
	})

	it("does not track a fire-and-forget request (no io.on), so op:abort ignores it", async () => {
		const w = fakeWorker()
		const aborted = []
		const spec = {
			createWorker: () => w,
			handle(frame, io) {
				io.post({type: "preload", id: io.workerId})
				return {sessionKey: frame.id} // a token, but nothing is listening
			},
			abort: (token) => void aborted.push(token),
		}
		const conn = drive(serveWorkerSpec(spec, {}))
		await conn.write({id: "a", op: "preload"})
		await conn.settle()
		await conn.write({id: "a", op: "abort"})
		await conn.settle()
		expect(aborted).toEqual([])
	})

	it("creates no worker for a request that was still pending at teardown", async () => {
		const createWorker = vi.fn(() => fakeWorker())
		let releaseOpen
		const spec = {
			createWorker,
			open: () => new Promise((r) => (releaseOpen = r)),
			handle: (frame, io) => io.post({id: io.workerId}),
		}
		const conn = drive(serveWorkerSpec(spec, {}))
		await conn.write({id: "a", op: "go"}) // suspends on open
		await conn.close() // teardown while pending
		releaseOpen(null)
		await conn.settle()
		expect(createWorker).not.toHaveBeenCalled()
	})

	it("emits id-less worker messages straight onto the readable", async () => {
		const w = fakeWorker()
		const conn = drive(serveWorkerSpec(echoSpec(w), {}))
		await conn.write({id: "a", op: "go"})
		await conn.settle()
		w.reply({type: "status", message: "downloading model"}) // no id
		await conn.settle()
		expect(conn.frames).toContainEqual({type: "status", message: "downloading model"})
	})

	it("emits {type:error} tagged with the caller id when handle throws", async () => {
		const spec = {
			createWorker: () => fakeWorker(),
			handle() {
				throw new Error("boom")
			},
		}
		const conn = drive(serveWorkerSpec(spec, {}))
		await conn.write({id: "a", op: "go"})
		await conn.settle()
		expect(conn.frames).toContainEqual({id: "a", type: "error", message: "boom"})
	})

	it("falls through when open never settles rather than wedging frames", async () => {
		vi.useFakeTimers()
		const spec = {
			createWorker: () => fakeWorker(),
			open: () => new Promise(() => {}), // never resolves
			handle: (frame, io) => void io.emit({type: "ran", state: io.state}),
		}
		const conn = drive(serveWorkerSpec(spec, {}))
		await conn.write({id: "a", op: "go"})
		await vi.advanceTimersByTimeAsync(5001)
		vi.useRealTimers()
		await conn.settle()
		expect(conn.frames).toContainEqual({id: "a", type: "ran", state: null})
	})
})
