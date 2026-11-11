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
export function connectWorkerClient(kind: string, opts?: {
    sessionOpts?: import("./session.js").SessionOpts;
    timeoutMs?: number;
}): Promise<any>;
export type WorkerSession = import("./session.js").Session;
export type WorkerClientFactory = (session: WorkerSession) => any;
export type WorkerClientPlugin = {
    type: "patchwork:worker-client";
    id: string;
    name?: string;
    load: () => Promise<WorkerClientFactory>;
};
