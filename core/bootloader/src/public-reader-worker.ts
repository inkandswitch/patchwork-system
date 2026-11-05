// The public reader worker's script. It takes the worker's lock before
// anything else loads, so tabs can tell there's a reader from the moment it
// starts, then imports the worker itself (public-reader.ts).
import { PUBLIC_READER_LOCK } from "./types.js";
import { PUBLIC_READER } from "./emitted.js";
import { importRest, startEarly } from "./worker-early.js";

void importRest(
  startEarly(PUBLIC_READER_LOCK),
  "public-reader-worker",
  new URL(PUBLIC_READER, import.meta.url).href
);
