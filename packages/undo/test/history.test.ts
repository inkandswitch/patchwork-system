import * as A from "@automerge/automerge";
import { describe, expect, test } from "vitest";

import { json, peers, solo, type Peer } from "./peers.js";

const type = <T>(p: Peer<T>, path: A.Prop[], text: string, at?: number) => {
  p.change((d) => {
    let value: unknown = d;
    for (const prop of path) value = (value as Record<A.Prop, unknown>)[prop];
    A.splice(d, path, at ?? (value as string).length, 0, text);
  });
};

describe("the collaboration scenario", () => {
  test("Alice and Bob in separate sections", () => {
    const { alice, bob, sync } = peers({ alice: "", bob: "" });
    const steps: Array<[string, () => void, string, string]> = [];
    const edit =
      (
        p: Peer<{ alice: string; bob: string }>,
        key: "alice" | "bob",
        letter: string
      ) =>
      () => {
        p.clock.advance(1000);
        type(p, [key], letter);
      };
    const undo = (p: Peer<unknown>) => () => {
      p.history.undo();
    };
    steps.push(
      ["Alice A", edit(alice, "alice", "A"), "A", ""],
      ["Bob B", edit(bob, "bob", "B"), "A", "B"],
      ["Alice C", edit(alice, "alice", "C"), "AC", "B"],
      ["Bob D", edit(bob, "bob", "D"), "AC", "BD"],
      ["Alice E", edit(alice, "alice", "E"), "ACE", "BD"],
      ["Bob F", edit(bob, "bob", "F"), "ACE", "BDF"],
      ["Alice undoes E", undo(alice), "AC", "BDF"],
      ["Alice undoes C (with E, one step G)", undo(alice), "A", "BDF"],
      ["Bob H", edit(bob, "bob", "H"), "A", "BDFH"],
      ["Alice I", edit(alice, "alice", "I"), "AI", "BDFH"],
      ["Bob undoes H", undo(bob), "AI", "BDF"],
      ["Alice undoes I", undo(alice), "A", "BDF"],
      ["Alice undoes G, bringing back C and E", undo(alice), "ACE", "BDF"],
      ["Alice undoes E", undo(alice), "AC", "BDF"],
      ["Bob L", edit(bob, "bob", "L"), "AC", "BDFL"]
    );
    for (const [name, act, a, b] of steps) {
      act();
      sync();
      for (const p of [alice, bob]) {
        expect(p.doc(), name).toEqual({ alice: a, bob: b });
      }
    }
  });
});

