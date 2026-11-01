// @vitest-environment happy-dom
import { Repo, type DocHandle } from "@automerge/automerge-repo";
import * as A from "@automerge/automerge";
import {
  basicSchemaAdapter,
  init,
  pmDocFromSpans,
} from "@automerge/prosemirror";
import { closeHistory, history, redo, undo } from "prosemirror-history";
import type { Node } from "prosemirror-model";
import {
  EditorState,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { afterEach, describe, expect, test } from "vitest";

import { UndoHistory } from "../src/history.js";
import { undoBoundaries } from "../src/prosemirror.js";
import { undoFor } from "../src/realm.js";

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = "";
});

const text = (doc: Node) => doc.textBetween(0, doc.content.size, "\n");

/** The text with its formatting: each run of text with its marks' names. */
const formatted = (doc: Node) => {
  const out: string[] = [];
  doc.descendants((node) => {
    if (node.isBlock && out.length) out.push("\n");
    if (node.isText) {
      const names = node.marks.map((m) => m.type.name).sort();
      out.push(names.length ? `[${names.join(",")}:${node.text}]` : node.text!);
    }
  });
  return out.join("");
};

/**
 * The same scripted transactions, at the same times, go into a ProseMirror
 * state with `prosemirror-history` and into an editor synced to an
 * Automerge document by @automerge/prosemirror, with the service and
 * `undoBoundaries`. After every undo and redo, the texts must be equal.
 */
// The binding's bug, shown with a collaborator and no undo at all.
test("@automerge/prosemirror 0.2.0 drifts on a remote deletion across blocks", () => {
  const a = new Repo().create({ text: "" });
  const b = new Repo().create<{ text: string }>();
  b.update(() => A.load(A.save(a.doc())));
  const view = (handle: DocHandle<{ text: string }>) => {
    const { schema, pmDoc, plugin } = init(handle as never, ["text"]);
    const el = document.createElement("div");
    document.body.append(el);
    const v = new EditorView(el, {
      state: EditorState.create({ schema, doc: pmDoc, plugins: [plugin] }),
    });
    views.push(v);
    return v;
  };
  const va = view(a);
  const vb = view(b);
  const edit = (f: (s: EditorState) => Transaction) => va.dispatch(f(va.state));
  const sync = () => b.update((doc) => A.merge(doc, a.doc()));
  for (const [i, ch] of [..."one"].entries())
    edit((s) => s.tr.insertText(ch, 1 + i));
  edit((s) => s.tr.split(4));
  for (const [i, ch] of [..."two"].entries())
    edit((s) => s.tr.insertText(ch, 6 + i));
  edit((s) => s.tr.split(9));
  for (const [i, ch] of [..."three"].entries())
    edit((s) => s.tr.insertText(ch, 11 + i));
  edit((s) => s.tr.join(5));
  sync();
  edit((s) => s.tr.delete(3, 11));
  sync();
  expect(text(va.state.doc)).toBe("onree");
  // Expected "onree" too; when this fails, the binding is fixed: remove
  // the workaround in Session.text and this test.
  expect(text(vb.state.doc)).toBe("onhree");
});

class Session {
  time = 1_000_000;
  pm: EditorState;
  readonly view: EditorView;
  readonly handle: DocHandle<{ text: string }>;
  readonly history: UndoHistory;

  constructor() {
    this.handle = new Repo().create({ text: "" });
    const { schema, pmDoc, plugin } = init(this.handle as never, ["text"]);
    this.history = new UndoHistory(this.handle as never, {
      now: () => this.time,
    });
    this.pm = EditorState.create({ schema, doc: pmDoc, plugins: [history()] });
    const parent = document.createElement("div");
    document.body.append(parent);
    this.view = new EditorView(parent, {
      state: EditorState.create({
        schema,
        doc: pmDoc,
        plugins: [plugin, undoBoundaries(this.history)],
      }),
    });
    views.push(this.view);
  }

  /**
   * The document's text as the binding reads it. Not the view's: the
   * binding (0.2.0) mistranslates a remote deletion that spans block
   * markers, a collaborator's as much as an undo's, so the view can drift
   * from the document.
   */
  get text() {
    const spans = A.spans(this.handle.doc() as A.Doc<unknown>, ["text"]);
    return formatted(pmDocFromSpans(basicSchemaAdapter, spans));
  }

  /** A user transaction built the same way on both, `dt` ms after the last. */
  user(build: (state: EditorState) => Transaction, dt = 100) {
    this.time += dt;
    this.pm = this.pm.apply(build(this.pm).setTime(this.time));
    this.view.dispatch(build(this.view.state).setTime(this.time));
  }

