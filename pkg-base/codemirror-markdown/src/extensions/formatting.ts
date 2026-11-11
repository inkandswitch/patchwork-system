import type { StateCommand } from "@codemirror/state";
import { EditorSelection } from "@codemirror/state";
import type { KeyBinding } from "@codemirror/view";

const MARKS = ["**", "__", "~~", "*", "_", "`"];

const toggleWrap =
  (mark: string): StateCommand =>
  ({ state, dispatch }) => {
    const selection = state.changeByRange((range) => {
      let from = range.from;
      let to = range.to;
      for (;;) {
        const found = MARKS.find(
          (m) =>
            state.sliceDoc(from - m.length, from) === m &&
            state.sliceDoc(to, to + m.length) === m
        );
        if (!found) break;
        if (found === mark) {
          return {
            changes: [
              { from: from - mark.length, to: from },
              { from: to, to: to + mark.length },
            ],
            range: EditorSelection.range(
              range.from - mark.length,
              range.to - mark.length
            ),
          };
        }
        from -= found.length;
        to += found.length;
      }

      from = range.from;
      to = range.to;
      for (;;) {
        const found = MARKS.find(
          (m) =>
            to - from >= m.length * 2 &&
            state.sliceDoc(from, from + m.length) === m &&
            state.sliceDoc(to - m.length, to) === m
        );
        if (!found) break;
        if (found === mark) {
          return {
            changes: [
              { from, to: from + mark.length },
              { from: to - mark.length, to },
            ],
            range: EditorSelection.range(
              range.from,
              range.to - mark.length * 2
            ),
          };
        }
        from += found.length;
        to -= found.length;
      }

      return {
        changes: [
          { from: range.from, insert: mark },
          { from: range.to, insert: mark },
        ],
        range: EditorSelection.range(
          range.from + mark.length,
          range.to + mark.length
        ),
      };
    });

    dispatch(state.update(selection, { scrollIntoView: true, userEvent: "input" }));
    return true;
  };

export const toggleBold = toggleWrap("**");
export const toggleItalic = toggleWrap("_");
export const toggleStrikethrough = toggleWrap("~~");
export const toggleCode = toggleWrap("`");

export const markdownFormattingKeymap: KeyBinding[] = [
  { key: "Mod-b", run: toggleBold, preventDefault: true },
  { key: "Mod-i", run: toggleItalic, preventDefault: true },
  { key: "Mod-Shift-x", run: toggleStrikethrough, preventDefault: true },
  { key: "Mod-e", run: toggleCode, preventDefault: true },
];
