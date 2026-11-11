/** CodeMirror Extensions */
import { completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { foldKeymap, indentOnInput, indentUnit } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { searchKeymap } from "@codemirror/search";
import { EditorView, keymap } from "@codemirror/view";

import { markdownFormattingKeymap } from "./formatting.ts";

/** Styles */
import { theme } from "../themes/markdown.ts";

// Undo/redo (`history()`/`historyKeymap`) is deliberately absent: the base
// editor (codemirror-base) owns it, so it can reset the stack when a scope
// swap re-points the doc handle (see codemirror-base's history extension).
// Adding a second `history()` here would keep the underlying singleton state
// field alive across that reset and break it.
export function markdownExtensions() {
  return [
    ...theme("sans"),
    indentOnInput(),
    keymap.of([
      ...markdownFormattingKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    EditorView.lineWrapping,
    markdown({ codeLanguages: languages }),
    indentUnit.of("    "),
  ];
}