describe("steps", () => {
  test("redo walks forward through the run", () => {
    const p = solo({ t: "" });
    for (const letter of "abc") {
      p.clock.advance(1000);
      type(p, ["t"], letter);
    }
    p.history.undo();
    p.history.undo();
    expect(p.doc().t).toBe("a");
    expect(p.history.canRedo).toBe(true);
    p.history.redo();
    expect(p.doc().t).toBe("ab");
    p.history.redo();
    expect(p.doc().t).toBe("abc");
    expect(p.history.canRedo).toBe(false);
    expect(p.history.redo().applied).toBe(false);
  });

  test("redo exists only inside a run", () => {
    const p = solo({ t: "" });
    type(p, ["t"], "a");
    p.history.undo();
    p.clock.advance(1000);
    type(p, ["t"], "b");
    expect(p.history.canRedo).toBe(false);
  });

  test("changes less than groupDelayMs apart form one step", () => {
    const p = solo({ t: "" });
    for (const letter of "hello") type(p, ["t"], letter);
    p.clock.advance(600);
    type(p, ["t"], "!");
    expect(p.history.size).toBe(2);
    p.history.undo();
    expect(p.doc().t).toBe("hello");
    p.history.undo();
    expect(p.doc().t).toBe("");
  });

  test("a text edit joins only if it touches the step's range", () => {
    const p = solo({ t: "0123456789" });
    type(p, ["t"], "a", 2);
    type(p, ["t"], "b", 3);
    type(p, ["t"], "c", 9);
    expect(p.history.size).toBe(2);
    p.history.undo();
    expect(p.doc().t).toBe("01ab23456789");
  });

  test("checkpoint() ends the step", () => {
    const p = solo({ t: "" });
    type(p, ["t"], "a");
    p.history.checkpoint();
    type(p, ["t"], "b");
    expect(p.history.size).toBe(2);
  });

  test("an undo run that returns to its start leaves no step", () => {
    const p = solo({ t: "" });
    type(p, ["t"], "a");
    p.history.undo();
    p.history.redo();
    p.clock.advance(1000);
    type(p, ["t"], "b");
    expect(p.history.size).toBe(2);
  });

  test("the run becomes a step: nothing undone is unreachable", () => {
    const p = solo({ t: "" });
    for (const letter of "abc") {
      p.clock.advance(1000);
      type(p, ["t"], letter);
    }
    p.history.undo();
    p.history.undo();
    p.clock.advance(1000);
    type(p, ["t"], "X");
    expect(p.doc().t).toBe("aX");
    p.history.undo();
    expect(p.doc().t).toBe("a");
    p.history.undo();
    expect(p.doc().t).toBe("abc");
    p.history.undo();
    expect(p.doc().t).toBe("ab");
  });

  test("steps that change nothing visible are skipped", () => {
    const p = solo<{ t: string; k: number; o: { a: number } }>({
      t: "",
      k: 1,
      o: { a: 1 },
    });
    p.clock.advance(1000);
    p.change((d) => {
      d.k = 2;
    });
    p.clock.advance(1000);
    // typed and deleted within one step
    type(p, ["t"], "x");
    p.change((d) => A.splice(d, ["t"], 0, 1));
    p.clock.advance(1000);
    // an equal object re-created: patches, but nothing visible
    p.change((d) => {
      d.o = { a: 1 };
    });
    expect(p.history.size).toBe(3);
    const result = p.history.undo();
    expect(result.applied).toBe(true);
    expect(p.doc().k).toBe(1);
    expect(p.history.canUndo).toBe(false);
    p.history.redo();
    expect(p.doc().k).toBe(2);
    // The invisible steps after it are crossed by the next press, which
    // shows nothing.
    expect(p.history.redo().applied).toBe(false);
    expect(p.history.canRedo).toBe(false);
  });

  test("remote changes are never undone", () => {
    const { alice, bob, sync } = peers({ t: "" });
    type(alice, ["t"], "a");
    sync();
    type(bob, ["t"], "b");
    sync();
    expect(alice.history.size).toBe(1);
    alice.history.undo();
    expect(alice.doc().t).toBe("b");
    expect(alice.history.canUndo).toBe(false);
  });
});

describe("text", () => {
  test("both peers edit one text", () => {
    const { alice, bob, sync } = peers({ t: "" });
    type(alice, ["t"], "hello");
    sync();
    bob.clock.advance(1000);
    type(bob, ["t"], " world");
    sync();
    alice.clock.advance(1000);
    type(alice, ["t"], "!", 5);
    sync();
    expect(alice.doc().t).toBe("hello! world");
    alice.history.undo();
    sync();
    expect(bob.doc().t).toBe("hello world");
    alice.history.undo();
    sync();
    expect(bob.doc().t).toBe(" world");
    bob.history.undo();
    sync();
    expect(alice.doc().t).toBe("");
    alice.history.redo();
    sync();
    expect(alice.doc().t).toBe("hello");
  });

  test("undoing a deletion around a concurrent insertion", () => {
    const { alice, bob, sync } = peers({ t: "<hello world>" });
    alice.change((d) => A.splice(d, ["t"], 0, 13));
    bob.change((d) => A.splice(d, ["t"], 6, 0, "X"));
    sync();
    alice.history.undo();
    sync();
    expect(bob.doc().t).toBe("<helloX world>");
  });

  test("a Delete-key run is restored in order", () => {
    const p = solo({ t: "hello world" });
    for (let i = 0; i < 5; i++) p.change((d) => A.splice(d, ["t"], 0, 1));
    expect(p.doc().t).toBe(" world");
    expect(p.history.size).toBe(1);
    p.history.undo();
    expect(p.doc().t).toBe("hello world");
  });

  test("a Backspace run is restored in order", () => {
    const p = solo({ t: "hello world" });
    for (let i = 11; i > 6; i--) p.change((d) => A.splice(d, ["t"], i - 1, 1));
    expect(p.doc().t).toBe("hello ");
    p.history.undo();
    expect(p.doc().t).toBe("hello world");
  });

  test("deletions across several steps come back in order", () => {
    const p = solo({ t: "abc" });
    p.change((d) => A.splice(d, ["t"], 1, 1));
    p.clock.advance(1000);
    p.change((d) => A.splice(d, ["t"], 1, 1));
    p.clock.advance(1000);
    p.change((d) => A.splice(d, ["t"], 0, 1));
    p.history.undo();
    expect(p.doc().t).toBe("a");
    p.history.undo();
    expect(p.doc().t).toBe("ac");
    p.history.undo();
    expect(p.doc().t).toBe("abc");
  });

  test("the realm's characters go even where others typed between them", () => {
    const { alice, bob, sync } = peers({ t: "" });
    type(alice, ["t"], "abcd");
    sync();
    bob.change((d) => A.splice(d, ["t"], 2, 0, "XY"));
    sync();
    alice.history.undo();
    expect(alice.doc().t).toBe("XY");
  });
});

