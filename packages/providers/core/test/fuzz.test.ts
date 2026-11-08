// Seeded fuzzing of the overlay against the real repo. Every run is
// reproducible: a failure names its seed and the steps taken, and
// `FUZZ_SEED=<n> vitest run test/fuzz.test.ts` replays just that run.
// `FUZZ_RUNS=<n>` runs more seeds.
import { next as A } from "@automerge/automerge";
import {
  Repo,
  cursor,
  generateAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type QueryState,
  type UrlHeads,
} from "@automerge/automerge-repo";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getScratchRepo, type DocHandleDescriptor } from "../src/index.js";
import { backedBy, mount, rebase, rng, settle, unmountAll } from "./harness.js";

type Note = {
  title: string;
  text: string;
  nested: { x: { y: number } };
  items: { id: string; v: number }[];
};
type H = DocHandle<any>;
type Rng = ReturnType<typeof rng>;

const RUNS = Number(process.env.FUZZ_RUNS ?? 40);
const ONLY = process.env.FUZZ_SEED;
const seeds = ONLY
  ? [Number(ONLY)]
  : Array.from({ length: RUNS }, (_, i) => 1 + i * 7919);

const scratch = getScratchRepo();
const EVENTS = ["change", "heads-changed", "delete"] as const;
const IDS = ["a", "b", "c", "d", "e"];

const initial = (): Note => ({
  title: "note",
  text: "hello world",
  nested: { x: { y: 1 } },
  items: [
    { id: "a", v: 1 },
    { id: "b", v: 2 },
  ],
});

function mutate(d: Note, r: Rng): void {
  switch (r.int(6)) {
    case 0:
      d.title = `t${r.int(100)}`;
      break;
    case 1:
      if (d.nested?.x) d.nested.x.y = r.int(100);
      break;
    case 2:
      d.nested = { x: { y: r.int(100) } };
      break;
    case 3:
      d.items.unshift({ id: r.pick(IDS), v: r.int(100) });
      break;
    case 4:
      if (d.items.length > 0) d.items.splice(r.int(d.items.length), 1);
      break;
    case 5: {
      const length = d.text.length;
      const at = r.int(length + 1);
      A.splice(
        d,
        ["text"],
        at,
        r.int(Math.min(3, length - at) + 1),
        "xyz".slice(r.int(3))
      );
      break;
    }
  }
}

// A path under the root, for a document shaped like `doc`.
function randomPath(doc: Note, r: Rng): unknown[] {
  const length = doc.text?.length ?? 0;
  switch (r.int(7)) {
    case 0:
      return ["title"];
    case 1:
      return ["nested"];
    case 2:
      return ["nested", "x"];
    case 3:
      return ["nested", "x", "y"];
    case 4:
      return ["items", r.int(3)];
    case 5:
      return ["items", { id: r.pick(IDS) }];
    default: {
      const start = r.int(length + 1);
      return ["text", cursor(start, start + r.int(length - start + 1))];
    }
  }
}

// The real handle an overlay handle's url names on `backing`.
function oracle(backing: H, url: AutomergeUrl): H {
  const { segments, heads } = parseAutomergeUrl(url);
  let handle = heads ? backing.view(heads) : backing;
  if (segments?.length) handle = handle.sub(...segments);
  return handle;
}

const backingOf = (h: H): H => (h as any).backingHandle;

type Tracked = {
  h: H;
  /** For a view: its heads and what it showed when made. */
  view?: { heads: UrlHeads; snapshot: unknown };
  detached?: boolean;
};

type Recorder = {
  owner: Tracked;
  event: string;
  fn: (p: any) => void;
  log: any[];
};

