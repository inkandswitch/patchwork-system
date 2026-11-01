import * as A from "@automerge/automerge";
import {
  EditorSelection,
  EditorState,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { history, redo, undo } from "@codemirror/commands";
import { describe, expect, test } from "vitest";

import { undoBoundaries } from "../src/codemirror.js";
import { UndoHistory } from "../src/history.js";
import { peers } from "./peers.js";

/**
 * The same scripted transactions, with the same `Transaction.time`, go into
 * an EditorState with CodeMirror's `history()` and into one mirrored into
 * an Automerge document (as automerge-codemirror does) with the service.
 * After every undo and redo, the texts must be equal.
 */
class Session {
  time = 0;
  cm: EditorState;
  mirror: EditorState;
  readonly peer;
  readonly history: UndoHistory;

  constructor(doc = "") {
    this.peer = peers({ t: doc }).alice;
    this.history = new UndoHistory(this.peer.handle as never, {
      now: () => this.time,
    });
    this.peer.history.dispose();
    this.cm = EditorState.create({
      doc,
      extensions: [history(), EditorState.allowMultipleSelections.of(true)],
    });
    this.mirror = EditorState.create({
      doc,
      extensions: [
        undoBoundaries(this.history),
        EditorState.allowMultipleSelections.of(true),
      ],
    });
  }

  get text() {
    return this.peer.doc().t;
  }

  /** A user transaction, `dt` ms after the previous one. */
  user(spec: TransactionSpec, userEvent: string, dt = 100) {
    this.time += dt;
    const full = {
      ...spec,
      userEvent,
      annotations: Transaction.time.of(this.time),
    };
    this.cm = this.cm.update(full).state;
    const tr = this.mirror.update(full);
    this.mirror = tr.state;
    if (!tr.docChanged) return;
    // Write the change to the document as automerge-codemirror does: in
    // the old document's coordinates, back to front.
    const changes: Array<[number, number, string]> = [];
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      changes.push([fromA, toA, inserted.toString()]);
    });
    this.peer.handle.change((d) => {
      for (const [from, to, insert] of changes.reverse()) {
        A.splice(d, ["t"], from, to - from, insert);
      }
    });
  }

  type(text: string, at: number, dt = 100) {
    for (const [i, ch] of [...text].entries()) {
      this.user(
        {
          changes: { from: at + i, insert: ch },
          selection: EditorSelection.cursor(at + i + 1),
        },
        "input.type",
        i === 0 ? dt : 100
      );
    }
  }

  /** Pull the document back into the mirror after an undo or redo. */
  #pull() {
    this.mirror = this.mirror.update({
      changes: { from: 0, to: this.mirror.doc.length, insert: this.text },
      annotations: Transaction.addToHistory.of(false),
    }).state;
  }

  undo() {
    const did = undo({
      state: this.cm,
      dispatch: (tr) => (this.cm = tr.state),
    });
    this.history.undo();
    this.#pull();
    return did;
  }

  redo() {
    const did = redo({
      state: this.cm,
      dispatch: (tr) => (this.cm = tr.state),
    });
    this.history.redo();
    this.#pull();
    return did;
  }

  /** Undo everything, redo everything, undo again: equal after each press. */
  compare() {
    const expectEqual = (label: string) =>
      expect(this.text, label).toBe(this.cm.doc.toString());
    expectEqual("before undo");
    let presses = 0;
    while (this.undo()) expectEqual(`after undo ${++presses}`);
    expectEqual("after the last undo");
    expect(this.history.canUndo).toBe(false);
    presses = 0;
    while (this.redo()) expectEqual(`after redo ${++presses}`);
    expectEqual("after the last redo");
    while (this.undo()) expectEqual(`after undo ${++presses}`);
  }
}

describe("compared with CodeMirror's history", () => {
  test("typing with a pause", () => {
    const s = new Session();
    s.type("hello", 0);
    s.type(" world", 5, 1000);
    s.compare();
  });

  test("slow continuous typing", () => {
    const s = new Session();
    for (const [i, ch] of [..."abcdef"].entries()) s.type(ch, i, 400);
    s.compare();
  });

  test("typing at two places", () => {
    const s = new Session("0123456789");
    s.type("abc", 10);
    s.type("XY", 0);
    s.type("Z", 2);
    s.compare();
  });

  test("backspace then typing", () => {
    const s = new Session("hello world");
    for (let i = 11; i > 6; i--) {
      s.user({ changes: { from: i - 1, to: i } }, "delete.backward");
    }
    s.type("there", 6);
    s.compare();
  });

  test("a paste between typing", () => {
    const s = new Session();
    s.type("ab", 0);
    s.user({ changes: { from: 2, insert: "PASTE" } }, "input.paste");
    s.type("cd", 7);
    s.compare();
  });

  test("replacing a selection", () => {
    const s = new Session("hello world");
    s.user({ selection: EditorSelection.range(0, 5) }, "select.pointer");
    s.user(
      {
        changes: { from: 0, to: 5, insert: "J" },
        selection: EditorSelection.cursor(1),
      },
      "input.type"
    );
    s.type("ello", 1);
    s.compare();
  });

  test("two cursors", () => {
    const s = new Session("a\nb");
    s.user(
      {
        changes: [
          { from: 1, insert: "x" },
          { from: 3, insert: "x" },
        ],
      },
      "input.type"
    );
    s.user(
      {
        changes: [
          { from: 2, insert: "y" },
          { from: 5, insert: "y" },
        ],
      },
      "input.type"
    );
    s.compare();
  });

  test("a click", () => {
    const s = new Session();
    s.type("abc", 0);
    s.user({ selection: EditorSelection.cursor(0) }, "select.pointer");
    s.type("X", 0);
    s.compare();
  });

  test("the intended difference: an edit after undos keeps them reachable", () => {
    const s = new Session();
    s.type("a", 0);
    s.type("b", 1, 1000);
    s.type("c", 2, 1000);
    s.undo();
    s.undo();
    expect(s.text).toBe("a");
    s.type("X", 1, 1000);
    s.undo();
    expect(s.text).toBe("a");
    expect(s.cm.doc.toString()).toBe("a");
    s.undo();
    // CodeMirror lost b and c; the service brings them back.
    expect(s.cm.doc.toString()).toBe("");
    expect(s.text).toBe("abc");
  });
});
