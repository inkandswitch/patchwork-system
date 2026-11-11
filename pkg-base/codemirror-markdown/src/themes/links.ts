import { EditorView } from "@codemirror/view";

export const linkTheme = EditorView.baseTheme({
  ".cm-link": {
    textDecoration: "underline",
    cursor: "var(--studio-cursor-pointer, pointer)",
    fontFamily: '"Merriweather Sans", sans-serif',
    color: "var(--syntax-link, #0066cc)",
    "&:hover": {
      color: "inherit",
    },
  },
});
