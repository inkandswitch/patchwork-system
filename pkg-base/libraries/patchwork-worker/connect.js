// Consumer half: discover a provider for a worker `kind` and receive a
// transferable `{readable, writable}` pair. Registry-free, so sandboxes load
// only what they need. No local fallback: without a provider, it rejects.

import {subscribe} from "@inkandswitch/patchwork-providers"
import {createOpenSession} from "./session.js"

// Strings, not Symbols, so they still match if this module loads twice.
export const CHANNEL_SELECTOR = "patchwork:worker-channel"
export const WORKER_PLUGIN_TYPE = "patchwork:worker"
export const WORKER_CLIENT_PLUGIN_TYPE = "patchwork:worker-client"

// Backstop: an unanswered subscribe never settles.
const DISCOVERY_TIMEOUT_MS = 8000

/** @typedef {{readable: ReadableStream, writable: WritableStream}} WorkerStreams */
/** @typedef {WorkerStreams & {disconnect: () => void}} WorkerConnection */
/** @typedef {import("./serve.js").WorkerSpec} WorkerSpec */
/** @typedef {{type: "patchwork:worker", id: string, name?: string, load: () => Promise<WorkerSpec>}} WorkerPlugin */

/**
 * @param {string} kind
 * @param {{element: HTMLElement}} opts  a node inside a mounted <patchwork-view>
 * @returns {Promise<WorkerConnection>}
 */
export async function connectWorker(kind, opts) {
	const element = opts?.element
	if (!element) {
		throw new Error(`no worker available for kind "${kind}": no element to discover a provider from`)
	}
	const streams = await discover(element, kind)
	if (!streams) throw new Error(`no worker available for kind "${kind}"`)
	return {
		...streams,
		// Only valid while the caller holds no reader/writer lock.
		disconnect() {
			streams.readable.cancel().catch(() => {})
			streams.writable.abort().catch(() => {})
		},
	}
}

/**
 * Resolves the first answer, or null on refusal or timeout.
 * @param {HTMLElement} element
 * @param {string} kind
 * @returns {Promise<WorkerStreams | null>}
 */
function discover(element, kind) {
	return new Promise((resolve) => {
		let settled = false
		/** @type {(() => void) | undefined} */
		let unsubscribe
		const stop = () => {
			try {
				unsubscribe?.()
			} catch {}
		}
		const finish = (/** @type {WorkerStreams | null} */ value) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			stop()
			resolve(value)
		}
		const timer = setTimeout(() => finish(null), DISCOVERY_TIMEOUT_MS)

		// Cast: `subscribe` is typed for JSON values; a stream pair isn't one.
		unsubscribe = /** @type {any} */ (subscribe)(
			element,
			{type: CHANNEL_SELECTOR, kind},
			(/** @type {any} */ value) =>
				finish(value?.readable && value?.writable ? {readable: value.readable, writable: value.writable} : null)
		)
		// The provider may have answered synchronously, before we had `unsubscribe`.
		if (settled) stop()
	})
}

export const openSession = createOpenSession(connectWorker)
