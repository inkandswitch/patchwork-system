/** @typedef {{readable: ReadableStream, writable: WritableStream}} WorkerStreams */
/** @typedef {WorkerStreams & {disconnect: () => void}} WorkerConnection */
/** @typedef {import("./serve.js").WorkerSpec} WorkerSpec */
/** @typedef {{type: "patchwork:worker", id: string, name?: string, load: () => Promise<WorkerSpec>}} WorkerPlugin */
/**
 * @param {string} kind
 * @param {{element: HTMLElement}} opts  a node inside a mounted <patchwork-view>
 * @returns {Promise<WorkerConnection>}
 */
export function connectWorker(kind: string, opts: {
    element: HTMLElement;
}): Promise<WorkerConnection>;
export const CHANNEL_SELECTOR: "patchwork:worker-channel";
export const WORKER_PLUGIN_TYPE: "patchwork:worker";
export const WORKER_CLIENT_PLUGIN_TYPE: "patchwork:worker-client";
export const openSession: (kind: string, sessionOpts?: import("./session.js").SessionOpts) => import("./session.js").Session;
export type WorkerStreams = {
    readable: ReadableStream;
    writable: WritableStream;
};
export type WorkerConnection = WorkerStreams & {
    disconnect: () => void;
};
export type WorkerSpec = import("./serve.js").WorkerSpec;
export type WorkerPlugin = {
    type: "patchwork:worker";
    id: string;
    name?: string;
    load: () => Promise<WorkerSpec>;
};
