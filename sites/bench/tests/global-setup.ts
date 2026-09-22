import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RESULTS } from "./bench.js";

// BENCH_APPEND=1 keeps earlier rows, for re-running one spec or one mode.
export default function globalSetup(): void {
  mkdirSync(dirname(RESULTS), { recursive: true });
  if (!process.env.BENCH_APPEND) writeFileSync(RESULTS, "");
}