describe("fuzz: handles across edits and swaps", () => {
  afterEach(unmountAll);

  for (const seed of seeds) {
    it(`seed ${seed}`, async () => {
      const r = rng(seed);
      const steps: string[] = [];
      const repo = new Repo();
      const note = repo.create<Note>(initial());
      // Backings: the note itself, clones that diverge, and scratch forks.
      const pool: { handle: H; descriptor: DocHandleDescriptor }[] = [
        { handle: note, descriptor: { url: note.url } },
      ];
      for (let i = 0; i < 3; i++) {
        const clone = repo.clone(note);
        for (let j = r.int(3); j > 0; j--) clone.change((d) => mutate(d, r));
        pool.push({
          handle: clone,
          descriptor: { url: note.url, cloneUrl: clone.url },
        });
      }
      for (let i = 0; i < 2; i++) {
        const laid = scratch.create<Note>();
        laid.update(() => A.clone(note.doc()));
        for (let j = r.int(3); j > 0; j--) laid.change((d) => mutate(d, r));
        pool.push({
          handle: laid,
          descriptor: { url: note.url, scratchUrl: laid.url },
        });
      }
      // What each backing root listens to before the overlay touches it.
      const baseline = new Map(
        pool.map(({ handle }) => [
          handle,
          Object.fromEntries(
            EVENTS.map((ev) => [ev, handle.listenerCount(ev)])
          ),
        ])
      );

      const view = mount(repo);
      let current = r.pick(pool);
      view.route(note.url, current.descriptor);
      const root = await view.overlay.find<Note>(note.url);
      const tracked: Tracked[] = [{ h: root }];
      const recorders: Recorder[] = [];
      const seenBackings = new Set<H>([backingOf(root)]);

      const track = (h: H, viewOf?: UrlHeads) => {
        let entry = tracked.find((t) => t.h === h);
        if (!entry) {
          entry = {
            h,
            view: viewOf && {
              heads: viewOf,
              snapshot: structuredClone(h.doc()),
            },
          };
          tracked.push(entry);
        }
        seenBackings.add(backingOf(h));
        return entry;
      };

      const check = (label: string) => {
        const where = `seed ${seed}, after ${label}\n  ${steps.join("\n  ")}`;
        for (const t of tracked) {
          const { h } = t;
          expect(parseAutomergeUrl(h.url).documentId, where).toBe(
            note.documentId
          );
          if (t.view) {
            // A view is a snapshot, whatever happens to its backing.
            expect(h.doc(), `${where}\n  view ${h.url}`).toEqual(
              t.view.snapshot
            );
            if (t.detached) continue;
          }
          const expected = oracle(current.handle, h.url);
          expect(
            backingOf(h) === expected,
            `${where}\n  backing of ${h.url}`
          ).toBe(true);
          expect(h.url, where).toBe(rebase(expected.url, note.url));
          expect(h.doc(), `${where}\n  doc of ${h.url}`).toEqual(
            expected.doc()
          );
          for (const ev of EVENTS) {
            const ours = recorders.filter(
              (x) => x.owner === t && x.event === ev
            );
            expect(h.listenerCount(ev), where).toBe(ours.length);
          }
        }
        // Nothing still listens on a backing it no longer forwards from; on a
        // live one, one forwarder per event someone listens for.
        for (const b of seenBackings) {
          for (const ev of EVENTS) {
            const forwarding = tracked.some(
              (t) =>
                !t.detached && backingOf(t.h) === b && t.h.listenerCount(ev) > 0
            );
            const base = (baseline.get(b) as any)?.[ev] ?? 0;
            expect(
              b.listenerCount(ev),
              `${where}\n  listeners for ${ev} on ${b.url}`
            ).toBe(base + (forwarding ? 1 : 0));
          }
        }
        expect(view.openLeases(), where).toBe(
          current.descriptor.scratchUrl ? 1 : 0
        );
      };

      check("setup");
      for (let step = 0; step < 40; step++) {
        const t = r.pick(tracked);
        const lengths = recorders.map((x) => x.log.length);
        const op = r.int(9);
        let label: string;
        if (op === 0 && !t.view) {
          const path = randomPath(current.handle.doc() as Note, r);
          label = `sub ${JSON.stringify(path)} of ${t.h.url}`;
          const fromRoot = root.sub(...path);
          track(fromRoot);
          // However it's reached, the same url is the same wrapper.
          expect(root.sub(...path), label).toBe(fromRoot);
          if (path.length > 1 && typeof path[0] === "string") {
            expect(root.sub(path[0]).sub(...path.slice(1)), label).toBe(
              fromRoot
            );
          }
        } else if (op === 1) {
          const history = current.handle.history();
          const heads = r.pick(history);
          label = `view at ${heads} of ${t.h.url}`;
          const made = (t.view ? root : t.h).view(heads);
          track(made, heads);
          expect(parseAutomergeUrl(made.url).heads, label).toEqual(heads);
        } else if (op === 2 && !t.view) {
          label = `change through ${t.h.url}`;
          try {
            if (t.h === root) root.change((d) => mutate(d, r));
            else {
              const scoped = t.h.doc();
              if (typeof scoped === "string") t.h.change(`s${r.int(9)}`);
              else if (scoped && typeof scoped === "object" && "y" in scoped)
                t.h.change((d: { y: number }) => {
                  d.y = r.int(100);
                });
              else root.change((d) => mutate(d, r));
            }
          } catch {
            // A path that doesn't resolve can't be written; the real handle
            // throws the same way.
          }
        } else if (op === 3) {
          label = `remote change on ${current.handle.url}`;
          current.handle.change((d: Note) => mutate(d, r));
        } else if (op === 4) {
          const other = r.pick(pool);
          label = `change on bystander ${other.handle.url}`;
          other.handle.change((d: Note) => mutate(d, r));
        } else if (op === 5) {
          const event = r.pick(EVENTS);
          label = `listen for ${event} on ${t.h.url}`;
          const recorder: Recorder = {
            owner: t,
            event,
            log: [],
            fn: (p) =>
              recorder.log.push({
                self: p?.handle === t.h,
                doc: structuredClone(p?.doc),
                patches: p?.patches,
                scopeReplaced: p?.scopeReplaced,
              }),
          };
          t.h.on(event, recorder.fn);
          recorders.push(recorder);
        } else if (op === 6 && recorders.length > 0) {
          const recorder = r.pick(recorders);
          label = `stop listening for ${recorder.event} on ${recorder.owner.h.url}`;
          recorder.owner.h.off(recorder.event as "change", recorder.fn);
          recorders.splice(recorders.indexOf(recorder), 1);
        } else if (op === 7) {
          const next = r.pick(pool.filter((b) => b !== current));
          label = `swap to ${next.handle.url}`;
          steps.push(label);
          const before = new Map(tracked.map((x) => [x, x.h.heads()]));
          const previous = current;
          current = next;
          view.route(note.url, next.descriptor);
          await backedBy(root, next.handle);
          // The old lease is let go at once, but the remapper hears of it a
          // MessagePort hop later.
          await vi.waitFor(() =>
            expect(view.openLeases()).toBe(next.descriptor.scratchUrl ? 1 : 0)
          );
          for (const x of tracked) {
            if (
              x.view &&
              !x.detached &&
              !next.handle.containsHeads(x.view.heads)
            )
              x.detached = true;
            if (!x.detached) seenBackings.add(backingOf(x.h));
          }
          // Each listening handle hears about the swap exactly once, as a
          // whole-scope replacement, unless it's a view left behind.
          recorders.forEach((x, i) => {
            const fresh = x.log.slice(lengths[i] ?? 0);
            const o = x.owner;
            if (o.detached || x.event === "delete") {
              expect(fresh, label).toEqual([]);
              return;
            }
            if (x.event === "heads-changed") {
              const moved = before.get(o)!.join() !== o.h.heads().join();
              expect(fresh.length, label).toBe(moved ? 1 : 0);
              return;
            }
            expect(fresh, `${label} (${o.h.url})`).toEqual([
              {
                self: true,
                doc: o.h.doc(),
                patches: [],
                scopeReplaced: true,
              },
            ]);
          });
          void previous;
          check(label);
          continue;
        } else if (op === 8 && !t.view) {
          label = `find ${t.h.url}`;
          expect(await view.overlay.find(t.h.url), label).toBe(t.h);
        } else {
          continue;
        }
        steps.push(label);
        // Every event a recorder heard came stamped with its own handle, and
        // came from its backing (there's a real listener-for-listener mirror
        // in the backing check above).
        recorders.forEach((x, i) => {
          for (const e of x.log.slice(lengths[i] ?? 0)) {
            expect(e.self, `${label}: ${x.event} on ${x.owner.h.url}`).toBe(
              true
            );
          }
        });
        check(label);
      }

      view.overlay.dispose();
      await vi.waitFor(() => expect(view.openLeases()).toBe(0), {
        timeout: 2000,
      });
      for (const b of seenBackings) {
        for (const ev of EVENTS) {
          expect(b.listenerCount(ev)).toBe((baseline.get(b) as any)?.[ev] ?? 0);
        }
      }
    });
  }
});

