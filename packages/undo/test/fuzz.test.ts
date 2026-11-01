import { describe, test } from "vitest";

import { runSeed, runShared } from "./fuzz.js";

/**
 * Two peers edit their own sections of one document (text, map values and
 * nested objects, lists with and without element overwrites, records
 * containing text) with random undos, redos, waits and syncs. The oracle per
 * user is a list of snapshots of their section with the run semantics:
 * a pointer walking back and forth, an edit after a run making the run a
 * step, and steps that change nothing visible being skipped. After every
 * action, each section must equal its oracle's current state.
 *
 * FUZZ_SEEDS, FUZZ_STEPS and FUZZ_SEED (one seed only) configure the run;
 * the default is short enough for CI.
 */
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 30);
const STEPS = Number(process.env.FUZZ_STEPS ?? 150);
const ONLY = process.env.FUZZ_SEED;
const FIRST = Number(process.env.FUZZ_FIRST ?? 0);

// Long runs block the worker; let Vitest's own messages through between
// seeds, or its RPC times out and the run fails.
const idle = () => new Promise((resolve) => setImmediate(resolve));

describe("fuzz against a snapshot oracle", () => {
  const seeds = ONLY
    ? [Number(ONLY)]
    : Array.from({ length: SEEDS }, (_, i) => FIRST + i + 1);
  test(`${seeds.length} seeds × ${STEPS} actions`, async () => {
    for (const seed of seeds) {
      runSeed(seed, STEPS);
      await idle();
    }
  }, 3_600_000);
});

describe("fuzz on a shared section", () => {
  const seeds = Array.from(
    { length: Math.ceil(SEEDS / 3) },
    (_, i) => FIRST + i + 1
  );
  test(`${seeds.length} seeds × ${STEPS} actions: no throws, convergence`, async () => {
    for (const seed of seeds) {
      runShared(seed, STEPS);
      await idle();
    }
  }, 3_600_000);
});
