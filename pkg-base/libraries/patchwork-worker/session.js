// Request/response multiplexing over a worker connection. The connection opens
// lazily, is shared by every request, and is dropped when it fails or ends so
// the next request reconnects. Frames with an `id` go to that request; frames
// without one are broadcast to every in-flight request.

/**
 * @typedef {Object} RequestOpts
 * @property {Record<string, (frame: any) => any>} terminal  frame.type -> settle;
 *   the return value resolves the request, a throw rejects it
 * @property {(frame: any) => void} [onFrame]  non-terminal and broadcast frames
 * @property {AbortSignal} [signal]
 * @property {HTMLElement} [element]  discovery element, if not set on the session
 *
 * @typedef {Object} SessionOpts
 * @property {HTMLElement} [element]
 * @property {string} [idPrefix]  defaults to the kind
 * @property {(...a: any[]) => void} [onLog]
 *
 * @typedef {{readable: ReadableStream, writable: WritableStream, disconnect: () => void}} Connection
 * @typedef {{writer: WritableStreamDefaultWriter, reader: ReadableStreamDefaultReader}} OpenConnection
 *
 * @typedef {Object} Session
 * @property {(frame: any, opts: RequestOpts) => {promise: Promise<any>, abort: () => void}} request
 * @property {() => void} close  drop the connection and reject in-flight requests
 */

/**
 * Injected rather than imported to avoid a cycle with connect.js.
 * @param {(kind: string, opts: {element: HTMLElement}) => Promise<Connection>} connectWorker
 */
export function createOpenSession(connectWorker) {
	/**
	 * @param {string} kind
	 * @param {SessionOpts} [sessionOpts]
	 * @returns {Session}
	 */
	return function openSession(kind, sessionOpts = {}) {
		const idPrefix = sessionOpts.idPrefix || kind
		const log = sessionOpts.onLog || (() => {})

		/** @type {Promise<OpenConnection> | null} */
		let connection = null
		/** @type {Map<string, {onFrame: (f: any) => void, onClosed: (cause: any) => void}>} */
		const handlers = new Map()
		let idSeq = 0

		/**
		 * Uncache `conn` (if still current) and fail everything in flight on it.
		 * @param {Promise<OpenConnection> | null} conn
		 * @param {any} cause
		 */
		function reset(conn, cause) {
			if (conn !== connection) return
			connection = null
			const inFlight = [...handlers.values()]
			handlers.clear()
			for (const h of inFlight) h.onClosed(cause)
		}

		/** @param {HTMLElement | undefined} element */
		function ensureConnection(element) {
			if (connection) return connection
			const conn = connectWorker(kind, {
				element: /** @type {HTMLElement} */ (element ?? sessionOpts.element),
			}).then(({readable, writable}) => ({writer: writable.getWriter(), reader: readable.getReader()}))
			connection = conn
			conn.then(({reader}) => pump(conn, reader), (e) => reset(conn, e))
			return conn
		}

		/**
		 * @param {Promise<OpenConnection>} conn
		 * @param {ReadableStreamDefaultReader} reader
		 */
		async function pump(conn, reader) {
			/** @type {any} */
			let cause = null
			try {
				while (true) {
					const {value, done} = await reader.read()
					if (done || conn !== connection) break
					if (!value) continue
					if (value.id != null) handlers.get(value.id)?.onFrame(value)
					else for (const h of [...handlers.values()]) h.onFrame(value)
				}
			} catch (e) {
				cause = e
				log("connection readable errored", e)
			} finally {
				reset(conn, cause)
			}
		}

		/**
		 * @param {any} frame
		 * @param {HTMLElement | undefined} element
		 */
		async function send(frame, element) {
			const {writer} = await ensureConnection(element)
			await writer.write(frame)
		}

		/**
		 * @param {any} frame
		 * @param {RequestOpts} opts
		 */
		function request(frame, opts) {
			const id = `${idPrefix}-${++idSeq}-${performance.now() | 0}`
			const terminal = opts.terminal || {}
			let settled = false
			/** @type {(v: any) => void} */
			let resolve = () => {}
			/** @type {(e: any) => void} */
			let reject = () => {}
			const promise = new Promise((res, rej) => {
				resolve = res
				reject = rej
			})

			/** Settle once, via `fn`; a throw from `fn` rejects. */
			const settle = (/** @type {() => any} */ fn) => {
				if (settled) return
				settled = true
				handlers.delete(id)
				opts.signal?.removeEventListener("abort", abort)
				try {
					resolve(fn())
				} catch (e) {
					reject(e)
				}
			}

			function abort() {
				// Don't open a connection just to abort a request that was never sent.
				if (!settled && connection) send({op: "abort", id}, opts.element).catch(() => {})
				settle(() => {
					throw new DOMException("Aborted", "AbortError")
				})
			}

			handlers.set(id, {
				onFrame(f) {
					const done = terminal[f.type]
					if (done) return settle(() => done(f))
					try {
						opts.onFrame?.(f)
					} catch (e) {
						log("onFrame threw", e)
					}
				},
				onClosed(cause) {
					settle(() => {
						throw cause instanceof Error
							? cause
							: new Error(`worker connection for "${kind}" closed before the request completed`)
					})
				},
			})

			if (opts.signal?.aborted) {
				abort()
				return {promise, abort}
			}
			opts.signal?.addEventListener("abort", abort)

			send({...frame, id}, opts.element).catch((e) =>
				settle(() => {
					throw e
				})
			)
			return {promise, abort}
		}

		function close() {
			const conn = connection
			if (!conn) return
			reset(conn, new Error(`worker connection for "${kind}" was closed`))
			// Release through our locks; ending the writer terminates the host worker.
			conn
				.then(({reader, writer}) => {
					reader.cancel().catch(() => {})
					writer.abort().catch(() => {})
				})
				.catch(() => {})
		}

		return {request, close}
	}
}