describe("maps", () => {
  test("a value someone else changed since is skipped by default", () => {
    const { alice, bob, sync } = peers<{ k: number }>({ k: 0 });
    alice.change((d) => {
      d.k = 1;
    });
    sync();
    bob.change((d) => {
      d.k = 2;
    });
    sync();
    const result = alice.history.undo();
    expect(alice.doc().k).toBe(2);
    expect(result.skipped).toEqual([{ path: ["k"], reason: "conflict" }]);
  });

  test("a concurrent value is a conflict too", () => {
    const { alice, bob, sync } = peers<{ k: number }>({ k: 0 });
    alice.change((d) => {
      d.k = 1;
    });
    bob.change((d) => {
      d.k = 2;
    });
    sync();
    expect(alice.history.undo().skipped).toHaveLength(1);
  });

  test("conflict: force restores anyway", () => {
    const { alice, bob, sync } = peers<{ k: number }>({ k: 0 });
    alice.change((d) => {
      d.k = 1;
    });
    sync();
    bob.change((d) => {
      d.k = 2;
    });
    sync();
    const result = alice.history.undo({ conflict: "force" });
    expect(alice.doc().k).toBe(0);
    expect(result.skipped).toEqual([]);
  });

  test("others' keys are left alone", () => {
    const { alice, bob, sync } = peers<Record<string, number>>({});
    alice.change((d) => {
      d.a = 1;
    });
    bob.change((d) => {
      d.b = 2;
    });
    sync();
    alice.history.undo();
    expect(alice.doc()).toEqual({ b: 2 });
  });

  test("counters are incremented back", () => {
    const { alice, bob, sync } = peers({ c: new A.Counter(10) });
    alice.change((d) => d.c.increment(5));
    sync();
    bob.change((d) => d.c.increment(100));
    sync();
    alice.history.undo();
    sync();
    expect(bob.doc().c.value).toBe(110);
    alice.history.redo();
    expect(alice.doc().c.value).toBe(115);
  });

  test("a deleted object is restored, then its own edits", () => {
    const p = solo<any>({ m: { a: 1, t: "hi", l: [1, { x: 2 }] } });
    p.change((d) => A.splice(d, ["m", "t"], 2, 0, "!"));
    p.clock.advance(1000);
    p.change((d) => {
      d.m.l[1].x = 3;
    });
    p.clock.advance(1000);
    p.change((d) => {
      delete d.m;
    });
    p.history.undo();
    expect(json(p.doc())).toEqual({ m: { a: 1, t: "hi!", l: [1, { x: 3 }] } });
    p.history.undo();
    expect(json(p.doc())).toEqual({ m: { a: 1, t: "hi!", l: [1, { x: 2 }] } });
    p.history.undo();
    expect(json(p.doc())).toEqual({ m: { a: 1, t: "hi", l: [1, { x: 2 }] } });
    p.history.redo();
    p.history.redo();
    p.history.redo();
    expect(json(p.doc())).toEqual({});
  });

  test("undoing the creation of an object deletes others' edits inside it", () => {
    const { alice, bob, sync } = peers<any>({});
    alice.change((d) => {
      d.o = { a: 1 };
    });
    sync();
    bob.change((d) => {
      d.o.b = 2;
    });
    sync();
    alice.history.undo();
    expect(json(alice.doc())).toEqual({});
  });
});

