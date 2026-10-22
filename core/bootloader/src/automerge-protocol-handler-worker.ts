// The automerge worker's script. It takes the worker's lock before anything
// else loads, so the service worker can see there's a worker from the moment
// it starts, then imports the worker itself (automerge-protocol-handler.ts).
// Keep its imports small: none of this runs until they've all loaded.
import { AUTOMERGE_WORKER_LOCK } from "./types.js";
import { importRest, startEarly } from "./worker-early.js";

// Built as a file of its own next to this one, so a variable rather than a
// literal: the bundler leaves the import alone.
const REST = "./automerge-protocol-handler.js";

// Not awaited: this script should finish evaluating now, so nothing about the
// worker waits on the import but the code that's in it.
void importRest(
  startEarly(AUTOMERGE_WORKER_LOCK),
  "automerge-protocol-handler-worker",
  new URL(REST, import.meta.url).href
);