  type(chars: string, at: number, dt = 100) {
    [...chars].forEach((ch, i) =>
      this.user((s) => s.tr.insertText(ch, at + i), i === 0 ? dt : 100)
    );
  }

  #press(command: typeof undo, service: () => unknown) {
    const did = command(this.pm, (tr) => (this.pm = this.pm.apply(tr)));
    service();
    return did;
  }

  undo() {
    return this.#press(undo, () => this.history.undo());
  }

  redo() {
    return this.#press(redo, () => this.history.redo());
  }

  compare() {
    const equal = (label: string) =>
      expect(this.text, label).toBe(formatted(this.pm.doc));
    equal("before undo");
    let presses = 0;
    while (this.undo()) equal(`after undo ${++presses}`);
    expect(this.history.canUndo).toBe(false);
    while (this.redo()) equal(`after redo ${++presses}`);
    while (this.undo()) equal(`after undo ${++presses}`);
  }
}

describe("compared with prosemirror-history", () => {
  test("typing with a pause", () => {
    const s = new Session();
    s.type("hello", 1);
    s.type(" world", 6, 1000);
    s.compare();
  });

  test("slow continuous typing", () => {
    const s = new Session();
    for (const [i, ch] of [..."abcdef"].entries()) s.type(ch, 1 + i, 400);
    s.compare();
  });

  test("typing at two places", () => {
    const s = new Session();
    s.type("0123456789", 1);
    s.type("abc", 11, 1000);
    s.type("XY", 1);
    s.compare();
  });

  test("splitting paragraphs", () => {
    const s = new Session();
    s.type("first", 1);
    s.user((st) => st.tr.split(6));
    s.type("second", 8);
    s.user((st) => st.tr.split(14), 1000);
    s.type("third", 16);
    s.compare();
  });

  test("backspace then typing", () => {
    const s = new Session();
    s.type("hello world", 1);
    for (let i = 12; i > 7; i--) s.user((st) => st.tr.delete(i - 1, i), 100);
    s.type("there", 7);
    s.compare();
  });

  test("joining paragraphs and deleting across them", () => {
    const s = new Session();
    s.type("one", 1);
    s.user((st) => st.tr.split(4));
    s.type("two", 6);
    s.user((st) => st.tr.split(9));
    s.type("three", 11);
    // Backspace at the start of "two": the paragraphs join.
    s.user((st) => st.tr.join(5), 1000);
    // A deletion from inside "onetwo" into "three".
    s.user((st) => st.tr.delete(3, 11), 1000);
    s.type("X", 3, 1000);
    s.compare();
  });

  test("bold, then unbold part of it", () => {
    const s = new Session();
    s.type("hello world", 1);
    const bold = (st: EditorState) => st.schema.marks.strong!.create();
    s.user((st) => st.tr.addMark(1, 12, bold(st)), 1000);
    s.user((st) => st.tr.removeMark(3, 6, st.schema.marks.strong!), 1000);
    s.user((st) => st.tr.addMark(7, 12, st.schema.marks.em!.create()), 1000);
    s.compare();
  });

  test("typing inside formatted text", () => {
    const s = new Session();
    s.type("abc", 1);
    s.user((st) => st.tr.addMark(1, 4, st.schema.marks.strong!.create()), 1000);
    s.type("XY", 3, 1000);
    s.compare();
  });

  test("closeHistory ends a group", () => {
    const s = new Session();
    s.type("ab", 1);
    s.user((st) => closeHistory(st.tr.insertText("c", 3)));
    s.type("d", 4);
    s.compare();
  });

  test("replacing a selection", () => {
    const s = new Session();
    s.type("hello world", 1, 0);
    s.user(
      (st) =>
        st.tr
          .setSelection(TextSelection.create(st.doc, 1, 6))
          .replaceSelectionWith(st.schema.text("J")),
      1000
    );
    s.type("ello", 2);
    s.compare();
  });
});

describe("undoBoundaries", () => {
  test("marks the editor, so the key binding takes its keys", () => {
    const handle = new Repo().create({ text: "" });
    const { schema, pmDoc, plugin } = init(handle as never, ["text"]);
    const root = document.createElement("div");
    document.body.append(root);
    const binding = undoFor(root, handle, { groupDelayMs: 0 });
    const view = new EditorView(root, {
      state: EditorState.create({
        schema,
        doc: pmDoc,
        plugins: [plugin, undoBoundaries(binding)],
      }),
    });
    views.push(view);
    expect(view.dom.hasAttribute("data-patchwork-undo")).toBe(true);
    view.dispatch(view.state.tr.insertText("hi", 1));
    expect(handle.doc().text).toContain("hi");
    const event = new KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(text(view.state.doc)).toBe("");
    binding.dispose();
  });
});