describe("fuzz: descriptor races", () => {
  afterEach(unmountAll);

  for (const seed of seeds) {
    it(`seed ${seed}`, async () => {
      const r = rng(seed);
      const steps: string[] = [];
      const repo = new Repo();
      const note = repo.create<Note>(initial());
      const clones = [repo.clone(note), repo.clone(note)];
      const laid = scratch.create<Note>();
      laid.update(() => A.clone(note.doc()));
      // A document nobody has, until it arrives.
      const missing = generateAutomergeUrl();
      // Heads the third clone doesn't have, until they arrive.
      const late = repo.clone(note);
      const ahead = new Repo().import<Note>(A.save(late.doc()));
      ahead.change((d) => {
        d.title = "ahead";
      });
      const pinnedLate = stringifyAutomergeUrl({
        documentId: late.documentId,
        heads: ahead.heads(),
      });

      const available: DocHandleDescriptor[] = [
        { url: note.url },
        ...clones.map((c) => ({ url: note.url, cloneUrl: c.url })),
        { url: note.url, scratchUrl: laid.url },
      ];
      const candidates: DocHandleDescriptor[] = [
        ...available,
        { url: note.url, cloneUrl: missing },
        { url: note.url, cloneUrl: pinnedLate },
      ];

      const view = mount(repo);
      const finds: { label: string; promise: Promise<H>; settled?: string }[] =
        [];
      const progressions: string[][] = [];

      const find = (url: AutomergeUrl, signal?: AbortSignal) => {
        const label = `find ${url}`;
        const entry = {
          label,
          promise: view.overlay.find(url, { signal }),
          settled: undefined as string | undefined,
        };
        entry.promise.then(
          () => (entry.settled = "resolved"),
          () => (entry.settled = "rejected")
        );
        finds.push(entry);
      };

      for (let step = 0; step < 30; step++) {
        const op = r.int(7);
        if (op === 0 || op === 1) {
          const answer = r.pick(candidates);
          steps.push(
            `answer ${answer.scratchUrl ?? answer.cloneUrl ?? answer.url}`
          );
          view.route(note.url, answer);
        } else if (op === 2) {
          steps.push("find root");
          find(note.url);
        } else if (op === 3) {
          steps.push("find nested.x");
          find(note.sub("nested", "x").url);
        } else if (op === 4) {
          steps.push("subscribe to progress");
          // Transitions only, so start from what it says now.
          const progress = view.overlay.findWithProgress(note.url);
          const seen: string[] = [progress.peek().state];
          progress.subscribe((s: QueryState<unknown>) => seen.push(s.state));
          progressions.push(seen);
        } else if (op === 5) {
          const controller = new AbortController();
          steps.push("find root, then abort");
          find(note.url, controller.signal);
          setTimeout(() => controller.abort(new Error("aborted")), r.int(3));
        } else {
          const which = r.int(3);
          if (which === 0) {
            steps.push("missing document arrives");
            repo.import(A.save(note.doc()), {
              docId: parseAutomergeUrl(missing).documentId,
            });
          } else if (which === 1) {
            steps.push("late heads arrive");
            late.merge(ahead as any);
          } else {
            steps.push("settle");
            await settle(r.int(3));
          }
        }
        if (r.chance(0.3)) await settle(r.int(2));
      }

      // End on something that's there, and let everything land.
      const final = r.pick(available);
      steps.push(
        `answer ${final.scratchUrl ?? final.cloneUrl ?? final.url} (final)`
      );
      view.route(note.url, final);
      const where = `seed ${seed}\n  ${steps.join("\n  ")}`;
      const finalBacking: H = final.scratchUrl
        ? await scratch.find(final.scratchUrl)
        : await repo.find(final.cloneUrl ?? final.url);
      const handle = await view.overlay.find<Note>(note.url);
      await backedBy(handle, finalBacking);
      await settle(5);

      // No find is left hanging, and every one that resolved got the one
      // wrapper (or its sub), now showing the final backing.
      for (const f of finds) {
        expect(f.settled, `${where}\n  ${f.label} never settled`).toBeDefined();
        if (f.settled !== "resolved") continue;
        const found = await f.promise;
        const { segments } = parseAutomergeUrl(found.url);
        expect(found, `${where}\n  ${f.label}`).toBe(
          segments?.length ? handle.sub(...segments) : handle
        );
      }
      expect(handle.url).toBe(note.url);
      expect(handle.doc(), where).toEqual(finalBacking.doc());
      const state = view.overlay.findWithProgress(note.url).peek();
      expect(state.state, where).toBe("ready");
      for (const seen of progressions) {
        expect(seen.at(-1), `${where}\n  progress saw ${seen}`).toBe("ready");
      }
      // One descriptor subscription for the document, and a lease only on a
      // scratch backing.
      expect(view.subscribers(note.url), where).toBe(1);
      // A released lease reaches the remapper a MessagePort hop later, and
      // under load that hop can take a while.
      await vi.waitFor(
        () => expect(view.openLeases(), where).toBe(final.scratchUrl ? 1 : 0),
        { timeout: 2000 }
      );

      view.overlay.dispose();
      await vi.waitFor(
        () => {
          expect(view.openLeases(), where).toBe(0);
          expect(view.subscribers(note.url), where).toBe(0);
        },
        { timeout: 2000 }
      );
    });
  }
});
