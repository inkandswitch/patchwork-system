// Serving half, the mirror of `openSession`. A service supplies a WorkerSpec;
// this owns the stream pair, one dedicated Worker per connection, id demux, the
// reserved `op:"abort"`, and teardown. Worker messages without an `id` are
// emitted straight onto the readable.

// `spec.open` may never settle (e.g. an unanswered providers `request()`);
// after this, frames are served with `state: null`.
const OPEN_TIMEOUT_MS = 5000

/**
 * @typedef {(msg: any, transfer?: Transferable[]) => void} Post
 * @typedef {(frame: any) => void} Emit
 *
 * @typedef {Object} IO
 * @property {Post} post  send to the worker
 * @property {Emit} emit  enqueue a frame (tagged with the caller id) onto the readable
 * @property {(fn: (msg: any) => boolean | void) => void} on  handle worker messages
 *   tagged `workerId`; return truthy when done. Without `on`, a request is
 *   fire-and-forget and can't be aborted.
 * @property {string} workerId
 * @property {any} state  what `spec.open` resolved, or null
 * @property {{element?: HTMLElement}} ctx
 *
 * @typedef {Object} WorkerSpec
 * @property {() => Worker | Promise<Worker>} createWorker
 * @property {(ctx: {element?: HTMLElement}) => any} [open]
 * @property {(frame: any, io: IO) => any} handle  returns an abort token
 * @property {(token: any, post: Post) => void} [abort]
 */

let idSeq = 0

/**
 * @param {WorkerSpec} spec
 * @param {{element?: HTMLElement}} [ctx]
 * @returns {{readable: ReadableStream, writable: WritableStream}}
 */
export function serveWorkerSpec(spec, ctx = {}) {
	/** @type {Promise<Worker> | null} */
	let workerReady = null
	/** @type {Worker | null} */
	let worker = null
	/** @type {ReadableStreamDefaultController | null} */
	let controller = null
	let closed = false
	/** worker id -> reply handler @type {Map<string, (msg: any) => boolean | void>} */
	const handlers = new Map()
	/**
	 * caller id -> request. Entered synchronously on arrival so an abort that
	 * races in before `handle` returns is still honoured.
	 * @type {Map<string, {token?: any, ready: boolean, aborted: boolean}>}
	 */
	const requests = new Map()

	const emit = (/** @type {any} */ frame) => {
		try {
			controller?.enqueue(frame)
		} catch {}
	}

	const openState = spec.open
		? Promise.race([
				Promise.resolve().then(() => spec.open?.(ctx)),
				new Promise((resolve) => setTimeout(resolve, OPEN_TIMEOUT_MS, null)),
			]).catch(() => null)
		: Promise.resolve(null)

	/** @type {Post} */
	const post = (msg, transfer) => {
		if (closed) return
		getWorker()
			.then((w) => w.postMessage(msg, transfer || []))
			.catch(() => {})
	}

	const abortToken = (/** @type {any} */ token) => {
		try {
			spec.abort?.(token, post)
		} catch {}
	}

	// A worker that can't be constructed, or dies, ends the connection.
	function getWorker() {
		if (workerReady) return workerReady
		workerReady = Promise.resolve()
			.then(() => spec.createWorker())
			.then((w) => {
				worker = w
				w.onmessage = (ev) => dispatch(ev.data)
				w.onerror = teardown
				w.onmessageerror = teardown
				return w
			})
		workerReady.catch(teardown)
		return workerReady
	}

	function dispatch(/** @type {any} */ msg) {
		if (!msg || closed) return
		if (msg.id == null) return emit(msg)
		if (handlers.get(msg.id)?.(msg)) handlers.delete(msg.id)
	}

	async function handleFrame(/** @type {any} */ frame) {
		if (!frame || typeof frame !== "object") return
		const {id} = frame

		if (frame.op === "abort") {
			const req = requests.get(id)
			if (!req) return
			if (!req.ready) {
				req.aborted = true
				return
			}
			requests.delete(id)
			abortToken(req.token)
			return
		}

		const req = {token: undefined, ready: false, aborted: false}
		requests.set(id, req)
		const state = await openState
		if (closed) return

		const workerId = `wk-${++idSeq}-${performance.now() | 0}`
		let tracked = false
		let done = false

		/** @type {IO} */
		const io = {
			post,
			emit: (f) => emit({...f, id}),
			on(fn) {
				tracked = true
				handlers.set(workerId, (msg) => {
					const finished = fn(msg)
					if (finished) {
						done = true
						requests.delete(id)
					}
					return finished
				})
			},
			workerId,
			state,
			ctx,
		}

		try {
			const token = await spec.handle(frame, io)
			if (closed) return
			if (req.aborted) {
				requests.delete(id)
				handlers.delete(workerId)
				abortToken(token)
			} else if (tracked && !done) {
				req.token = token
				req.ready = true
			} else {
				requests.delete(id)
			}
		} catch (e) {
			emit({id, type: "error", message: /** @type {any} */ (e)?.message || String(e)})
			handlers.delete(workerId)
			requests.delete(id)
		}
	}

	function teardown() {
		if (closed) return
		closed = true
		handlers.clear()
		requests.clear()
		// Close the readable too, in case teardown came from the writable or the worker.
		try {
			controller?.close()
		} catch {}
		controller = null
		try {
			worker?.terminate()
		} catch {}
		worker = null
	}

	const readable = new ReadableStream({
		start(c) {
			controller = c
		},
		cancel: teardown,
	})

	const writable = new WritableStream({
		write(frame) {
			void handleFrame(frame)
		},
		close: teardown,
		abort: teardown,
	})

	return {readable, writable}
}
