import * as A from "@automerge/automerge";
import { expect } from "vitest";

import { stableJSON } from "../src/visible.js";
import { peers, type Peer } from "./peers.js";

type Section = {
  text: string;
  map: Record<string, unknown>;
  list: unknown[];
  records: Record<string, { title: string; x: number }>;
};
type Doc = { alice: Section; bob: Section };
type User = "alice" | "bob";

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
  };
}
type Rng = ReturnType<typeof rng>;

const empty = (): Section => ({ text: "", map: {}, list: [], records: {} });

/** A value different from `current`; equal writes are invisible to the oracle. */
function fresh(r: Rng, current: unknown): unknown {
  for (;;) {
    const v = r.next() < 0.8 ? r.int(6) : { a: r.int(3), l: [r.int(3)] };
    if (stableJSON(v) !== stableJSON(current)) return v;
  }
}

const letters = "abcxyz";
const word = (r: Rng) =>
  Array.from({ length: 1 + r.int(3) }, () => r.pick([...letters])).join("");

/** One random edit of `user`'s section. */
function edit(r: Rng, user: User, d: Doc): void {
  const s = d[user];
  const kind = r.int(14);
  switch (kind) {
    case 0:
    case 1: {
      A.splice(d, [user, "text"], r.int(s.text.length + 1), 0, word(r));
      return;
    }
    case 2: {
      if (s.text.length === 0) return edit(r, user, d);
      const at = r.int(s.text.length);
      A.splice(
        d,
        [user, "text"],
        at,
        1 + r.int(Math.min(3, s.text.length - at))
      );
      return;
    }
    case 12:
    case 13: {
      // Format a range: bold or italic (growing at the ends, as inclusive
      // marks do) or a link, set or removed.
      if (s.text.length === 0) return edit(r, user, d);
      const start = r.int(s.text.length);
      const end = start + 1 + r.int(s.text.length - start);
      const name = r.pick(["bold", "italic", "link"]);
      const expand = name === "link" ? "none" : "both";
      const range = { start, end, expand } as const;
      if (r.next() < 0.3) A.unmark(d, [user, "text"], range, name);
      else
        A.mark(
          d,
          [user, "text"],
          range,
          name,
          name === "link" ? `u${r.int(3)}` : true
        );
      return;
    }
    case 3: {
      const key = r.pick(["k0", "k1", "k2"]);
      s.map[key] = fresh(r, s.map[key]);
      return;
    }
    case 4: {
      const keys = Object.keys(s.map);
      if (keys.length === 0) return edit(r, user, d);
      delete s.map[r.pick(keys)];
      return;
    }
    case 5: {
      const key = Object.keys(s.map).find(
        (k) => typeof s.map[k] === "object" && s.map[k] !== null
      );
      if (!key) return edit(r, user, d);
      const obj = s.map[key] as { a: number; l: number[] };
      if (r.next() < 0.5) obj.a = fresh(r, obj.a) as number;
      else obj.l.push(r.int(3));
      return;
    }
    case 6: {
      s.list.splice(r.int(s.list.length + 1), 0, fresh(r, undefined));
      return;
    }
    case 7: {
      if (s.list.length === 0) return edit(r, user, d);
      s.list.splice(r.int(s.list.length), 1);
      return;
    }
    case 8: {
      if (s.list.length === 0) return edit(r, user, d);
      const i = r.int(s.list.length);
      const current = s.list[i];
      if (typeof current === "object" && current !== null && r.next() < 0.5) {
        const obj = current as { a: number };
        obj.a = fresh(r, obj.a) as number;
      } else {
        s.list[i] = fresh(r, current);
      }
      return;
    }
    case 9: {
      const id = `r${r.int(4)}`;
      if (s.records[id]) return edit(r, user, d);
      s.records[id] = { title: word(r), x: r.int(5) };
      return;
    }
    case 10: {
      const ids = Object.keys(s.records);
      if (ids.length === 0) return edit(r, user, d);
      delete s.records[r.pick(ids)];
      return;
    }
    default: {
      const ids = Object.keys(s.records);
      if (ids.length === 0) return edit(r, user, d);
      const id = r.pick(ids);
      const rec = s.records[id]!;
      const title = [user, "records", id, "title"];
      if (r.next() < 0.4) rec.x = fresh(r, rec.x) as number;
      else if (r.next() < 0.6 || rec.title.length === 0) {
        A.splice(d, title, r.int(rec.title.length + 1), 0, word(r));
      } else {
        A.splice(d, title, r.int(rec.title.length), 1);
      }
    }
  }
}

/** The snapshot oracle of one user's undo history. */
class Oracle {
  states: string[];
  run: { start: number; pointer: number } | undefined;
  current: string;

  constructor(initial: string) {
    this.states = [initial];
    this.current = initial;
  }

  /** A local edit; `joined` if the engine grouped it into the open step. */
  edited(state: string, joined: boolean) {
    this.endRun();
    if (joined) this.states[this.states.length - 1] = state;
    else this.states.push(state);
    this.current = state;
  }