describe("lists", () => {
  test("insert, overwrite, delete", () => {
    const p = solo<{ l: number[] }>({ l: [1, 2, 3] });
    p.change((d) => {
      d.l.splice(1, 0, 9);
    });
    p.clock.advance(1000);
    p.change((d) => {
      d.l[0] = 7;
    });
    p.clock.advance(1000);
    p.change((d) => {
      d.l.splice(2, 1);
    });
    expect(p.doc().l).toEqual([7, 9, 3]);
    p.history.undo();
    expect(p.doc().l).toEqual([7, 9, 2, 3]);
    p.history.undo();
    expect(p.doc().l).toEqual([1, 9, 2, 3]);
    p.history.undo();
    expect(p.doc().l).toEqual([1, 2, 3]);
  });

  test("an overwritten-then-deleted element comes back with its old value", () => {
    const p = solo<{ l: number[] }>({ l: [1, 2] });
    p.change((d) => {
      d.l[0] = 5;
    });
    p.change((d) => {
      d.l.splice(0, 1);
    });
    p.history.undo();
    expect(p.doc().l).toEqual([1, 2]);
  });
});

describe("tldraw-shaped records", () => {
  type Store = { store: Record<string, any> };
  const shape = (id: string, x: number) => ({
    id,
    typeName: "shape",
    x,
    y: 0,
    props: {
      richText: { type: "doc", content: [{ type: "text", text: "" }] },
      label: "",
    },
  });

  test("create, move, edit text, delete; undo all; undo the run", () => {
    const p = solo<Store>({ store: {} });
    const states: unknown[] = [json(p.doc())];
    const step = (fn: (d: Store) => void) => {
      p.clock.advance(1000);
      p.change(fn);
      states.push(json(p.doc()));
    };
    step((d) => {
      d.store["shape:a"] = shape("shape:a", 0);
    });
    step((d) => {
      d.store["shape:a"].x = 10;
      d.store["shape:a"].y = 5;
    });
    step((d) =>
      A.splice(d, ["store", "shape:a", "props", "label"], 0, 0, "hi")
    );
    step((d) => {
      d.store["shape:a"].props.richText.content[0].text = "rich";
    });
    step((d) => {
      delete d.store["shape:a"];
    });
    for (let i = states.length - 2; i >= 0; i--) {
      p.history.undo();
      expect(json(p.doc())).toEqual(states[i]);
    }
    p.clock.advance(1000);
    step((d) => {
      d.store["shape:b"] = shape("shape:b", 1);
    });
    // undo shape:b, then the run (which brings back the deleted shape)
    p.history.undo();
    p.history.undo();
    expect(json(p.doc())).toEqual(states[states.length - 3]);
  });

  test("a presence record tldraw re-creates is ignored", () => {
    const p = solo<Store>(
      { store: {} },
      {
        ignore: (path) =>
          path[0] === "store" && String(path[1]).startsWith("user:"),
      }
    );
    p.change((d) => {
      d.store["shape:a"] = shape("shape:a", 0);
    });
    p.clock.advance(1000);
    p.change((d) => {
      d.store["shape:a"].x = 1;
    });
    p.history.undo();
    // tldraw re-creates its user record after every store change
    p.change((d) => {
      d.store["user:me"] = { id: "user:me" };
    });
    p.history.undo();
    expect(Object.keys(p.doc().store)).toEqual(["user:me"]);
    p.history.redo();
    p.history.redo();
    expect(p.doc().store["shape:a"].x).toBe(1);
  });
});

describe("ignored paths", () => {
  test("@-keys neither form steps nor end a run, and are left alone", () => {
    const p = solo<any>({ t: "" });
    type(p, ["t"], "a");
    p.clock.advance(1000);
    type(p, ["t"], "b");
    p.history.undo();
    p.change((d) => {
      d["@patchwork"] = { title: "x" };
    });
    expect(p.history.canRedo).toBe(true);
    p.history.undo();
    expect(json(p.doc())).toEqual({ t: "", "@patchwork": { title: "x" } });
    p.history.redo();
    p.history.redo();
    expect(json(p.doc())).toEqual({ t: "ab", "@patchwork": { title: "x" } });
  });

  test("a step mixing ignored and other paths leaves the ignored ones", () => {
    const p = solo<any>({ t: "" });
    p.change((d) => {
      d.k = 1;
      d["@comments"] = { c: 1 };
    });
    p.history.undo();
    expect(json(p.doc())).toEqual({ t: "", "@comments": { c: 1 } });
  });
});

