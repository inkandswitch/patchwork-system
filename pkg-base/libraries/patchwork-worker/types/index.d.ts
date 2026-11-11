export { connectWorkerClient } from "./client.js";
export type WorkerSpec = import("./connect.js").WorkerSpec;
export type WorkerPlugin = import("./connect.js").WorkerPlugin;
export type WorkerStreams = import("./connect.js").WorkerStreams;
export type WorkerConnection = import("./connect.js").WorkerConnection;
export type WorkerClientPlugin = import("./client.js").WorkerClientPlugin;
export type WorkerClientFactory = import("./client.js").WorkerClientFactory;
export type Session = import("./session.js").Session;
export { connectWorker, openSession, CHANNEL_SELECTOR, WORKER_PLUGIN_TYPE, WORKER_CLIENT_PLUGIN_TYPE } from "./connect.js";
