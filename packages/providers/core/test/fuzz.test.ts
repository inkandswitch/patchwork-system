import { next as A } from "@automerge/automerge";
import { Repo, type DocHandle } from "@automerge/automerge-repo";
import { afterAll, describe, expect, it } from "vitest";

import {
  LayeredDoc,
  createPatch,
  patchHighlights,
  textPatch,
  type PatchDoc,
} from "../src/patch-layers.js";

// Small, seeded, so a failure replays.
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Story = { content: string };
// Fresh overlays to compare against live here, and are deleted after.
const freshRepo = new Repo();
afterAll(() => freshRepo.shutdown());
const LETTERS = "abcdefghij";

describe("text patches under random edits", () => {
  // A dozen by default; FUZZ_SEEDS=200 FUZZ_STEPS=100 for a long run.
  const seeds = Number(process.env.FUZZ_SEEDS ?? 12);
  const steps = Number(process.env.FUZZ_STEPS ?? 40);
  // FUZZ_ONLY=94,100 replays just those. Seeds that once found a bug are
  // always run.
  const caught = [21, 33, 94, 95, 96, 100, 123];
  const only = process.env.FUZZ_ONLY?.split(",").map(Number);
  const all = Array.from({ length: seeds }, (_, i) => i + 1);
  for (const seed of only ?? [...all, ...caught.filter((c) => c > seeds)]) {
    it(`seed ${seed}: types what you typed, and agrees with a fresh overlay`, async () => {
      const rand = random(seed);
      const int = (n: number) => Math.floor(rand() * n);
      const word = (n: number) =>
        Array.from({ length: n }, () => LETTERS[int(LETTERS.length)]).join("");

      const repo = new Repo();
      const scratch = new Repo();
      const story = repo.create<Story>({ content: word(30) });

      // Two patches, a few runs each, not overlapping.
      const layers: DocHandle<PatchDoc>[] = [];
      const taken: [number, number][] = [];
      for (let p = 0; p < 2; p++) {
        const entries = [];
        for (let k = 0; k < 2; k++) {
          const start = int(28);
          const end = start + int(3);
          if (taken.some(([s, e]) => start <= e && s <= end)) continue;
          taken.push([start, end]);
          entries.push(textPatch(story, ["content"], start, end, word(1 + int(4))));
        }
        const patch = createPatch(repo, story, entries);
        if (p === 0 && rand() < 0.5) patch.change((d) => void (d.record = true));
        layers.push(patch);
      }

      const layered = new LayeredDoc(story, layers, scratch);
      const log: string[] = [];
      const length = caught.includes(seed) ? Math.max(steps, 60) : steps;
      for (let step = 0; step < length; step++) {
        const shown = layered.handle.doc().content;
        const r = rand();
        if (r < 0.35) {
          const at = int(shown.length + 1);
          const text = word(1 + int(3));
          log.push(`type ${JSON.stringify(text)} at ${at}`);
          layered.handle.change((d) => A.splice(d, ["content"], at, 0, text));
          expect(layered.handle.doc().content, log.join("\n")).toBe(
            shown.slice(0, at) + text + shown.slice(at)
          );
        } else if (r < 0.6 && shown.length > 0) {
          const at = int(shown.length);
          const n = Math.min(1 + int(4), shown.length - at);
          log.push(`delete ${n} at ${at}`);
          layered.handle.change((d) => A.splice(d, ["content"], at, n));
          expect(layered.handle.doc().content, log.join("\n")).toBe(
            shown.slice(0, at) + shown.slice(at + n)
          );
        } else {
          const base = story.doc().content;
          const at = int(base.length + 1);
          const n = rand() < 0.5 ? 0 : Math.min(int(4), base.length - at);
          const text = n && rand() < 0.5 ? "" : word(1 + int(3));
          log.push(`document: replace ${n} at ${at} with ${JSON.stringify(text)}`);
          story.change((d) => A.splice(d, ["content"], at, n, text));
        }

        if (process.env.FUZZ_TRACE) {
          console.log(
            `${log.at(-1)}\n  shown ${JSON.stringify(layered.handle.doc().content)}\n  base  ${JSON.stringify(story.doc().content)}\n  runs  ${JSON.stringify(patchHighlights(layered.handle, ["content"]).map((h) => [h.start, h.end, h.base?.start, h.base?.end]))}\n` +
              layers.map((l) => `  ${JSON.stringify(l.doc().patches.map((e) => {
                if (!("text" in e)) return e;
                const pos = (c?: string) => { try { return c === undefined ? null : A.getCursorPosition(story.doc(), ["content"], c); } catch { return "x"; } };
                return `${e.text.to ? "r" : "i"}:${e.text.insert} from=${pos(e.text.from)} to=${pos(e.text.to)} around=${e.text.around?.map(pos)}`;
              }))}${l.doc().record ? " rec" : ""}`).join("\n")
          );
        }
        const fresh = new LayeredDoc(story, layers, freshRepo);
        expect(layered.handle.doc().content, log.join("\n")).toBe(
          fresh.handle.doc().content
        );
        fresh.dispose();
        freshRepo.delete(fresh.handle.documentId);
      }
      layered.dispose();
      await Promise.all([repo.shutdown(), scratch.shutdown()]);
    });
  }
});

describe("list patches under random edits", () => {
  const seeds = Number(process.env.FUZZ_SEEDS ?? 12);
  const steps = Number(process.env.FUZZ_STEPS ?? 40);
  for (let seed = 1; seed <= seeds; seed++) {
    it(`seed ${seed}: agrees with a fresh overlay`, async () => {
      const rand = random(seed * 7919);
      const int = (n: number) => Math.floor(rand() * n);
      const repo = new Repo();
      const scratch = new Repo();
      type Grid = { cells: number[] };
      const grid = repo.create<Grid>({ cells: Array.from({ length: 8 }, (_, i) => i) });
      // Puts and hides on a few indexes.
      const entries = Array.from({ length: 3 }, () =>
        rand() < 0.4 ? { path: ["cells", int(8)] } : { path: ["cells", int(8)], value: 100 + int(100) }
      );
      const patch = createPatch(repo, grid, entries);
      const layered = new LayeredDoc(grid, [patch], scratch);
      const log: string[] = [JSON.stringify(entries)];
      for (let step = 0; step < steps; step++) {
        const r = rand();
        const shown = layered.handle.doc().cells;
        if (r < 0.4 && shown.length > 0) {
          const i = int(shown.length);
          const v = 1000 + step;
          log.push(`overlay: cells[${i}] = ${v}`);
          layered.handle.change((d) => {
            d.cells[i] = v;
          });
          expect(layered.handle.doc().cells[i], log.join("\n")).toBe(v);
        } else {
          const base = grid.doc().cells;
          const i = int(base.length + 1);
          if (rand() < 0.5 || base.length < 2) {
            log.push(`document: insert at ${i}`);
            grid.change((d) => void d.cells.insertAt(i, -1 - step));
          } else {
            const at = Math.min(i, base.length - 1);
            log.push(`document: delete at ${at}`);
            grid.change((d) => void d.cells.deleteAt(at));
          }
        }
        const fresh = new LayeredDoc(grid, [patch], freshRepo);
        expect(layered.handle.doc().cells, log.join("\n")).toEqual(fresh.handle.doc().cells);
        fresh.dispose();
        freshRepo.delete(fresh.handle.documentId);
      }
      layered.dispose();
      await Promise.all([repo.shutdown(), scratch.shutdown()]);
    });
  }
});
