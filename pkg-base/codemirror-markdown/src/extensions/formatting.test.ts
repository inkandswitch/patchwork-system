import { describe, expect, it } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { toggleBold, toggleItalic } from "./formatting";

const run = (doc: string, from: number, to: number, cmd: typeof toggleBold) => {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.single(from, to),
  });
  cmd({
    state,
    dispatch: (tr) => {
      state = tr.state;
    },
  });
  const range = state.selection.main;
  return [state.doc.toString(), range.from, range.to] as const;
};

describe("toggleWrap", () => {
  it("wraps a selection", () => {
    expect(run("foo", 0, 3, toggleBold)).toEqual(["**foo**", 2, 5]);
  });

  it("unwraps when the marks surround the selection", () => {
    expect(run("**foo**", 2, 5, toggleBold)).toEqual(["foo", 0, 3]);
  });

  it("unwraps when the marks are inside the selection", () => {
    expect(run("**foo**", 0, 7, toggleBold)).toEqual(["foo", 0, 3]);
  });

  it("unwraps through a nested mark", () => {
    expect(run("**_foo_**", 3, 6, toggleBold)).toEqual(["_foo_", 1, 4]);
  });

  it("unwraps the outer mark from inside", () => {
    expect(run("_**foo**_", 3, 6, toggleItalic)).toEqual(["**foo**", 2, 5]);
  });

  it("unwraps a nested mark inside the selection", () => {
    expect(run("**_foo_**", 0, 9, toggleItalic)).toEqual(["**foo**", 0, 7]);
  });

  it("still wraps when a different mark is present", () => {
    expect(run("**foo**", 2, 5, toggleItalic)).toEqual(["**_foo_**", 3, 6]);
  });
});