describe("formatting", () => {
  type T = { t: string };
  const marks = (p: Peer<T>) =>
    A.marks(p.doc(), ["t"]).map(({ name, value, start, end }) => [
      name,
      value,
      start,
      end,
    ]);
  const step = (p: Peer<T>, fn: (d: T) => void) => {
    p.clock.advance(1000);
    p.change(fn);
  };

  test("a format set is removed, and comes back on redo", () => {
    const p = solo<T>({ t: "hello world" });
    step(p, (d) =>
      A.mark(d, ["t"], { start: 0, end: 5, expand: "both" }, "bold", true)
    );
    expect(p.history.undo().applied).toBe(true);
    expect(marks(p)).toEqual([]);
    p.history.redo();
    expect(marks(p)).toEqual([["bold", true, 0, 5]]);
  });

  test("a format removed comes back", () => {
    const p = solo<T>({ t: "hello world" });
    step(p, (d) =>
      A.mark(d, ["t"], { start: 0, end: 5, expand: "both" }, "bold", true)
    );
    step(p, (d) =>
      A.unmark(d, ["t"], { start: 1, end: 3, expand: "both" }, "bold")
    );
    expect(marks(p)).toEqual([
      ["bold", true, 0, 1],
      ["bold", true, 3, 5],
    ]);
    p.history.undo();
    expect(marks(p)).toEqual([["bold", true, 0, 5]]);
  });

  test("only what the step changed: earlier formatting in the range stays", () => {
    const p = solo<T>({ t: "hello world" });
    step(p, (d) =>
      A.mark(d, ["t"], { start: 0, end: 5, expand: "both" }, "bold", true)
    );
    step(p, (d) =>
      A.mark(d, ["t"], { start: 0, end: 11, expand: "both" }, "bold", true)
    );
    p.history.undo();
    expect(marks(p)).toEqual([["bold", true, 0, 5]]);
  });

  test("a format's value is restored", () => {
    const p = solo<T>({ t: "a link" });
    step(p, (d) =>
      A.mark(
        d,
        ["t"],
        { start: 2, end: 6, expand: "none" },
        "link",
        "https://a"
      )
    );
    step(p, (d) =>
      A.mark(
        d,
        ["t"],
        { start: 2, end: 6, expand: "none" },
        "link",
        "https://b"
      )
    );
    p.history.undo();
    expect(marks(p)).toEqual([["link", "https://a", 2, 6]]);
  });

  test("formatted text typed in one step just goes", () => {
    const p = solo<T>({ t: "ab" });
    step(p, (d) => {
      A.splice(d, ["t"], 1, 0, "XY");
      A.mark(d, ["t"], { start: 1, end: 3, expand: "both" }, "bold", true);
    });
    p.history.undo();
    expect(p.doc().t).toBe("ab");
    expect(marks(p)).toEqual([]);
  });

  test("formatting someone else changed since is a conflict", () => {
    const { alice, bob, sync } = peers<T>({ t: "hello world" });
    step(alice, (d) =>
      A.mark(d, ["t"], { start: 0, end: 11, expand: "both" }, "bold", true)
    );
    sync();
    step(bob, (d) =>
      A.unmark(d, ["t"], { start: 0, end: 5, expand: "both" }, "bold")
    );
    sync();
    const result = alice.history.undo();
    expect(result.skipped).toEqual([{ path: ["t"], reason: "conflict" }]);
    expect(marks(alice)).toEqual([["bold", true, 5, 11]]);
    alice.history.redo();
    alice.history.undo({ conflict: "force" });
    expect(marks(alice)).toEqual([]);
  });

  test("an undo run over formatting becomes a step", () => {
    const p = solo<T>({ t: "hello" });
    step(p, (d) =>
      A.mark(d, ["t"], { start: 0, end: 5, expand: "both" }, "bold", true)
    );
    step(p, (d) =>
      A.mark(d, ["t"], { start: 0, end: 5, expand: "both" }, "italic", true)
    );
    p.history.undo();
    p.history.undo();
    step(p, (d) => A.splice(d, ["t"], 5, 0, "!"));
    expect(marks(p)).toEqual([]);
    p.history.undo();
    p.history.undo();
    expect(marks(p)).toEqual([
      ["bold", true, 0, 5],
      ["italic", true, 0, 5],
    ]);
  });
});
