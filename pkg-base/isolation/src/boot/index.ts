/**
 * How an isolation iframe gets born. `bootIsolation` runs the boot sequence and
 * returns a handle.
 *
 * The subdirectories mark the **trust boundary** by realm of execution:
 *  - `host/` — code that runs in the trusted host. `boot.ts` is the director;
 *    `assets`/`styles`/`import-map` are the reads it composes; `srcdoc.ts`
 *    assembles the iframe's HTML (it serializes the iframe code but runs host-side).
 *  - `iframe/` — code that runs INSIDE the untrusted sandbox (`main.ts`). It never
 *    executes in the host; `host/srcdoc.ts` embeds it via `.toString()`.
 */

export { bootIsolation, type IsolationHandle } from "./host/boot.js";
