// Resolve a worker's typed client from the `patchwork:worker-client` registry
// and bind it to a session, so consumers never import the service package.

import {getRegistry} from "@inkandswitch/patchwork-plugins"
import {openSession, WORKER_CLIENT_PLUGIN_TYPE} from "./connect.js"

// `loadWhenReady` waits forever for a late registration; this bounds it.
const LOAD_TIMEOUT_MS = 10000

/**
 * @typedef {import("./session.js").Session} WorkerSession
 * @typedef {(session: WorkerSession) => any} WorkerClientFactory
 * @typedef {{type: "patchwork:worker-client", id: string, name?: string, load: () => Promise<WorkerClientFactory>}} WorkerClientPlugin
 */

/**
 * @param {string} kind
 * @param {{sessionOpts?: import("./session.js").SessionOpts, timeoutMs?: number}} [opts]
 * @returns {Promise<any>}
 */
export async function connectWorkerClient(kind, opts = {}) {
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let timer
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`timed out loading worker-client plugin "${kind}"`)),
			opts.timeoutMs ?? LOAD_TIMEOUT_MS
		)
	})
	/** @type {any} */
	let plugin
	try {
		plugin = await Promise.race([
			getRegistry(WORKER_CLIENT_PLUGIN_TYPE).loadWhenReady(kind),
			timeout,
		])
	} finally {
		clearTimeout(timer)
	}
	const factory = plugin?.module
	if (typeof factory !== "function") {
		throw new Error(`worker-client plugin "${kind}" did not resolve to a factory`)
	}
	return factory(openSession(kind, opts.sessionOpts))
}
