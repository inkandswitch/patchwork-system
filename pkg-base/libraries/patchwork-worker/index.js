/**
 * @grjte/patchwork-worker — run a worker in the host realm and hand any consumer
 * a transferable stream pair, the same inside or outside an isolation boundary.
 *
 *   connect.js  consumer transport: `connectWorker`, `openSession`, constants
 *   session.js  request/response multiplexing over a connection
 *   serve.js    host-only serving half, driven by `patchwork-worker-provider`
 *   client.js   `connectWorkerClient` — typed client from the plugin registry
 *
 * Nothing here may hold host-only state or secrets: consumers load these files
 * into their own (possibly sandboxed) realm.
 */

export {
	connectWorker,
	openSession,
	CHANNEL_SELECTOR,
	WORKER_PLUGIN_TYPE,
	WORKER_CLIENT_PLUGIN_TYPE,
} from "./connect.js"

export {connectWorkerClient} from "./client.js"

/**
 * @typedef {import("./connect.js").WorkerSpec} WorkerSpec
 * @typedef {import("./connect.js").WorkerPlugin} WorkerPlugin
 * @typedef {import("./connect.js").WorkerStreams} WorkerStreams
 * @typedef {import("./connect.js").WorkerConnection} WorkerConnection
 * @typedef {import("./client.js").WorkerClientPlugin} WorkerClientPlugin
 * @typedef {import("./client.js").WorkerClientFactory} WorkerClientFactory
 * @typedef {import("./session.js").Session} Session
 */
