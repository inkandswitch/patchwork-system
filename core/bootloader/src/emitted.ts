// Files a build emits under content-hashed names, by the path the dev server
// serves each one at. @inkandswitch/patchwork's vite plugin swaps each path
// here for the URL of the file it emitted, so a build only ever loads its own
// copies: the browser can keep them forever, offline included, and a worker
// can't pick up a file from one build and the rest from another. Read them
// from here rather than writing the paths out, or a build fetches a path that
// only redirects to the file (see the plugin's _redirects).

export const AUTOMERGE_WASM = "/automerge.wasm";
export const SUBDUCTION_WASM = "/subduction.wasm";
export const KEYHIVE_WASM = "/keyhive_wasm.wasm";

/** What the automerge worker's script imports once it holds the lock. */
export const AUTOMERGE_PROTOCOL_HANDLER = "/automerge-protocol-handler.js";
export const MODULE_LOADER_WORKER = "/module-loader-worker.js";
