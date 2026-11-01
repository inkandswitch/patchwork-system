import * as A from "@automerge/automerge";
import { Repo } from "@automerge/automerge-repo";
import { test } from "vitest";

import { UndoHistory } from "../src/history.js";

/**
 * The cost of the service on long documents with long histories:
 * BENCH=1 vitest run test/bench.test.ts
 *
 * Each document is typed in changes of 10 characters (10 000 characters
 * are 1 000 changes), so the history is as long as the text.
 */
function setup(chars: number, withHistory: boolean) {
  const handle = new Repo().create({ t: "" });
  let t = 0;
  const history = withHistory
    ? new UndoHistory(handle as never, { now: () => t })
    : undefined;
  const chunk = "abcdefghij";
  for (let i = 0; i < chars / chunk.length; i++) {
    handle.change((d) => A.splice(d, ["t"], i * chunk.length, 0, chunk));
    t += 1000;
  }
  return { handle, history, tick: () => (t += 1000) };
}

function time(n: number, fn: (i: number) => void): number {
  const start = performance.now();
  for (let i = 0; i < n; i++) fn(i);
  return (performance.now() - start) / n;
}

test.skipIf(!process.env.BENCH)(
  "cost per change and per undo",
  () => {
    const rows: string[] = [
      "| characters | change, no history | change, recorded | undo a typed step | undo a 1 000-char deletion | redo |",
      "|---|---|---|---|---|---|",
    ];
    const sizes = (process.env.BENCH_SIZES ?? "10000,100000")
      .split(",")
      .map(Number);
    for (const chars of sizes) {
      const plain = setup(chars, false);
      const base = time(200, (i) =>
        plain.handle.change((d) => A.splice(d, ["t"], i, 0, "x"))
      );

      const s = setup(chars, true);
      const history = s.history!;
      const recorded = time(200, (i) => {
        s.tick();
        s.handle.change((d) => A.splice(d, ["t"], i, 0, "x"));
        history.size; // take the change in
      });

      const undo = time(20, () => history.undo());

      s.tick();
      s.handle.change((d) => A.splice(d, ["t"], 5_000, 1_000));
      const deletion = time(1, () => history.undo());
      const redo = time(1, () => history.redo());

      const ms = (x: number) => `${x.toFixed(2)} ms`;
      rows.push(
        `| ${chars.toLocaleString("en")} | ${ms(base)} | ${ms(recorded)} | ${ms(undo)} | ${ms(deletion)} | ${ms(redo)} |`
      );
    }
    console.log(rows.join("\n"));
  },
  600_000
);
