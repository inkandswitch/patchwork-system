import { test } from "vitest";

import { runSeed } from "./fuzz.js";

// Replays one fuzz seed and prints the last actions of one user:
// SEED=14 WHO=bob N=300 vitest run test/debug.test.ts
test.skipIf(!process.env.SEED)("replay a fuzz seed", () => {
  const log: string[] = [];
  try {
    runSeed(Number(process.env.SEED), Number(process.env.N ?? 1000), log);
  } finally {
    const who = process.env.WHO ?? "";
    console.log(
      log
        .filter((line) => line.includes(who))
        .slice(-40)
        .join("\n")
    );
  }
});
