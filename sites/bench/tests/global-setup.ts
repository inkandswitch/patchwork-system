import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RESULTS } from "./bench.js";

export default function globalSetup(): void {
  mkdirSync(dirname(RESULTS), { recursive: true });
  writeFileSync(RESULTS, "");
}