  endRun() {
    const run = this.run;
    if (!run) return;
    this.run = undefined;
    if (run.pointer !== run.start) this.states.push(this.current);
  }

  undo() {
    if (!this.run) {
      const top = this.states.length - 1;
      if (top === 0) return;
      this.run = { start: top, pointer: top };
    }
    const run = this.run;
    while (run.pointer > 0) {
      run.pointer--;
      const next = this.states[run.pointer]!;
      const visible = next !== this.current;
      this.current = next;
      if (visible) break;
    }
  }

  redo() {
    const run = this.run;
    if (!run) return;
    while (run.pointer < run.start) {
      run.pointer++;
      const next = this.states[run.pointer]!;
      const visible = next !== this.current;
      this.current = next;
      if (visible) break;
    }
  }

  get steps() {
    return (
      this.states.length -
      1 +
      (this.run && this.run.pointer !== this.run.start ? 1 : 0)
    );
  }
}

/** Run one seed for `steps` actions; `log` collects what happened. */
export function runSeed(seed: number, steps: number, log?: string[]) {
  const r = rng(seed);
  const { alice, bob, sync, dispose } = peers<Doc>(
    { alice: empty(), bob: empty() },
    { groupDelayMs: 500 }
  );
  try {
    runPeers(r, seed, steps, alice, bob, sync, log);
  } finally {
    dispose();
  }
}

function runPeers(
  r: Rng,
  seed: number,
  steps: number,
  alice: Peer<Doc>,
  bob: Peer<Doc>,
  sync: () => void,
  log?: string[]
) {
  const users: Record<User, Peer<Doc>> = { alice, bob };
  // A section with its text's formatting, which its JSON doesn't show.
  const section = (p: Peer<Doc>, user: User) =>
    stableJSON({ ...p.doc()[user], marks: A.marks(p.doc(), [user, "text"]) });
  const oracles: Record<User, Oracle> = {
    alice: new Oracle(section(alice, "alice")),
    bob: new Oracle(section(bob, "bob")),
  };

  for (let i = 0; i < steps; i++) {
    const roll = r.next();
    const user: User = r.next() < 0.5 ? "alice" : "bob";
    const p = users[user];
    const oracle = oracles[user];
    let action: string;
    if (roll < 0.45) {
      action = "edit";
      const before = p.history.size;
      const runStep =
        oracle.run && oracle.run.pointer !== oracle.run.start ? 1 : 0;
      const prev = p.doc();
      p.change((d) => edit(r, user, d));
      if (A.getHeads(prev).join() === A.getHeads(p.doc()).join()) {
        action = "edit (none)";
      } else {
        const joined = p.history.size === before + runStep;
        oracle.edited(section(p, user), joined);
      }
    } else if (roll < 0.65) {
      action = "undo";
      p.history.undo();
      oracle.undo();
    } else if (roll < 0.78) {
      action = "redo";
      p.history.redo();
      oracle.redo();
    } else if (roll < 0.9) {
      action = "wait";
      p.clock.advance(1000);
    } else {
      action = "sync";
      sync();
    }
    log?.push(
      `${i} ${user} ${action} size=${p.history.size} ${section(p, user)} oracle=${oracle.current} run=${JSON.stringify(oracle.run)} states=${oracle.states.length}`
    );
    for (const u of ["alice", "bob"] as const) {
      expect(
        section(users[u], u),
        `seed ${seed} action ${i} (${user} ${action}), ${u}'s section`
      ).toBe(oracles[u].current);
    }
  }
  sync();
  expect(stableJSON(alice.doc())).toBe(stableJSON(bob.doc()));
  expect(section(alice, "alice")).toBe(oracles.alice.current);
  expect(section(bob, "bob")).toBe(oracles.bob.current);
}

/**
 * Both peers edit the same section, with undos, redos and syncs. There is
 * no oracle for this (whose edit wins depends on interleaving); it checks
 * that nothing throws and that the peers converge.
 */
export function runShared(seed: number, steps: number) {
  const r = rng(seed);
  const { alice, bob, sync, dispose } = peers<Doc>(
    { alice: empty(), bob: empty() },
    { groupDelayMs: 500 }
  );
  try {
    sharedSteps(r, steps, alice, bob, sync);
  } finally {
    dispose();
  }
}

function sharedSteps(
  r: Rng,
  steps: number,
  alice: Peer<Doc>,
  bob: Peer<Doc>,
  sync: () => void
) {
  for (let i = 0; i < steps; i++) {
    const p = r.next() < 0.5 ? alice : bob;
    const roll = r.next();
    if (roll < 0.45) p.change((d) => edit(r, "alice", d));
    else if (roll < 0.65)
      p.history.undo({ conflict: r.next() < 0.3 ? "force" : "skip" });
    else if (roll < 0.78) p.history.redo();
    else if (roll < 0.9) p.clock.advance(1000);
    else sync();
  }
  sync();
  expect(stableJSON(alice.doc())).toBe(stableJSON(bob.doc()));
}
