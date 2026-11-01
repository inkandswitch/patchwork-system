// Rebuilding a history from the changes a previous load made: every load
// gets a new actor, and the Repo gives each the same Automerge author.
// (`A.load`'s own `author` option is dropped, so the Repo sets it.)
import { afterEach, describe, expect, it } from "vitest";
import * as A from "@automerge/automerge";
import { type DocHandle, Repo } from "@automerge/automerge-repo";

import { UndoHistory, type UndoHistoryOptions } from "../src/history.js";

const ME = "ab".repeat(32);
const THEM = "cd".repeat(32);

type Doc = { n: number; text: string; "@patchwork"?: { type: string } };

const repos = new Map<string, Repo>();
const histories: UndoHistory[] = [];
afterEach(() => histories.splice(0).forEach((history) => history.dispose()));

/** `doc` with a new actor, as a reload gets. */
const reload = (doc: A.Doc<Doc>) => A.load<Doc>(A.save(doc));

/** A load of the document in a Repo of `author`, with its own history. */
function session(
  doc: A.Doc<Doc>,
  options: UndoHistoryOptions = {},
  author = ME
) {
  let repo = repos.get(author);
  if (!repo) repos.set(author, (repo = new Repo({ author })));
  const handle = repo.create<Doc>();
  handle.update(() => doc);
  let ms = 0;
  const history = new UndoHistory(handle as DocHandle<unknown>, {
    now: () => ms,
    ...options,
  });
  histories.push(history);
  return {
    handle,
    history,
    doc: () => handle.doc(),
    /** A change at `time` seconds, a step of its own while live. */
    change(fn: A.ChangeFn<Doc>, time: number) {
      handle.change(fn, { time });
      ms += 1_000;
    },
  };
}

/** Someone else's document, made by an actor that isn't anyone's load. */
const base = () => A.from<Doc>({ n: 0, text: "" });

const state = (s: { doc: () => A.Doc<Doc> }) => ({
  n: s.doc().n,
  text: s.doc().text,
});

describe("restoring a history", () => {
  it("rebuilds the steps of a previous load with the same author", () => {
    const one = session(reload(base()));
    one.change((d) => void (d.n = 1), 100);
    one.change((d) => A.splice(d, ["text"], 0, 0, "hi"), 110);
    one.change((d) => void (d.n = 2), 120);

    const two = session(reload(one.doc()));
    expect(two.history.size).toBe(3);
    expect(two.history.canUndo).toBe(true);

    two.history.undo();
    expect(state(two)).toEqual({ n: 1, text: "hi" });
    two.history.undo();
    expect(state(two)).toEqual({ n: 1, text: "" });
    two.history.undo();
    expect(state(two)).toEqual({ n: 0, text: "" });
    expect(two.history.canUndo).toBe(false);

    two.history.redo();
    two.history.redo();
    two.history.redo();
    expect(state(two)).toEqual({ n: 2, text: "hi" });
  });

  it("leaves another author's changes alone", () => {
    const one = session(reload(base()));
    one.change((d) => void (d.n = 1), 100);
    const theirs = session(reload(one.doc()), {}, THEM);
    theirs.change((d) => A.splice(d, ["text"], 0, 0, "theirs"), 110);

    const two = session(reload(theirs.doc()));
    expect(two.history.size).toBe(1);
    two.history.undo();
    expect(state(two)).toEqual({ n: 0, text: "theirs" });
  });

  it("rebuilds the steps the history's own actor made before it existed", () => {
    const one = session(reload(base()));
    one.change((d) => void (d.n = 1), 100);
    one.history.dispose();

    const again = new UndoHistory(one.handle as DocHandle<unknown>);
    histories.push(again);
    again.undo();
    expect(state(one)).toEqual({ n: 0, text: "" });
  });

  it("joins one actor's changes at most a second apart into a step", () => {
    const one = session(reload(base()));
    one.change((d) => A.splice(d, ["text"], 0, 0, "a"), 100);
    one.change((d) => A.splice(d, ["text"], 1, 0, "b"), 101);
    one.change((d) => A.splice(d, ["text"], 2, 0, "c"), 103);

    const two = session(reload(one.doc()));
    expect(two.history.size).toBe(2);
    two.history.undo();
    expect(two.doc().text).toBe("ab");
    two.history.undo();
    expect(two.doc().text).toBe("");
  });

  it("keeps a previous load's undo run in one step", () => {
    const one = session(reload(base()));
    one.change((d) => void (d.n = 1), 100);
    one.change((d) => void (d.n = 2), 110);
    one.change((d) => void (d.n = 3), 120);
    one.history.undo();
    one.history.undo();
    one.change((d) => A.splice(d, ["text"], 0, 0, "x"), 130);
    expect(state(one)).toEqual({ n: 1, text: "x" });

    const two = session(reload(one.doc()));
    expect(two.history.size).toBe(one.history.size);
    two.history.undo();
    expect(state(two)).toEqual({ n: 1, text: "" });
    // The run undid two steps; undoing it redoes both at once.
    two.history.undo();
    expect(state(two)).toEqual({ n: 3, text: "" });
    two.history.undo();
    expect(state(two)).toEqual({ n: 2, text: "" });
  });

  it("rebuilds older steps once undo reaches them", () => {
    const one = session(reload(base()));
    for (let i = 1; i <= 25; i++) one.change((d) => void (d.n = i), 100 * i);

    const two = session(reload(one.doc()), { restore: 10 });
    expect(two.history.size).toBe(10);
    for (let i = 24; i >= 0; i--) {
      expect(two.history.undo().applied).toBe(true);
      expect(two.doc().n).toBe(i);
    }
    expect(two.history.size).toBe(25);
    expect(two.history.canUndo).toBe(false);

    for (let i = 1; i <= 25; i++) two.history.redo();
    expect(two.doc().n).toBe(25);
  });

  it("doesn't rebuild the changes that created the document", () => {
    // As `patchwork.create`: an empty first change, then the datatype's.
    const one = session(A.init<Doc>());
    one.handle.update((d) => A.emptyChange(d));
    one.change((d) => {
      d["@patchwork"] = { type: "counter" };
      d.n = 0;
      d.text = "init";
    }, 50);

    const two = session(reload(one.doc()));
    expect(two.history.size).toBe(0);
    expect(two.history.canUndo).toBe(false);
  });

  it("rebuilds nothing with restore: 0", () => {
    const one = session(reload(base()));
    one.change((d) => void (d.n = 1), 100);

    const two = session(reload(one.doc()), { restore: 0 });
    expect(two.history.size).toBe(0);
  });
});
